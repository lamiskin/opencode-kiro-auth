/**
 * OpenCode v2 adapter for Kiro plugin.
 *
 * Types are aligned with @opencode/plugin v2.0.16 for type safety.
 * Uses type-only imports from @opencode/plugin to avoid runtime dependencies.
 */

import { tool } from '@opencode-ai/plugin'
import type { Location, Model, Provider } from '@opencode/plugin'
import type { Tool } from '@opencode/schema/tool'

import * as http from 'node:http'
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
  /** Static request header overlay (Provider.Overlays in @opencode/schema). */
  headers?: Record<string, string>
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
  output?: Tool.ValueSchema
  execute: (args: unknown, context: unknown) => Promise<Tool.Result>
}

interface ToolRegistration {
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

// ============ Local HTTP server fronting RequestHandler ============

/**
 * OpenCode v2 resolves an `@ai-sdk/openai-compatible` provider by calling that
 * package's own `model(modelID, settings)` against `settings.baseURL` — it
 * makes a real HTTP request, the same way the published `b3nw/
 * opencode-dynamic-custom-providers` plugin and OpenCode's docs describe for
 * v2 custom providers. There is no fetch-injection point for this path (that
 * is what `ctx.aisdk.hook('sdk', ...)` is for — instrumenting an SDK instance
 * OpenCode itself already built from a resolvable package — not supplying a
 * fully custom backend). So Kiro's auth/token/request handling is fronted by
 * an actual loopback HTTP server, and `settings.baseURL` points at that.
 *
 * The loopback server is runtime-scoped (created fresh per kiroSetup call)
 * with token authentication to prevent unauthorized local access.
 *
 * The token is accepted from two places, because v2 only reliably forwards
 * one of them. `settings.apiKey` alone does not reach the wire: the host
 * stores it in the provider catalog (visible via `GET /api/provider`) but the
 * request arriving here carries no matching `Authorization` header, so a
 * header-only gate 401s every chat and OpenChamber renders that as
 * "Authentication failed for this provider". `settings.baseURL`, by contrast,
 * is copied verbatim, so the token is also embedded as a path prefix and that
 * is what actually authenticates in practice. A `headers` overlay on
 * Provider.Info (a first-class field in @opencode/schema's Provider.Overlays)
 * supplies the Authorization header as well, and is accepted here when
 * present.
 */

interface LocalProxyServer {
  baseURL: string
  token: string
  close: () => Promise<void>
}

function createLocalProxyServer(runtime: Runtime): Promise<LocalProxyServer> {
  return new Promise((resolve, reject) => {
    // Generate a random token, presented both as a bearer token and as a
    // path prefix on baseURL.
    const token = crypto.randomUUID()
    const tokenPath = `/k/${token}`

    const server = http.createServer(async (req, res) => {
      // Narrow the route surface — only accept POST to chat completions.
      // Return 404 for anything else to reduce attack surface.
      // Also account for the token prefix in the path (e.g., /k/uuid/chat/completions).
      //
      // Both the bare and /v1-prefixed forms are accepted. OpenCode v2's
      // openai-compatible provider appends the path to baseURL verbatim
      // (`url: ({ path }) => \`${baseURL}${path}\`` with path
      // "/chat/completions"), and our baseURL has no /v1 segment — so the real
      // request arrives as /chat/completions. An earlier /v1-only guard 404'd
      // every chat, surfacing in the host as "Not Found" with no log line.
      // The /v1 form stays accepted because a caller may set a /v1 baseURL.
      const reqPath = req.url || '/'
      // Strip any /k/<token> prefix for route matching — don't assume it's our token
      // (we'll auth-check separately after route validation)
      const pathWithoutTokenPrefix = reqPath.replace(/^\/k\/[^/]+/, '') || '/'
      const routeWithoutQuery = pathWithoutTokenPrefix.split('?', 1)[0]
      const isChatCompletions =
        req.method === 'POST' &&
        (routeWithoutQuery === '/chat/completions' || routeWithoutQuery === '/v1/chat/completions')
      if (!isChatCompletions) {
        // Logged, because a silent 404 here is indistinguishable from a host-side
        // routing failure — the host reports only the "Not Found" message body.
        logger.warn('[v2] Local proxy rejected unroutable request', {
          method: req.method,
          route: routeWithoutQuery
        })
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'Not Found' } }))
        return
      }

      // Authenticate: accept the token from the URL path prefix or from a
      // Bearer header. Either alone is sufficient.
      // TODO (v2 auth verification): The path-prefix token form is a fallback.
      // Once the header auth (via Provider.Info.headers overlay) is confirmed working
      // with the correct package specifier, the path-prefix can be removed — it's
      // leakier (appears in req.url, logs) than the header form. Keeping both for
      // now since we can't live-test from here.
      const pathAuthed = reqPath === tokenPath || reqPath.startsWith(`${tokenPath}/`)
      const authHeader = req.headers.authorization
      const headerAuthed =
        !!authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7) === token

      if (!pathAuthed && !headerAuthed) {
        // Logged, because a silent 401 here is indistinguishable from a
        // credential problem in the host's UI.
        logger.warn('[v2] Local proxy rejected unauthenticated request', {
          method: req.method,
          hasAuthHeader: !!authHeader,
          pathPrefixMatched: false
        })
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
        return
      }

      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', async () => {
        const body = Buffer.concat(chunks)
        // Strip the token path prefix so the forwarded URL looks like the
        // upstream path (RequestHandler reads the model out of it).
        // SHOULD FIX #9: The header-forwarding loop is dead code.
        // handleKiroRequest only reads init?.body, never init?.headers.
        // Headers are not forwarded — RequestHandler reconstructs them from auth.
        const forwardPath = pathAuthed ? reqPath.slice(tokenPath.length) || '/' : reqPath
        const url = `http://127.0.0.1${forwardPath}`
        const bodyStr = body.length ? body.toString('utf8') : undefined

        // Cap request body size to prevent unbounded memory growth
        const MAX_BODY_SIZE = 50 * 1024 * 1024 // 50MB
        if (body.length > MAX_BODY_SIZE) {
          res.statusCode = 413
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'Payload too large' } }))
          return
        }

        try {
          // Pass empty headers object — RequestHandler handles auth itself
          const response: Response = await runtime.requestHandler.handleForced(url, {
            method: req.method,
            headers: {},
            body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyStr : undefined
          })

          res.statusCode = response.status
          response.headers.forEach((value, key) => {
            // Buffering the whole body first (arrayBuffer) delayed every
            // byte until the SSE stream fully finished, which is wrong for
            // a live text/event-stream response. Pipe chunks through as
            // they arrive instead. Content-Length would be wrong for a
            // streamed body and Node sets Transfer-Encoding itself.
            if (key.toLowerCase() === 'content-length') return
            res.setHeader(key, value)
          })
          if (!response.body) {
            res.end()
            return
          }
          const reader = response.body.getReader()
          let aborted = false

          // MUST FIX #4: Handle client disconnect to prevent leaked SDK streams.
          // When the client closes the connection, cancel the upstream stream.
          const cleanup = () => {
            if (!aborted) {
              aborted = true
              reader.cancel().catch(() => {}) // Ignore cancel errors
            }
          }
          res.on('close', cleanup)
          req.on('aborted', cleanup)

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (aborted) break // Exit early if client disconnected
              if (value) res.write(Buffer.from(value))
            }
          } finally {
            res.off('close', cleanup)
            req.off('aborted', cleanup)
            res.end()
          }
        } catch (e) {
          logger.error('[v2] Local proxy request failed', e instanceof Error ? e : undefined)
          // MUST FIX #3: Check headersSent before attempting to set status/headers.
          // If the SDK stream already started writing, this throws ERR_HTTP_HEADS_SENT.
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: { message: String(e) } }))
          } else {
            res.destroy()
          }
        }
      })
    })

    server.on('error', reject)
    // MUST FIX #5: Replace reject-handler with persistent logger after listen resolves.
    // Once the promise settles, subsequent errors would call reject on an already-
    // settled promise (silent no-op) and throw if there's no other listener.
    // MUST FIX #5: Replace reject-handler with persistent logger after listen resolves.
    // Also add close handler to log server shutdown.
    server.listen(0, '127.0.0.1', () => {
      server.removeAllListeners('error') // Remove the reject handler
      server.on('error', (err) => logger.error('[v2] proxy server error', err))
      server.on('close', () => logger.log('[v2] Local proxy server closed'))
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      const baseURL = `http://127.0.0.1:${port}${tokenPath}`
      logger.log('[v2] Local proxy server started', {
        baseURL: `http://127.0.0.1:${port}${tokenPath.slice(0, 11)}...`,
        token: token.slice(0, 8) + '...'
      })

      resolve({
        baseURL,
        token,
        close: () => {
          return new Promise((res) => {
            // Close all connections before closing the server to ensure
            // in-flight SSE streams don't keep the process alive
            server.closeAllConnections()
            server.close(() => res())
          })
        }
      })
    })
  })
}

// ============ Model → v2 Model.Info mapping ============

interface ModelInfo {
  id: Model.ID
  modelID: Model.ID
  providerID: Provider.ID
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
  variants: Array<{ id: Model.VariantID; settings?: Record<string, unknown> }>
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
function buildV2Models(): ModelInfo[] {
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
      variants
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
      // MUST FIX #6: toolAny.args is a raw zod shape object, not a Tool.ValueSchema.
      // Tool.ValueSchema requires a ~standard key (from z.object(shape)), so wrap it.
      input: toolAny.args ? tool.schema.object(toolAny.args) : undefined,
      // output describes the Tool.Result output field — v1 tools return strings
      output: tool.schema.string(),
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
 * 2. Start a local loopback HTTP server fronting RequestHandler
 * 3. Register provider + models via ctx.provider.transform, pointing the
 *    real @ai-sdk/openai-compatible package at that local server
 * 4. Register tools via ctx.tool.transform
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
  // SHOULD FIX #11: remove redundant setAccountManager — createRuntime already does this at line 38
  // runtime.authHandler.setAccountManager(runtime.accountManager)

  const registrations: Array<{ dispose(): void | Promise<void> }> = []

  // Start runtime-scoped local proxy server with token auth
  const proxy = await createLocalProxyServer(runtime)
  const localBaseURL = proxy.baseURL
  const authToken = proxy.token
  registrations.push({ dispose: () => proxy.close() })

  // Bug #2 fix: provider.add() takes single object { info, models }
  const providerReg = await ctx.provider.transform((editor) => {
    const models = buildV2Models()
    editor.add({
      info: {
        id: 'kiro' as Provider.ID,
        name: 'Kiro',
        activation: 'enabled' as const,
        // MUST FIX #1: @ai-sdk/openai-compatible has no 'model' export.
        // The correct package per v2's ProviderPackage.Definition is:
        package: '@opencode/ai/providers/openai-compatible' as Provider.Package,
        settings: {
          baseURL: localBaseURL,
          apiKey: authToken
        },
        // baseURL carries the token too; this overlay is the header path,
        // which settings.apiKey alone does not reach on v2 2.0.16.
        // Once bug #1 is fixed and header auth confirmed working, the path
        // prefix in baseURL can be removed (see TODO above at auth check).
        headers: {
          authorization: `Bearer ${authToken}`
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

  // SHOULD FIX #7: Add idempotency guard + reversed disposal order (LIFO).
  let disposed = false

  // Return cleanup function
  return async () => {
    if (disposed) {
      logger.warn('[v2] Cleanup called twice, ignoring duplicate')
      return
    }
    disposed = true

    // Reverse disposal order — dependents before what they depend on.
    // Proxy server closed LAST relative to provider/tool registrations.
    logger.log('[v2] Cleanup starting', { registrations: registrations.length })
    const reversed = [...registrations].reverse()
    for (const reg of reversed) {
      try {
        await reg.dispose()
      } catch (e) {
        logger.warn('[v2] Registration dispose failed', { error: e })
      }
    }
    logger.log('[v2] Cleanup complete')
  }
}
