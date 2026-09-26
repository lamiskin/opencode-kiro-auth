import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ManagedAccount } from '../plugin/types.js'

// Controllable refresh token mock
let refreshCalls: string[] = []
let refreshResults: Record<string, { access: string; refresh: string } | Error> = {}
let refreshDelayMs = 0

mock.module('../plugin/token.js', () => ({
  refreshAccessToken: async (auth: any) => {
    const refreshToken = auth.refresh.split('|')[0]
    refreshCalls.push(refreshToken)

    if (refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, refreshDelayMs))
    }

    const result = refreshResults[refreshToken]
    if (!result) throw new Error(`unexpected refresh token ${refreshToken}`)
    if (result instanceof Error) throw result

    return {
      refresh: `${result.refresh}|cid|csec|idc`,
      access: result.access,
      expires: Date.now() + 3600000,
      authMethod: 'idc',
      region: auth.region,
      oidcRegion: auth.oidcRegion,
      profileArn: auth.profileArn,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      email: auth.email
    }
  }
}))

mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (refresh: string) => {
    const [refreshToken, clientId, clientSecret] = refresh.split('|')
    return { refreshToken, clientId, clientSecret, authMethod: 'idc' }
  },
  encodeRefreshToken: (p: any) => `${p.refreshToken}|${p.clientId}|${p.clientSecret}|idc`,
  accessTokenExpired: (auth: any, bufferMs = 0) =>
    !auth.access || !auth.expires || Date.now() >= auth.expires - bufferMs
}))

mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => [],
    upsertAccount: async () => {},
    deleteAccount: async () => {},
    batchUpsertAccounts: async () => {}
  }
}))

mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: async () => {},
  writeToKiroCli: async () => {}
}))

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {}
}))

const { KiroTokenRefreshError } = await import('../plugin/errors.js')
const { AccountManager } = await import('../plugin/accounts.js')
const { TokenRefresher } = await import('../core/auth/token-refresher.js')

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'user@corp.example',
    authMethod: 'idc',
    region: 'us-east-1',
    oidcRegion: 'us-east-1',
    clientId: 'cid',
    clientSecret: 'csec',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: Date.now() - 1000, // Expired
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function createRefresher(account: ManagedAccount) {
  const manager = new AccountManager([account], 'sticky')
  const repository: any = {
    invalidateCache: () => {},
    findAll: async () => [],
    save: async () => {},
    batchSave: async () => {}
  }
  const config = {
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky' as const
  }
  return new TokenRefresher(config, manager, async () => {}, repository)
}

beforeEach(() => {
  refreshCalls = []
  refreshDelayMs = 0
  refreshResults = { 'refresh-token': { access: 'new-access', refresh: 'new-refresh' } }
})

describe('TokenRefresher lock mechanism', () => {
  test('concurrent refreshIfNeeded calls for same account only trigger one refresh', async () => {
    // Add a small delay to increase chance of concurrent execution
    refreshDelayMs = 10

    const account = makeAccount()
    const refresher = createRefresher(account)
    const auth = {
      refresh: 'refresh-token|cid|csec|idc',
      access: 'access-token',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user@corp.example'
    }

    // Start multiple concurrent refresh calls
    const results = await Promise.all([
      refresher.refreshIfNeeded(account, auth, () => {}),
      refresher.refreshIfNeeded(account, auth, () => {}),
      refresher.refreshIfNeeded(account, auth, () => {})
    ])

    // Only one actual refresh call should have been made
    expect(refreshCalls).toEqual(['refresh-token'])

    // All callers should get the same result
    results.forEach((result) => {
      expect(result.account.accessToken).toBe('new-access')
      expect(result.account.refreshToken).toBe('new-refresh')
      expect(result.shouldContinue).toBe(false)
    })
  })

  test('refreshIfNeeded and forceRefresh for same account serialize', async () => {
    refreshDelayMs = 10
    const account = makeAccount()
    const refresher = createRefresher(account)
    const auth = {
      refresh: 'refresh-token|cid|csec|idc',
      access: 'access-token',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user@corp.example'
    }

    const [refreshResult, forceRefreshResult] = await Promise.all([
      refresher.refreshIfNeeded(account, auth, () => {}),
      refresher.forceRefresh(account, auth)
    ])

    // Should only have one refresh call total
    expect(refreshCalls.length).toBe(1)
    expect(refreshCalls[0]).toBe('refresh-token')

    // Both operations should complete without errors
    expect(refreshResult.shouldContinue).toBe(false)
    expect(refreshResult.account.accessToken).toBe('new-access')
  })

  test('refreshIfNeeded joining forceRefresh gets correct shape (bug fix)', async () => {
    // This is the bug: when forceRefresh is in flight and refreshIfNeeded joins it,
    // refreshIfNeeded should get {account, shouldContinue} not void/undefined
    refreshDelayMs = 20
    const account = makeAccount()
    const refresher = createRefresher(account)
    const auth = {
      refresh: 'refresh-token|cid|csec|idc',
      access: 'access-token',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user@corp.example'
    }

    // Start forceRefresh first, then immediately start refreshIfNeeded
    const forceRefreshPromise = refresher.forceRefresh(account, auth)
    // Small delay to ensure forceRefresh is in flight
    await new Promise((resolve) => setTimeout(resolve, 5))
    const refreshIfNeededResult = await refresher.refreshIfNeeded(account, auth, () => {})

    // Wait for forceRefresh to complete
    await forceRefreshPromise

    // refreshIfNeeded should have joined and gotten the correct shape
    expect(refreshIfNeededResult).not.toBeUndefined()
    expect(refreshIfNeededResult.shouldContinue).toBe(false)
    expect(refreshIfNeededResult.account).toBeDefined()
    expect(refreshIfNeededResult.account.accessToken).toBe('new-access')
  })

  test('concurrent calls for different accounts proceed independently', async () => {
    refreshDelayMs = 10

    const account1 = makeAccount({ id: 'acc-1', refreshToken: 'refresh-1' })
    const account2 = makeAccount({ id: 'acc-2', refreshToken: 'refresh-2' })

    const refresher1 = createRefresher(account1)
    const refresher2 = createRefresher(account2)

    refreshResults = {
      'refresh-1': { access: 'new-access-1', refresh: 'new-refresh-1' },
      'refresh-2': { access: 'new-access-2', refresh: 'new-refresh-2' }
    }

    const auth1 = {
      refresh: 'refresh-1|cid|csec|idc',
      access: 'access-token-1',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user1@corp.example'
    }

    const auth2 = {
      refresh: 'refresh-2|cid|csec|idc',
      access: 'access-token-2',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user2@corp.example'
    }

    const [result1, result2] = await Promise.all([
      refresher1.refreshIfNeeded(account1, auth1, () => {}),
      refresher2.refreshIfNeeded(account2, auth2, () => {})
    ])

    // Should have two refresh calls, one for each account
    expect(refreshCalls.sort()).toEqual(['refresh-1', 'refresh-2'])

    // Each account should get its own refreshed token
    expect(result1.account.accessToken).toBe('new-access-1')
    expect(result2.account.accessToken).toBe('new-access-2')
  })

  test('lock is cleaned up after refresh completes', async () => {
    const account = makeAccount()
    const refresher = createRefresher(account)
    const auth = {
      refresh: 'refresh-token|cid|csec|idc',
      access: 'access-token',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user@corp.example'
    }

    // First call should succeed
    const result1 = await refresher.refreshIfNeeded(account, auth, () => {})
    expect(refreshCalls).toEqual(['refresh-token'])

    // Clear the mock results to simulate a different refresh token on next call
    refreshCalls = []
    refreshResults = { 'refresh-token': { access: 'new-access-2', refresh: 'new-refresh-2' } }

    // Second call after some time should trigger a new refresh
    const result2 = await refresher.refreshIfNeeded(account, auth, () => {})

    // Should have made another refresh call
    expect(refreshCalls).toEqual(['refresh-token'])
    expect(result2.account.accessToken).toBe('new-access-2')
  })

  test('lock is cleaned up after refresh fails', async () => {
    // Make the first refresh fail
    refreshResults = { 'refresh-token': new Error('Invalid grant') }

    const account = makeAccount()
    const refresher = createRefresher(account)
    const auth = {
      refresh: 'refresh-token|cid|csec|idc',
      access: 'access-token',
      expires: Date.now() - 1000,
      authMethod: 'idc' as const,
      region: 'us-east-1' as const,
      oidcRegion: 'us-east-1' as const,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
      clientId: 'cid',
      clientSecret: 'csec',
      email: 'user@corp.example'
    }

    // First call should fail
    try {
      await refresher.refreshIfNeeded(account, auth, () => {})
    } catch (e) {
      // Expected
    }
    expect(refreshCalls).toEqual(['refresh-token'])

    // Clear the mock and try again
    refreshCalls = []
    refreshResults = { 'refresh-token': new Error('Invalid grant') }

    // This should trigger a new refresh (lock was cleaned up)
    try {
      await refresher.refreshIfNeeded(account, auth, () => {})
    } catch (e) {
      // Expected
    }

    // Should have made another refresh call
    expect(refreshCalls).toEqual(['refresh-token'])
  })
})
