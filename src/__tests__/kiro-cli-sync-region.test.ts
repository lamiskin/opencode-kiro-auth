import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Captured upserts stand in for kiro.db; rows are returned in the snake_case
// shape the sync reads back through kiroDb.getAccounts().
let stored: any[] = []
const toRow = (a: any) => ({
  id: a.id,
  email: a.email,
  auth_method: a.authMethod,
  region: a.region,
  oidc_region: a.oidcRegion || null,
  client_id: a.clientId,
  client_secret: a.clientSecret,
  profile_arn: a.profileArn,
  start_url: a.startUrl || null,
  refresh_token: a.refreshToken,
  access_token: a.accessToken,
  expires_at: a.expiresAt,
  is_healthy: a.isHealthy ? 1 : 0,
  unhealthy_reason: a.unhealthyReason || null,
  last_sync: a.lastSync || 0
})

mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => stored.map(toRow),
    upsertAccount: async (a: any) => {
      stored = stored.filter((s) => s.id !== a.id)
      stored.push({ ...a })
    },
    deleteStaleIdcDuplicates: async () => {},
    markAccountsUnhealthy: async () => {}
  }
}))
mock.module('../plugin/usage.js', () => ({
  fetchUsageLimits: async () => ({ usedCount: 1, limitCount: 100, email: 'user@corp.example' })
}))
mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {}
}))

// Other test files replace this module with a no-op via mock.module, and Bun keeps
// module mocks across files. The query string resolves to a distinct module URL,
// so this loads the real implementation with the mocks registered above.
const realSyncModule = '../plugin/sync/kiro-cli.js?real'
const { syncFromKiroCli } = await import(realSyncModule)

const PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEFGHIJKL'

let dir: string

function seedCliDb(
  authKv: Array<[string, Record<string, unknown>]>,
  profileArn: string | undefined = PROFILE_ARN
): void {
  const db = new Database(join(dir, 'data.sqlite3'))
  db.run('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
  for (const [key, value] of authKv) {
    db.run('INSERT INTO auth_kv (key, value) VALUES (?, ?)', [key, JSON.stringify(value)])
  }
  if (profileArn) {
    db.run('INSERT INTO state (key, value) VALUES (?, ?)', [
      'api.codewhisperer.profile',
      JSON.stringify({ arn: profileArn, profile_name: 'QDevProfile' })
    ])
  }
  db.close()
}

const idcToken = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'cli-access',
  refresh_token: 'cli-refresh',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  region: 'sa-east-1',
  start_url: 'https://corp.awsapps.com/start',
  oauth_flow: 'Pkce',
  ...overrides
})

const registration = (clientId: string) => ({
  client_id: clientId,
  client_secret: `${clientId}-secret`,
  client_secret_expires_at: new Date(Date.now() + 86400000).toISOString(),
  region: 'sa-east-1',
  oauth_flow: 'Pkce'
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-sync-region-'))
  process.env.KIROCLI_DB_PATH = join(dir, 'data.sqlite3')
  stored = []
})

afterEach(() => {
  delete process.env.KIROCLI_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('syncFromKiroCli IdC regions', () => {
  test('keeps the SSO region for OIDC refresh and the profile region for the API', async () => {
    seedCliDb([
      ['kirocli:odic:device-registration', registration('client-new')],
      ['kirocli:odic:token', idcToken()]
    ])

    await syncFromKiroCli()

    expect(stored).toHaveLength(1)
    const acc = stored[0]
    expect(acc.authMethod).toBe('idc')
    expect(acc.region).toBe('us-east-1')
    expect(acc.oidcRegion).toBe('sa-east-1')
    expect(acc.startUrl).toBe('https://corp.awsapps.com/start')
    expect(acc.clientId).toBe('client-new')
    expect(acc.clientSecret).toBe('client-new-secret')
  })

  test('prefers the kirocli device registration over a leftover legacy row', async () => {
    seedCliDb([
      ['codewhisperer:odic:device-registration', registration('client-legacy')],
      ['kirocli:odic:device-registration', registration('client-new')],
      ['kirocli:odic:token', idcToken()]
    ])

    await syncFromKiroCli()

    expect(stored[0].clientId).toBe('client-new')
    expect(stored[0].clientSecret).toBe('client-new-secret')
  })

  test('ignores legacy codewhisperer rows left behind by the Q CLI migration', async () => {
    seedCliDb([
      ['codewhisperer:odic:device-registration', registration('client-legacy')],
      [
        'codewhisperer:odic:token',
        idcToken({
          access_token: 'legacy-access',
          refresh_token: 'legacy-refresh',
          // time crate's default OffsetDateTime format, as written by the old Q CLI
          expires_at: '2025-03-01 12:00:00.0 +00:00:00'
        })
      ],
      ['kirocli:odic:device-registration', registration('client-new')],
      ['kirocli:odic:token', idcToken()]
    ])

    await syncFromKiroCli()

    expect(stored).toHaveLength(1)
    expect(stored[0].accessToken).toBe('cli-access')
    expect(stored[0].refreshToken).toBe('cli-refresh')
    expect(stored[0].clientId).toBe('client-new')
  })

  test('treats an unparseable expiry as expired rather than valid for an hour', async () => {
    seedCliDb([
      ['kirocli:odic:device-registration', registration('client-new')],
      ['kirocli:odic:token', idcToken({ expires_at: '2025-03-01 12:00:00.0 +00:00:00' })]
    ])

    await syncFromKiroCli()

    expect(stored).toHaveLength(1)
    expect(stored[0].expiresAt).toBe(0)
  })

  test('re-imports a healthy row whose stored OIDC region is wrong', async () => {
    const expiresAt = Date.now() + 3600000
    seedCliDb([
      ['kirocli:odic:device-registration', registration('client-new')],
      ['kirocli:odic:token', idcToken({ expires_at: new Date(expiresAt).toISOString() })]
    ])

    // First sync establishes the row, then simulate the pre-fix state where the
    // OIDC region had been overwritten with the profile region.
    await syncFromKiroCli()
    expect(stored).toHaveLength(1)
    stored[0].oidcRegion = 'us-east-1'

    await syncFromKiroCli()

    expect(stored).toHaveLength(1)
    expect(stored[0].oidcRegion).toBe('sa-east-1')
  })
})
