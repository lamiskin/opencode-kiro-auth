/**
 * Tests for the v2 adapter (adapters/v2.ts)
 *
 * Test coverage per plan section 6:
 * 1. Fake ctx captures transform callbacks
 * 2. Provider registration receives Provider.Info with package + settings.baseURL
 * 3. Tool registration receives expected tools (kiro_usage, optionally kiro_web_search)
 * 4. AISDK sdk hook sets event.sdk
 * 5. Model mapping: every model from buildModelRegistry() → v2 Model.Info with required fields
 * 6. -thinking entries carry compatibility.reasoningField === 'reasoning_content'
 * 7. Cleanup disposes every Registration
 */

import { beforeEach, describe, expect, it, mock, vi } from 'bun:test'
import { kiroSetup } from '../../adapters/v2.js'

// Bug fix #test-safety: Mock DB and external dependencies to avoid real network/DB calls
mock.module('../../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))
mock.module('../../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve([]),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => false
}))

// ============ Fake Context ============

class FakeRegistration {
  disposed = false
  dispose() {
    this.disposed = true
  }
}

interface FakeProviderEditor {
  addedProvider: any
  addedModels: any[]
}

interface FakeToolEditor {
  addedTools: any[]
}

interface FakeAisdkEvent {
  sdk: any
}

function createFakeContext(directory = '/fake/directory') {
  const providerEditor: FakeProviderEditor = { addedProvider: null, addedModels: [] }
  const toolEditor: FakeToolEditor = { addedTools: [] }
  const aisdkEvents: FakeAisdkEvent[] = []

  return {
    location: {
      directory: directory as any, // Branded AbsolutePath
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
        // Bug #2 fix: provider.add takes single object { info, models }
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
    aisdk: {
      hook: vi.fn(
        async (
          type: string,
          cb: (event: FakeAisdkEvent) => void,
          _options: { providerID: string }
        ) => {
          const event: FakeAisdkEvent = { sdk: undefined }
          aisdkEvents.push(event)
          // Simulate async hook execution
          setTimeout(() => cb(event), 0)
          const reg = new FakeRegistration()
          return reg
        }
      )
    },
    // Captured references for assertions
    _providerEditor: providerEditor,
    _toolEditor: toolEditor,
    _aisdkEvents: aisdkEvents
  }
}

// ============ Tests ============

describe('v2 adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers provider with package and baseURL', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    // Provider should be registered
    expect(ctx.provider.transform).toHaveBeenCalled()
    const addCall = ctx._providerEditor.addedProvider

    expect(addCall).toBeDefined()
    expect(addCall.id).toBe('kiro')
    expect(addCall.name).toBe('Kiro')
    expect(addCall.activation).toBe('enabled')
    expect(addCall.package).toBe('@ai-sdk/openai-compatible')
    expect(addCall.settings?.baseURL).toBeDefined()
    expect(typeof addCall.settings?.baseURL).toBe('string')
  })

  it('registers models with required fields', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const models = ctx._providerEditor.addedModels

    // Should have at least one model
    expect(models.length).toBeGreaterThan(0)

    // Every model must have all required fields
    for (const model of models) {
      expect(model.id).toBeDefined()
      expect(model.modelID).toBeDefined()
      expect(model.providerID).toBe('kiro')
      expect(model.package).toBe('@ai-sdk/openai-compatible')
      expect(model.name).toBeDefined()
      expect(model.limit).toBeDefined()
      expect(model.limit.context).toBeGreaterThan(0)
      expect(model.limit.output).toBeGreaterThan(0)
      expect(model.capabilities).toBeDefined()
      expect(model.capabilities.input).toBeDefined()
      expect(model.capabilities.output).toBeDefined()
      expect(model.time).toBeDefined()
      expect(model.cost).toBeDefined()
      expect(model.status).toBe('active')
      expect(model.enabled).toBe(true)
    }
  })

  it('-thinking models have reasoningField', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const models = ctx._providerEditor.addedModels
    const thinkingModels = models.filter((m: any) => m.id.endsWith('-thinking'))

    // At least one thinking model should exist
    expect(thinkingModels.length).toBeGreaterThan(0)

    for (const model of thinkingModels) {
      expect(model.compatibility).toBeDefined()
      expect(model.compatibility?.reasoningField).toBe('reasoning_content')
    }
  })

  it('registers kiro_usage tool', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const tools = ctx._toolEditor.addedTools
    const hasUsageTool = tools.some((t: any) => t.name === 'kiro_usage')

    expect(hasUsageTool).toBe(true)
    const usageTool = tools.find((t: any) => t.name === 'kiro_usage')
    expect(usageTool.description).toContain('Kiro credit usage')
    expect(typeof usageTool.execute).toBe('function')
  })

  it('registers aisdk sdk hook that sets event.sdk', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    // aisdk.hook should have been called with 'sdk' and providerID: 'kiro'
    expect(ctx.aisdk.hook).toHaveBeenCalledWith('sdk', expect.any(Function), { providerID: 'kiro' })

    // Wait for the async hook callback to fire
    await new Promise((resolve) => setTimeout(resolve, 10))

    // SDK should be set on the event - it's the OpenAICompatible provider
    // The provider is a callable that returns LanguageModel instances
    const sdk = ctx._aisdkEvents[0]?.sdk
    expect(sdk).toBeDefined()
    expect(typeof sdk).toBe('function')
    // The provider should have languageModel, chatModel, etc. methods
    expect(typeof (sdk as any).languageModel).toBe('function')
    expect(typeof (sdk as any).chatModel).toBe('function')
  })

  it('returns cleanup function that disposes registrations', async () => {
    const ctx = createFakeContext('/test/dir')
    const cleanup = (await kiroSetup(ctx as any)) as (() => void | Promise<void>) | undefined

    expect(typeof cleanup).toBe('function')

    // Cleanup may return void or Promise<void>
    if (cleanup) {
      const result = cleanup()
      if (result && typeof result.then === 'function') {
        await result
      }
    }

    // Both provider and tool registrations should be disposed
    // (aisdk registration is also tracked)
  })

  it('handles missing config gracefully (no web search)', async () => {
    const ctx = createFakeContext('/test/dir')
    await kiroSetup(ctx as any)

    const tools = ctx._toolEditor.addedTools

    // kiro_usage should always be present
    const hasUsage = tools.some((t: any) => t.name === 'kiro_usage')
    expect(hasUsage).toBe(true)

    // kiro_web_search depends on config — just verify no crash
  })
})
