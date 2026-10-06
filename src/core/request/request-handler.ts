import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isOpenAIModel } from '../../plugin/effort'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { refreshContextWindowSizes } from '../../plugin/models'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient } from '../../plugin/sdk-client'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'

import type { HostPort } from '../../host/port.js'

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0
  private static kiroRequestQueue: Promise<void> = Promise.resolve()

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository,
    private port?: HostPort
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager, repository)
    this.responseHandler = new ResponseHandler()
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  async handle(input: any, init: any): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url

    if (!KIRO_API_PATTERN.test(url)) {
      return fetch(input, init)
    }

    return this.enqueueKiroRequest(() => this.handleKiroRequest(url, init))
  }

  /**
   * Handles a request unconditionally as a Kiro request, skipping the
   * KIRO_API_PATTERN check. Used by the OpenCode v2 adapter's local loopback
   * proxy server (src/adapters/v2.ts), where every incoming request is
   * definitionally a Kiro request — the URL is our own local server, not the
   * real Kiro endpoint the pattern is written to recognize.
   */
  async handleForced(input: any, init: any): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url
    return this.enqueueKiroRequest(() => this.handleKiroRequest(url, init))
  }

  private async enqueueKiroRequest<T>(run: () => Promise<T>): Promise<T> {
    const previous = RequestHandler.kiroRequestQueue
    let release!: () => void

    RequestHandler.kiroRequestQueue = new Promise((resolve) => {
      release = resolve
    })

    await previous.catch(() => {})

    try {
      return await run()
    } finally {
      release()
    }
  }

  private async handleKiroRequest(url: string, init: any): Promise<Response> {
    const body = init?.body ? JSON.parse(init.body) : {}
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'
    const think =
      model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig || !!body.thinkingConfig
    const budget =
      body.providerOptions?.thinkingConfig?.thinkingBudget ||
      body.thinkingConfig?.thinkingBudget ||
      body.thinkingConfig?.budget_tokens ||
      20000

    let retry = 0
    let bearerRetried = false
    let consecutiveNullAccounts = 0
    const retryContext = this.retryStrategy.createContext()

    const notify = this.port?.notify ?? (() => {})

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) {
        throw new Error(check.error)
      }

      if (this.allAccountsPermanentlyUnhealthy()) {
        const reauthed = await this.triggerReauth()
        if (!reauthed) {
          throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
        }
        continue
      }

      let acc = await this.accountSelector.selectHealthyAccount(notify).catch(async (e) => {
        if (e instanceof Error && e.message.includes('reauth required')) {
          const reauthed = await this.triggerReauth()
          if (!reauthed)
            throw new Error('All accounts are unhealthy or rate-limited. Please re-authenticate.')
          return null
        }
        throw e
      })
      if (!acc) {
        consecutiveNullAccounts++
        const backoffDelay = Math.min(1000 * Math.pow(2, consecutiveNullAccounts - 1), 10000)
        await this.sleep(backoffDelay)
        continue
      }

      consecutiveNullAccounts = 0

      const tokenResult = await this.tokenRefresher.refreshIfNeeded(
        acc,
        this.accountManager.toAuthDetails(acc),
        notify
      )
      if (tokenResult.shouldContinue) {
        acc = tokenResult.account
        await this.sleep(500)
        continue
      }
      // Read the auth details after the refresh: refreshIfNeeded updates the
      // account in place, and a snapshot taken before it would send the old token.
      const auth = this.accountManager.toAuthDetails(acc)

      await refreshContextWindowSizes(auth)

      const sdkPrep = this.prepareSdkRequest(init?.body, model, auth, think, budget, notify)

      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logSdkRequest(sdkPrep, acc, apiTimestamp)
      }
      try {
        const client = createSdkClient(
          auth,
          sdkPrep.region,
          sdkPrep.effort,
          isOpenAIModel(sdkPrep.effectiveModel)
        )
        const command = new GenerateAssistantResponseCommand({
          conversationState: sdkPrep.conversationState as any,
          profileArn: sdkPrep.profileArn
        })

        const sdkResponse = await client.send(command)

        if (apiTimestamp) {
          this.logSdkResponse(sdkPrep, apiTimestamp)
        }

        this.handleSuccessfulRequest(acc)
        this.usageTracker.syncUsage(acc, auth)

        return await this.responseHandler.handleSdkSuccess(
          sdkResponse,
          model,
          sdkPrep.conversationId,
          sdkPrep.streaming,
          sdkPrep.toolNameMap,
          apiTimestamp
        )
      } catch (e: any) {
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus && apiTimestamp) {
          this.logSdkError(sdkPrep, e, acc, apiTimestamp)
        }

        if (httpStatus === 403 && !bearerRetried) {
          const msg = e?.message || ''
          if (
            msg.includes('bearer token included in the request is invalid') ||
            msg.includes('The bearer token included in the request is invalid')
          ) {
            bearerRetried = true
            logger.warn('403 bearer invalid on first attempt, forcing token refresh and retrying')
            await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            continue
          }
        }

        if (httpStatus) {
          const cappedMessage = String(e?.message || '').slice(0, 500)
          const mockResponse = new Response(
            JSON.stringify({ error: cappedMessage, status: httpStatus, statusText: e.name }),
            {
              status: httpStatus,
              statusText: e.name || 'Error',
              headers: { 'Content-Type': 'application/json' }
            }
          )

          const errorResult = await this.errorHandler.handle(
            e,
            mockResponse,
            acc,
            { retry, bearerRetried },
            notify
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
              bearerRetried = errorResult.newContext.bearerRetried ?? bearerRetried
            }
            if (errorResult.forceRefresh) {
              await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            }
            if (errorResult.switchAccount) {
              continue
            }
            continue
          }

          const rawMsg = e?.message || `Kiro Error: ${httpStatus}`
          const errMsg = `Kiro Error: ${httpStatus} - ${String(rawMsg).slice(0, 500)}`
          if (/input is too long/i.test(rawMsg)) {
            return new Response(
              JSON.stringify({
                error: {
                  message: 'input is too long for requested model',
                  type: 'invalid_request_error',
                  code: 'context_length_exceeded'
                }
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          }
          throw new Error(errMsg)
        }

        const networkResult = await this.errorHandler.handleNetworkError(e, { retry }, notify)

        if (networkResult.shouldRetry) {
          if (networkResult.newContext) {
            retry = networkResult.newContext.retry
          }
          continue
        }

        throw e
      }
    }
  }

  private extractModel(url: string): string | null {
    return url.match(/models\/([^/:]+)/)?.[1] || null
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void
  ): SdkPreparedRequest {
    return transformToSdkRequest(body, model, auth, think, budget, showToast, {
      effort: this.config.effort,
      autoEffortMapping: this.config.auto_effort_mapping
    })
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    if (acc.failCount && acc.failCount > 0) {
      if (!isPermanentError(acc.unhealthyReason)) {
        acc.failCount = 0
        acc.isHealthy = true
        delete acc.unhealthyReason
        delete acc.recoveryTime
        this.repository.save(acc).catch(() => {})
      }
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    // Mirrors what the sdk-client middleware injects, so logs reflect the wire body.
    const additionalModelRequestFields = prep.effort
      ? { output_config: { effort: prep.effort } }
      : undefined

    const conversationState = prep.conversationState
    const history = (conversationState as any).history || []
    const currentMessage = conversationState.currentMessage
    const userInputMessage = currentMessage?.userInputMessage
    const userInputMessageContext = userInputMessage?.userInputMessageContext || {}

    // ponytail: sizes for debugging input token composition
    const sizes = {
      history: JSON.stringify(history).length,
      historyMessages: history.length,
      currentContent: userInputMessage?.content?.length || 0,
      tools: userInputMessageContext.tools
        ? JSON.stringify(userInputMessageContext.tools).length
        : 0,
      toolResults: userInputMessageContext.toolResults
        ? JSON.stringify(userInputMessageContext.toolResults).length
        : 0,
      images: userInputMessage?.images ? JSON.stringify(userInputMessage.images).length : 0,
      // system: cannot be separated - injectSystemPrompt merges it into history[0].userInputMessage.content
      total: JSON.stringify(conversationState).length
    }

    logger.logApiRequest(
      {
        url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        sizes,
        body: {
          conversationState: {
            chatTriggerType: conversationState.chatTriggerType,
            conversationId: conversationState.conversationId,
            historyLength: history.length,
            currentMessage: currentMessage
          },
          profileArn: prep.profileArn,
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {})
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logSdkResponse(prep: SdkPreparedRequest, timestamp: string): void {
    logger.logApiResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logSdkError(
    prep: SdkPreparedRequest,
    error: any,
    acc: ManagedAccount,
    apiTimestamp: string
  ): void {
    const status = error?.$metadata?.httpStatusCode || 0
    const rData = {
      status,
      statusText: error?.name || 'Error',
      headers: {},
      error: `Kiro Error: ${status} - ${error?.message || 'Unknown'}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
          method: 'POST',
          headers: {},
          body: null,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    } else {
      logger.logApiResponse(rData, apiTimestamp)
    }
  }

  private async triggerReauth(): Promise<boolean> {
    if (!this.port) return false

    const notify = this.port.notify
    const cooldownRemaining = REAUTH_FAILURE_COOLDOWN_MS - (Date.now() - this.lastFailedReauthAt)
    if (cooldownRemaining > 0) {
      notify('Recent re-authentication failed. Please complete authentication manually.', 'error')
      return false
    }

    if (this.reauthInFlight) {
      return this.reauthInFlight
    }

    this.reauthInFlight = this.performReauth()
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
    })
    if (!success) this.lastFailedReauthAt = Date.now()
    return success
  }

  private async performReauth(): Promise<boolean> {
    if (!this.port) return false

    const notify = this.port.notify
    try {
      notify('Session expired. Re-authenticating...', 'warning')

      // Delegate re-authorization to the host via HostPort
      await this.port.reauthorize()

      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      for (const acc of accounts) {
        this.accountManager.addAccount(acc)
      }

      if (!this.hasUsableAccount(accounts)) {
        logger.warn('Re-auth completed but no usable Kiro account was found')
        notify('Re-authentication completed but no usable Kiro account was found.', 'error')
        return false
      }

      notify('Re-authentication successful.', 'success')
      return true
    } catch (e) {
      logger.error('Re-auth failed', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  }

  private hasUsableAccount(accounts: ManagedAccount[]): boolean {
    const now = Date.now()
    return accounts.some(
      (acc) => acc.isHealthy && acc.expiresAt > now && !isPermanentError(acc.unhealthyReason)
    )
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) {
      return false
    }
    return accounts.every((acc) => !acc.isHealthy && isPermanentError(acc.unhealthyReason))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
