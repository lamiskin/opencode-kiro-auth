import { describe, expect, mock, test } from 'bun:test'
import { KiroDatabase } from '../plugin/storage/sqlite.js'

describe('cleanupTestAndStaleAccounts', () => {
  mock.module('../plugin/storage/locked-operations.js', () => ({
    withDatabaseLock: (_: string, fn: () => Promise<any>) => fn()
  }))

  test('deletes placeholder email matching pattern', async () => {
    const db = new KiroDatabase(':memory:')
    await db.init()

    // Insert a placeholder email that should match the new pattern
    const placeholderEmail = 'idc-placeholder+abc123@awsapps.local'
    const stmt = db.db.prepare(
      'INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    stmt.run(
      'test-id-1',
      placeholderEmail,
      'idc',
      'us-east-1',
      'refresh',
      'access',
      Date.now() + 3600000
    )
    stmt.run(
      'test-id-2',
      'test@example.com',
      'idc',
      'us-east-1',
      'refresh',
      'access',
      Date.now() + 3600000
    )
    stmt.run(
      'test-id-3',
      'normal@email.com',
      'idc',
      'us-east-1',
      'refresh',
      'access',
      Date.now() + 3600000
    )

    const deleted = await db.cleanupTestAndStaleAccounts()
    expect(deleted).toBe(2) // placeholder email + test@example.com

    const remaining = db.db.prepare('SELECT email FROM accounts ORDER BY email').all()
    expect(remaining).toEqual([{ email: 'normal@email.com' }])
  })
})
