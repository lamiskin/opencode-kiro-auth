/**
 * OpenCode v2 adapter for Kiro plugin.
 *
 * Types are aligned with @opencode/plugin v2.0.16 for type safety.
 * Uses type-only imports from @opencode/plugin to avoid runtime dependencies.
 */

import type { Location, Model, Provider } from '@opencode/plugin'
import type { Tool } from '@opencode/schema/tool'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { HostPort } from '../host/port.js'
import * as logger from '../plugin/logger.js'
import { buildModelRegistry, refreshRegistry } from '../plugin/model-registry.js'
import { createRuntime, Runtime } from '../runtime.js'

// ============ v2 Context types (aligned with @opencode/plugin) ============

/** Minimal v2 PluginContext shape — only what we touch */
interface V2Context {
  location: Location.Info
  provider: {
    transform(editor: (editor: ProviderEditor) => void): Promise<ProviderRegistration>
  }
  model: {
    reload(): void | Promise<void>
  }
  tool: {
    transform(editor: (editor: ToolEditor) => void): Promise<ToolRegistration>
  }
  aisdk: {
    hook(
      type: 'sdk',
      cb: (event: AISDKSdkEvent) => void,
      options: { providerID: string }
    ): Promise<AISDKSdkRegistration>
  }
}

interface ProviderEditor {
  add(input: { info: ProviderInfo; models: ModelInfo[]; sourceConnection?: unknown }): void
}

interface ProviderInfo {
  id: Provider.ID
  name: string
  activation: Provider.Activation
  package: Provider.Package
  settings?: Record<string, unknown>
}

interface ProviderRegistration {
  dispose(): void | Promise<void>
}

interface ToolEditor {
  add(info: ToolInfo): void
}

interface ToolInfo {
  name: string
  description: string
  input?: Tool.ValueSchema
  execute: (args: unknown, context: unknown) => Promise<Tool.Result>
}

interface ToolRegistration {
  dispose(): void | Promise<void>
}

interface AISDKSdkEvent {
  sdk: unknown
}

interface AISDKSdkRegistration {
  dispose(): void | Promise<void>
}

// ============ v2 HostPort implementation ============

/**
 * Creates a v2 HostPort implementation.
 *
 * notify: degrades to logger (no toast capability in v2 server context)
 * reauthorize: stub — not yet implemented in v2 (Phase 5 defers IdC auth)
 */
function createV2HostPort(): HostPort {
  return {
    notify: (message: string, variant: 'info' | 'success' | 'warning' | 'error') => {
      // v2 has no toast/notify in server PluginContext — log only
      const level = variant === 'error' ? 'error' : variant === 'warning' ? 'warn' : 'log'
      ;(logger as any)[level]('[v2 notify]', message)
    },
    reauthorize: async () => {
      // Phase 5 (IdC auth) is deferred — this stub avoids breaking re-auth flow
      throw new Error(
        'Re-authorization not yet implemented in v2 adapter. ' +
          'This is a known limitation — re-auth will be available in a future update.'
      )
    }
  }
}

// ============ Model → v2 Model.Info mapping ============

interface ModelInfo {
  id: Model.ID
  modelID: Model.ID
  providerID: Provider.ID
  package: Provider.Package
  name: string
  limit: { context: number; output: number }
  capabilities: {
    tools: boolean
    input: readonly ('text' | 'image' | 'pdf')[]
    output: readonly ('text' | 'image' | 'file')[]
  }
  compatibility?: {
    reasoningField?: 'reasoning_content'
  }
  time: { released: number }
  cost: Array<unknown>
  status: 'active'
  enabled: true
  variants?: Array<{ id: Model.VariantID; settings?: Record<string, unknown> }>
}

/**
 * Maps buildModelRegistry() output to v2 Model.Info shape.
 *
 * Key mappings:
 * - modalities → capabilities (input/output)
 * - interleaved.field → compatibility.reasoningField
 * - variants: Record → Array<{id, settings}>
 * - Cast IDs to branded types per @opencode/schema
 */
function buildV2Models(baseURL: string): ModelInfo[] {
  const registry = buildModelRegistry() as Record<
    string,
    {
      name: string
      limit: { context: number; output: number }
      modalities: { input: Array<'text' | 'image' | 'pdf'>; output: ['text'] }
      reasoning?: boolean
      interleaved?: { field: string }
      variants?: Record<string, unknown>
    }
  >

  const models: ModelInfo[] = []

  for (const [modelID, model] of Object.entries(registry)) {
    const isThinking = modelID.endsWith('-thinking')
    const hasReasoning = model.reasoning || isThinking

    // Build variants array from Record<string, unknown>
    const variants: Array<{ id: Model.VariantID; settings?: Record<string, unknown> }> = []
    if (model.variants) {
      for (const [variantId, variantValue] of Object.entries(model.variants)) {
        variants.push({
          id: variantId as Model.VariantID,
          settings: variantValue as Record<string, unknown>
        })
      }
    }

    // Cast IDs to branded types
    const modelIdBranded = modelID as Model.ID
    const providerIdBranded = 'kiro' as Provider.ID

    models.push({
      id: modelIdBranded,
      modelID: modelIdBranded,
      providerID: providerIdBranded,
      package: '@ai-sdk/openai-compatible' as Provider.Package,
      name: model.name,
      limit: model.limit,
      capabilities: {
        tools: true,
        input: model.modalities.input as readonly ('text' | 'image' | 'pdf')[],
        output: ['text'] as const
      },
      compatibility: hasReasoning ? { reasoningField: 'reasoning_content' } : undefined,
      time: { released: 0 },
      cost: [],
      status: 'active',
      enabled: true,
      ...(variants.length > 0 ? { variants } : {})
    })
  }

  return models
}

// ============ Tool → v2 Tool.Info mapping ============

function mapTools(runtime: Runtime): ToolInfo[] {
  const tools: ToolInfo[] = []

  for (const [name, toolDef] of Object.entries(runtime.tools)) {
    const toolAny = toolDef as any
    // Wrap v1 execute (returns string) into v2 Tool.Result shape
    const originalExecute = toolAny.execute
    const wrappedExecute = async (args: unknown, context: unknown): Promise<Tool.Result> => {
      try {
        const result = await originalExecute(args, context)
        // v1 execute returns string, wrap in Tool.Result
        return { output: result }
      } catch (e) {
        return { output: String(e), metadata: { error: true } }
      }
    }
    tools.push({
      name,
      description: toolAny.description || '',
      input: toolAny.args as Tool.ValueSchema | undefined,
      execute: wrappedExecute
    })
  }

  return tools
}

// ============ Main setup function ============

/**
 * v2 plugin entrypoint — called by OpenCode v2 when loading this plugin.
 *
 * Registration flow:
 * 1. Create runtime with v2 HostPort
 * 2. Register provider + models via ctx.provider.transform
 * 3. Register tools via ctx.tool.transform
 * 4. Register aisdk hook for custom fetch
 * 5. Initialize auth (CLI sync)
 * 6. Refresh model catalog asynchronously, then reload models
 * 7. Return cleanup function to dispose all registrations
 */
export async function kiroSetup(ctx: V2Context): Promise<(() => void | Promise<void>) | void> {
  // Bug #1 fix: ctx.directory → ctx.location.directory
  const directory = ctx.location.directory as string
  logger.log('[v2] kiroSetup starting', { directory })

  // Create runtime with v2 HostPort
  const port = createV2HostPort()
  const runtime = await createRuntime(directory, port)

  // Set up auth handler with the port
  runtime.authHandler.setPort(port)
  runtime.authHandler.setAccountManager(runtime.accountManager)

  const registrations: Array<{ dispose(): void | Promise<void> }> = []

  // Bug #2 fix: provider.add() takes single object { info, models }
  const providerReg = await ctx.provider.transform((editor) => {
    const models = buildV2Models(runtime.baseURL)
    editor.add({
      info: {
        id: 'kiro' as Provider.ID,
        name: 'Kiro',
        activation: 'enabled' as const,
        package: '@ai-sdk/openai-compatible' as Provider.Package,
        settings: {
          baseURL: runtime.baseURL
        }
      },
      models
    })
  })
  registrations.push(providerReg)

  // Register tools
  const tools = mapTools(runtime)
  const toolReg = await ctx.tool.transform((editor) => {
    for (const tool of tools) {
      editor.add(tool)
    }
  })
  registrations.push(toolReg)

  // Register aisdk hook for custom fetch
  // The event.sdk should be an OpenAI-compatible fetch wrapper.
  // We provide a minimal fetch implementation that routes to requestHandler.
  const aisdkReg = await ctx.aisdk.hook(
    'sdk',
    (event) => {
      // Create the real OpenAI-compatible provider instance
      // This provides the full AI SDK provider interface with languageModel(), chatModel(), etc.
      // Cast to any to avoid FetchFunction type mismatch - our handler accepts the standard fetch(input, init) signature
      event.sdk = createOpenAICompatible({
        name: 'kiro',
        baseURL: runtime.baseURL,
        apiKey: '',
        fetch: ((input: any, init?: any) => runtime.requestHandler.handle(input, init)) as any
      })
    },
    { providerID: 'kiro' }
  )
  registrations.push(aisdkReg)

  // Initialize auth (CLI sync) — runs unconditionally in v2
  await runtime.authHandler.initialize()

  // Refresh model catalog asynchronously, then reload models
  // Don't await — let it run in background to avoid blocking startup
  refreshRegistry()
    .then(() => {
      logger.log('[v2] Model catalog refreshed')
      ctx.model.reload()
    })
    .catch((e) => {
      logger.warn('[v2] Model catalog refresh failed', { error: e })
    })

  logger.log('[v2] kiroSetup complete', {
    tools: tools.length,
    directory
  })

  // Return cleanup function
  return async () => {
    logger.log('[v2] Cleanup starting', { registrations: registrations.length })
    for (const reg of registrations) {
      try {
        await reg.dispose()
      } catch (e) {
        logger.warn('[v2] Registration dispose failed', { error: e })
      }
    }
    logger.log('[v2] Cleanup complete')
  }
}
