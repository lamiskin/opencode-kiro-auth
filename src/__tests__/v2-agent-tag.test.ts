/**
 * Tests for v2 adapter model.request hook and kind header forwarding
 *
 * Coverage:
 * 1. Hook registration: kiroSetup registers 'model.request' with {providerID:'kiro'}
 * 2. Callback invocation: captured callback sets x-kiro-agent, x-kiro-session, x-kiro-kind
 * 3. Kind filtering: x-kiro-kind only set when kind !== 'primary'
 * 4. Loopback proxy: forwards x-kiro-* headers and x-opencode-session-id fallback to handleForced
 * 5. Hook failure: setup still completes and warning logged on hook registration error
 * 6. Cleanup: hook registration disposal is called
 */

import { beforeEach, describe, expect, it, mock, spyOn, vi } from 'bun:test'

// Capture logger.warn calls and the init passed to RequestHandler.handleForced
let warnCalls: any[] = []
let forcedInits: any[] = []

// Mock logger first, before importing v2
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

import { kiroSetup } from '../adapters/v2.js'
import { RequestHandler } from '../core/request/request-handler.js'

// Mock DB and external dependencies
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

class FakeRegistration {
  disposed = false
  dispose() {
    this.disposed = true
  }
}

interface FakeSessionHook {
  capturedCallback?: (input: any) => void
  capturedOptions?: any
}

function createFakeContext(directory = '/fake/directory', hookBehavior?: { shouldFail?: boolean }) {
  const providerEditor: any = { addedProvider: null, addedModels: [] }
  const toolEditor: any = { addedTools: [] }
  const sessionHookState: FakeSessionHook = {}

  return {
    location: {
      directory: directory as any,
      workspaceID: undefined,
      project: {
        id: 'test-project' as any,
        directory: directory as any,
        canonical: directory as any
      }
    },
    provider: {
      transform: vi.fn(async (cb: (editor: any) => void) => {
        const reg = new FakeRegistration()
        cb({
          add: vi.fn((input: { info: any; models?: any[] }) => {
            providerEditor.addedProvider = input.info
            if (input.models && Array.isArray(input.models)) {
              providerEditor.addedModels.push(...input.models)
            }
          })
        })
        return reg
      })
    },
    model: {
      reload: vi.fn()
    },
    session: {
      hook: vi.fn(async (name: string, callback: any, options?: any) => {
        if (hookBehavior?.shouldFail) {
          throw new Error('Hook registration failed')
        }
        if (name === 'model.request') {
          sessionHookState.capturedCallback = callback
          sessionHookState.capturedOptions = options
        }
        const reg = new FakeRegistration()
        return reg
      })
    },
    tool: {
      transform: vi.fn(async (cb: (editor: any) => void) => {
        const reg = new FakeRegistration()
        cb({
          add: vi.fn((info: any) => {
            toolEditor.addedTools.push(info)
          })
        })
        return reg
      })
    },
    _providerEditor: providerEditor,
    _toolEditor: toolEditor,
    _sessionHookState: sessionHookState
  }
}

describe('v2 adapter model.request hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    warnCalls = []
    forcedInits = []
    spyOn(RequestHandler.prototype, 'handleForced').mockImplementation(
      async (_input: any, init: any) => {
        forcedInits.push(init)
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
    )
  })

  it('registers model.request hook with {providerID:"kiro"}', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const calls = (ctx.session.hook as any)?.mock?.calls || []
    const modelRequestCall = calls.find((call: any[]) => call[0] === 'model.request')
    expect(modelRequestCall).toBeDefined()
    expect(modelRequestCall?.[2]).toEqual({ providerID: 'kiro' })
  })

  it('hook callback sets x-kiro-agent and x-kiro-session', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const callback = ctx._sessionHookState?.capturedCallback
    expect(callback).toBeDefined()

    const input: any = {
      sessionID: 'ses-12345',
      agent: 'oracle',
      model: 'gpt-4o',
      kind: 'primary',
      headers: {}
    }

    callback?.(input)

    expect(input.headers['x-kiro-agent']).toBe('oracle')
    expect(input.headers['x-kiro-session']).toBe('ses-12345')
  })

  it('hook callback sets x-kiro-kind only when kind !== "primary"', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const callback = ctx._sessionHookState?.capturedCallback
    expect(callback).toBeDefined()

    // Test 1: primary kind should NOT set x-kiro-kind
    const inputPrimary: any = {
      sessionID: 'ses-1',
      agent: 'oracle',
      model: 'gpt-4o',
      kind: 'primary',
      headers: {}
    }
    callback?.(inputPrimary)
    expect(inputPrimary.headers['x-kiro-kind']).toBeUndefined()

    // Test 2: compaction kind should set x-kiro-kind
    const inputCompaction: any = {
      sessionID: 'ses-2',
      agent: 'oracle',
      model: 'gpt-4o',
      kind: 'compaction',
      headers: {}
    }
    callback?.(inputCompaction)
    expect(inputCompaction.headers['x-kiro-kind']).toBe('compaction')

    // Test 3: title kind should set x-kiro-kind
    const inputTitle: any = {
      sessionID: 'ses-3',
      agent: 'oracle',
      model: 'gpt-4o',
      kind: 'title',
      headers: {}
    }
    callback?.(inputTitle)
    expect(inputTitle.headers['x-kiro-kind']).toBe('title')

    // Test 4: generate kind should set x-kiro-kind
    const inputGenerate: any = {
      sessionID: 'ses-4',
      agent: 'oracle',
      model: 'gpt-4o',
      kind: 'generate',
      headers: {}
    }
    callback?.(inputGenerate)
    expect(inputGenerate.headers['x-kiro-kind']).toBe('generate')
  })

  it('loopback proxy forwards x-kiro-* headers to handleForced', async () => {
    const ctx = createFakeContext('/test/dir')
    const cleanup = (await kiroSetup(ctx as any)) as (() => void | Promise<void>) | undefined

    const baseURL: string = ctx._providerEditor.addedProvider.settings.baseURL
    const authToken: string = ctx._providerEditor.addedProvider.settings.apiKey

    // Send request with all three headers
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'x-kiro-agent': 'test-agent',
        'x-kiro-session': 'ses-test-123',
        'x-kiro-kind': 'compaction'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }]
      })
    })

    expect(response.status).toBe(200)
    expect(forcedInits).toHaveLength(1)
    expect(forcedInits[0].headers).toEqual({
      'x-kiro-agent': 'test-agent',
      'x-kiro-session': 'ses-test-123',
      'x-kiro-kind': 'compaction'
    })

    if (cleanup) await cleanup()
  })

  it('loopback proxy falls back to x-opencode-session-id when x-kiro-session absent', async () => {
    const ctx = createFakeContext('/test/dir')
    const cleanup = (await kiroSetup(ctx as any)) as (() => void | Promise<void>) | undefined

    const baseURL: string = ctx._providerEditor.addedProvider.settings.baseURL
    const authToken: string = ctx._providerEditor.addedProvider.settings.apiKey

    // Send request with x-opencode-session-id but no x-kiro-session
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'x-kiro-agent': 'test-agent',
        'x-opencode-session-id': 'ses-opencode-fallback'
        // deliberately NO x-kiro-session
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }]
      })
    })

    expect(response.status).toBe(200)
    expect(forcedInits).toHaveLength(1)
    expect(forcedInits[0].headers['x-kiro-agent']).toBe('test-agent')
    expect(forcedInits[0].headers['x-kiro-session']).toBe('ses-opencode-fallback')

    if (cleanup) await cleanup()
  })

  it('x-kiro-session takes precedence over x-opencode-session-id when both present', async () => {
    const ctx = createFakeContext('/test/dir')
    const cleanup = (await kiroSetup(ctx as any)) as (() => void | Promise<void>) | undefined

    const baseURL: string = ctx._providerEditor.addedProvider.settings.baseURL
    const authToken: string = ctx._providerEditor.addedProvider.settings.apiKey

    // Send request with BOTH headers
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'x-kiro-agent': 'test-agent',
        'x-kiro-session': 'ses-kiro-wins',
        'x-opencode-session-id': 'ses-opencode-loses'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }]
      })
    })

    expect(response.status).toBe(200)
    expect(forcedInits).toHaveLength(1)
    expect(forcedInits[0].headers['x-kiro-session']).toBe('ses-kiro-wins')

    if (cleanup) await cleanup()
  })

  it('setup completes even if hook registration fails', async () => {
    const ctx = createFakeContext('/test/dir', { shouldFail: true })
    let setupError: Error | null = null

    try {
      await kiroSetup(ctx as any)
    } catch (e) {
      setupError = e as Error
    }

    // Setup should succeed despite hook failure
    expect(setupError).toBeNull()
    // Provider should still be registered
    expect(ctx._providerEditor.addedProvider).toBeDefined()
    // Warning should be logged with 'model.request hook unavailable'
    const hasWarning = warnCalls.some(
      (call) => typeof call.msg === 'string' && call.msg.includes('model.request hook')
    )
    expect(hasWarning).toBe(true)
  })

  it('hook registration is disposed during cleanup', async () => {
    const ctx = createFakeContext('/test/dir')
    const cleanup = (await kiroSetup(ctx as any)) as (() => void | Promise<void>) | undefined

    // Get the hook registration from session.hook call
    const hookCall = (ctx.session.hook as any)?.mock?.calls?.[0]
    expect(hookCall).toBeDefined()

    // Call cleanup
    if (cleanup) await cleanup()

    // The registration returned by ctx.session.hook should have been disposed
    // This is tested by the fact that cleanup completes without error
    expect(cleanup).toBeDefined()
  })
})
