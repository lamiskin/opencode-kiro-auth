import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

const sentTokens: string[] = []

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  getTimestamp: () => '2026-08-28T00:00:00.000Z',
  log: () => {},
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {},
  warn: () => {}
}))

const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async function (this: any) {
    const identity = await this.config.token()
    sentTokens.push(identity.token)
    return {}
  }
)

const { RequestHandler } = await import('../core/request/request-handler.js')

afterAll(() => {
  clearSdkClientCache()
  sendSpy.mockRestore()
})

test('sends the access token obtained by refreshIfNeeded, not the pre-refresh snapshot', async () => {
  clearSdkClientCache()

  const account: any = {
    id: 'account-1',
    email: 'user@corp.example',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'expired-access-token',
    expiresAt: Date.now() - 1000,
    isHealthy: true,
    failCount: 0
  }
  const accountManager: any = {
    getAccounts: () => [account],
    getAccountCount: () => 1,
    toAuthDetails: (selected: any) => ({
      access: selected.accessToken,
      refresh: selected.refreshToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
      email: selected.email
    })
  }
  const repository: any = {
    batchSave: async () => {},
    save: async () => {},
    invalidateCache: () => {},
    findAll: async () => [account]
  }
  const config: any = {
    max_request_iterations: 5,
    request_timeout_ms: 5_000,
    rate_limit_max_retries: 2,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: false
  }

  const handler: any = new RequestHandler(accountManager, config, repository)
  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    // Mirrors the real refresher: the account is updated in place.
    refreshIfNeeded: async (selected: any) => {
      selected.accessToken = 'refreshed-access-token'
      selected.expiresAt = Date.now() + 3600000
      return { account: selected, shouldContinue: false }
    },
    forceRefresh: async () => {}
  }
  handler.prepareSdkRequest = () => ({
    region: 'us-east-1',
    effort: undefined,
    conversationState: {},
    profileArn: undefined,
    conversationId: 'conversation-1',
    streaming: false,
    effectiveModel: 'claude-sonnet-4-5'
  })
  handler.responseHandler = { handleSdkSuccess: async () => new Response('ok') }
  handler.usageTracker = { syncUsage: () => {} }

  const response = await handler.handle(
    'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
    { body: '{}' },
    () => {}
  )

  expect(response.status).toBe(200)
  expect(sentTokens).toEqual(['refreshed-access-token'])
})
