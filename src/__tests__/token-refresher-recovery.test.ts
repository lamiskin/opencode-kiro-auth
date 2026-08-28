import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ManagedAccount } from '../plugin/types.js'

// Controllable stand-in for the OIDC refresh call.
let refreshCalls: string[] = []
let refreshSecrets: string[] = []
let refreshResults: Record<string, { access: string; refresh: string } | Error> = {}

mock.module('../plugin/token.js', () => ({
  refreshAccessToken: async (auth: any) => {
    const refreshToken = auth.refresh.split('|')[0]
    refreshCalls.push(refreshToken)
    refreshSecrets.push(auth.clientSecret)
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

const invalidGrant = () =>
  new KiroTokenRefreshError('Refresh failed: Invalid refresh token provided', 'invalid_grant')

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
    refreshToken: 'stale-refresh',
    accessToken: 'stale-access',
    expiresAt: Date.now() - 1000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function harness(syncedRow: ManagedAccount | undefined) {
  const account = makeAccount()
  const manager = new AccountManager([account], 'sticky')
  const saved: ManagedAccount[] = []
  const batchSaved: ManagedAccount[][] = []
  const repository: any = {
    invalidateCache: () => {},
    findAll: async () => (syncedRow ? [{ ...syncedRow }] : []),
    save: async (a: ManagedAccount) => {
      saved.push({ ...a })
    },
    batchSave: async (accounts: ManagedAccount[]) => {
      batchSaved.push(accounts.map((a) => ({ ...a })))
    }
  }
  const config = {
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: true,
    account_selection_strategy: 'sticky' as const
  }
  const refresher = new TokenRefresher(config, manager, async () => {}, repository)
  const toasts: string[] = []
  const run = () =>
    refresher.refreshIfNeeded(account, manager.toAuthDetails(account), (m) => {
      toasts.push(m)
    })
  return { account, manager, run, saved, batchSaved, toasts }
}

beforeEach(() => {
  refreshCalls = []
  refreshSecrets = []
  refreshResults = { 'stale-refresh': invalidGrant() }
})

describe('TokenRefresher recovery after a failed refresh', () => {
  test('adopts a live token that kiro-cli rotated behind our back', async () => {
    const { account, run, toasts } = harness(
      makeAccount({
        refreshToken: 'cli-refresh',
        accessToken: 'cli-access',
        expiresAt: Date.now() + 3600000,
        oidcRegion: 'sa-east-1'
      })
    )

    const result = await run()

    expect(result.shouldContinue).toBe(true)
    expect(refreshCalls).toEqual(['stale-refresh'])
    expect(account.accessToken).toBe('cli-access')
    expect(account.refreshToken).toBe('cli-refresh')
    expect(account.oidcRegion).toBe('sa-east-1')
    expect(account.isHealthy).toBe(true)
    expect(toasts).toEqual(['Credentials recovered from Kiro CLI sync.'])
  })

  test('retries the refresh with the synced refresh token when its access token is expired', async () => {
    refreshResults['cli-refresh'] = { access: 'fresh-access', refresh: 'fresh-refresh' }
    const { account, run, saved } = harness(
      makeAccount({
        refreshToken: 'cli-refresh',
        accessToken: 'cli-access',
        expiresAt: Date.now() - 1000
      })
    )

    const result = await run()

    expect(result.shouldContinue).toBe(true)
    expect(refreshCalls).toEqual(['stale-refresh', 'cli-refresh'])
    expect(account.accessToken).toBe('fresh-access')
    expect(account.refreshToken).toBe('fresh-refresh')
    expect(account.isHealthy).toBe(true)
    expect(saved.map((a) => a.refreshToken)).toEqual(['fresh-refresh'])
  })

  test('keeps the synced refresh token when the retry also fails', async () => {
    refreshResults['cli-refresh'] = invalidGrant()
    const { account, run, batchSaved } = harness(
      makeAccount({
        refreshToken: 'cli-refresh',
        accessToken: 'cli-access',
        expiresAt: Date.now() - 1000
      })
    )

    const result = await run()

    expect(result.shouldContinue).toBe(true)
    expect(refreshCalls).toEqual(['stale-refresh', 'cli-refresh'])
    expect(account.isHealthy).toBe(false)
    expect(account.unhealthyReason).toBe('invalid_grant')
    // The DB row must not be clobbered with the token we already know is dead.
    expect(account.refreshToken).toBe('cli-refresh')
    expect(batchSaved.at(-1)?.[0]?.refreshToken).toBe('cli-refresh')
  })

  test('retries with the client registration kiro-cli holds when ours is stale', async () => {
    refreshResults['stale-refresh'] = new KiroTokenRefreshError(
      'Refresh failed: Client is expired',
      'invalid_client'
    )
    const { account, run } = harness(makeAccount({ clientId: 'cid-new', clientSecret: 'csec-new' }))

    const result = await run()

    expect(result.shouldContinue).toBe(true)
    // Same refresh token both times; only the registration changed.
    expect(refreshCalls).toEqual(['stale-refresh', 'stale-refresh'])
    expect(refreshSecrets).toEqual(['csec', 'csec-new'])
    expect(account.clientId).toBe('cid-new')
    expect(account.clientSecret).toBe('csec-new')
  })

  test('marks the account unhealthy when kiro-cli has nothing newer', async () => {
    const { account, run } = harness(makeAccount())

    const result = await run()

    expect(result.shouldContinue).toBe(true)
    expect(refreshCalls).toEqual(['stale-refresh'])
    expect(account.isHealthy).toBe(false)
    expect(account.unhealthyReason).toBe('invalid_grant')
  })
})
