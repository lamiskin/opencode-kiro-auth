import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

let apiRequestLogCalls: any[] = []
let apiResponseLogCalls: any[] = []

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  getTimestamp: () => '2026-07-22T00-00-00-000Z',
  log: () => {},
  logApiError: (req: any, resp: any) => {
    apiRequestLogCalls.push(req)
    apiResponseLogCalls.push(resp)
  },
  logApiRequest: (req: any) => {
    apiRequestLogCalls.push(req)
  },
  logApiResponse: (resp: any) => {
    apiResponseLogCalls.push(resp)
  },
  logApiUsage: () => {},
  warn: () => {}
}))

const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async () => {
    return {
      output: {
        codeSnippet: 'test'
      }
    }
  }
)

const { RequestHandler } = await import('../core/request/request-handler.js')

afterAll(() => {
  clearSdkClientCache()
  sendSpy.mockRestore()
})

function createHarness() {
  clearSdkClientCache()
  apiRequestLogCalls = []
  apiResponseLogCalls = []

  const account: any = {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: Date.now() + 60_000,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 0
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
    enable_log_api_request: true
  }

  const handler: any = new RequestHandler(accountManager, config, repository, {
    notify: () => {},
    reauthorize: async () => {}
  })

  handler.accountSelector = {
    selectHealthyAccount: async () => account
  }
  handler.tokenRefresher = {
    refreshIfNeeded: async (selected: any) => ({ account: selected, shouldContinue: false })
  }
  handler.prepareSdkRequest = () => ({
    region: 'us-east-1',
    effort: undefined,
    conversationState: { currentMessage: { userInputMessage: {} } },
    profileArn: undefined,
    conversationId: 'conversation-1',
    streaming: false,
    effectiveModel: 'claude-sonnet-4-5',
    systemChars: 0
  })

  return { handler }
}

function request(handler: any, headers?: Record<string, string>) {
  return handler.handle('https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5', {
    headers: headers || {},
    body: '{}'
  })
}

describe('RequestHandler agent + sessionID logging', () => {
  test('logs with agent and sessionID headers when present', async () => {
    const { handler } = createHarness()
    const headers = {
      'x-kiro-agent': 'oracle',
      'x-kiro-session': 'ses-12345'
    }

    await request(handler, headers)

    expect(apiRequestLogCalls.length).toBeGreaterThan(0)
    const requestLog = apiRequestLogCalls[0]
    expect(requestLog.agent).toBe('oracle')
    expect(requestLog.sessionID).toBe('ses-12345')

    expect(apiResponseLogCalls.length).toBeGreaterThan(0)
    const responseLog = apiResponseLogCalls[0]
    expect(responseLog.agent).toBe('oracle')
    expect(responseLog.sessionID).toBe('ses-12345')
  })

  test('omits agent and sessionID keys when headers absent', async () => {
    const { handler } = createHarness()

    await request(handler, {})

    expect(apiRequestLogCalls.length).toBeGreaterThan(0)
    const requestLog = apiRequestLogCalls[0]
    expect(requestLog.agent).toBeUndefined()
    expect(requestLog.sessionID).toBeUndefined()

    expect(apiResponseLogCalls.length).toBeGreaterThan(0)
    const responseLog = apiResponseLogCalls[0]
    expect(responseLog.agent).toBeUndefined()
    expect(responseLog.sessionID).toBeUndefined()
  })
})
