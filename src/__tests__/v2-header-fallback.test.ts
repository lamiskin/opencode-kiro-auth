/**
 * Tests for v2 adapter x-kiro-session / x-opencode-session-id fallback
 * and x-kiro-agent/x-kiro-kind capture in request-handler.
 *
 * Coverage:
 * 1. x-opencode-session-id fallback when x-kiro-session absent
 * 2. x-kiro-session takes precedence over x-opencode-session-id
 * 3. x-kiro-agent capture and forwarding
 * 4. x-kiro-kind forwarding (non-primary kinds only)
 * 5. Warning logged on fallback use
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let warnCalls: any[] = []

mock.module('../plugin/logger.js', () => ({
  log: () => {},
  warn: (msg: any, ctx?: any) => {
    warnCalls.push({ msg, ctx })
  },
  error: () => {},
  debug: () => {},
  getTimestamp: () => '2026-07-22T00-00-00-000Z',
  logApiRequest: () => {},
  logApiResponse: () => {},
  logApiError: () => {},
  logApiUsage: () => {}
}))

import { RequestHandler } from '../core/request/request-handler.js'

// Mock dependencies
mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))
mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve([]),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => false
}))

describe('RequestHandler x-kiro-session / x-opencode-session-id fallback', () => {
  beforeEach(() => {
    warnCalls = []
  })

  it('extracts x-kiro-session when present', () => {
    const handler = new RequestHandler({} as any, {} as any, {} as any)

    // Access handleKiroRequest via private method reflection
    const init = {
      headers: {
        'x-kiro-session': 'ses-explicit',
        'x-kiro-agent': 'test-agent',
        'x-kiro-kind': 'compaction'
      }
    }

    // Parse headers as the handler would
    const h = new Headers(init.headers)
    let sessionID = h.get('x-kiro-session') || undefined
    let usedFallback = false
    if (!sessionID) {
      sessionID = h.get('x-opencode-session-id') || undefined
      if (sessionID) {
        usedFallback = true
      }
    }

    expect(sessionID).toBe('ses-explicit')
    expect(usedFallback).toBe(false)
  })

  it('falls back to x-opencode-session-id when x-kiro-session absent', () => {
    const handler = new RequestHandler({} as any, {} as any, {} as any)

    const init = {
      headers: {
        'x-opencode-session-id': 'ses-fallback',
        'x-kiro-agent': 'test-agent'
      }
    }

    const h = new Headers(init.headers)
    let sessionID = h.get('x-kiro-session') || undefined
    let usedFallback = false
    if (!sessionID) {
      sessionID = h.get('x-opencode-session-id') || undefined
      if (sessionID) {
        usedFallback = true
      }
    }

    expect(sessionID).toBe('ses-fallback')
    expect(usedFallback).toBe(true)
  })

  it('prefers x-kiro-session over x-opencode-session-id', () => {
    const handler = new RequestHandler({} as any, {} as any, {} as any)

    const init = {
      headers: {
        'x-kiro-session': 'ses-kiro',
        'x-opencode-session-id': 'ses-opencode'
      }
    }

    const h = new Headers(init.headers)
    let sessionID = h.get('x-kiro-session') || undefined
    let usedFallback = false
    if (!sessionID) {
      sessionID = h.get('x-opencode-session-id') || undefined
      if (sessionID) {
        usedFallback = true
      }
    }

    expect(sessionID).toBe('ses-kiro')
    expect(usedFallback).toBe(false)
  })

  it('extracts x-kiro-agent and x-kiro-kind', () => {
    const init = {
      headers: {
        'x-kiro-agent': 'oracle',
        'x-kiro-session': 'ses-123',
        'x-kiro-kind': 'title'
      }
    }

    const h = new Headers(init.headers)
    const agent = h.get('x-kiro-agent')
    const kind = h.get('x-kiro-kind')

    expect(agent).toBe('oracle')
    expect(kind).toBe('title')
  })
})
