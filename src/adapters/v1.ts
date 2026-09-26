import { KIRO_CONSTANTS } from '../constants.js'
import { AuthHandler } from '../core/auth/auth-handler.js'
import { RequestHandler } from '../core/request/request-handler.js'
import { HostPort } from '../host/port.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from '../plugin/accounts.js'
import { bootstrapAuthIfNeeded } from '../plugin/auth-bootstrap.js'
import { loadConfig } from '../plugin/config/index.js'
import {
  buildModelRegistry,
  initializeRegistry,
  refreshRegistry
} from '../plugin/model-registry.js'
import { buildTools } from '../tools.js'

// Re-export from shared modules for backward compatibility
export { collectUsageEntries, fetchUsageReport } from '../usage.js'

// Re-export buildTools for backward compatibility
export { buildTools } from '../tools.js'

const KIRO_PROVIDER_ID = 'kiro'

/**
 * Creates a v1 HostPort implementation that uses the OpenCode client for
 * notifications and re-authorization.
 */
function createV1HostPort(client: any): HostPort {
  return {
    notify: (message: string, variant: 'info' | 'success' | 'warning' | 'error') => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    },
    reauthorize: async () => {
      await client.provider.oauth.authorize({
        path: { id: 'kiro' },
        body: { method: 0 }
      })

      await client.provider.oauth.callback({
        path: { id: 'kiro' },
        body: { method: 0 }
      })
    }
  }
}

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)

    // Create the v1 HostPort from the client
    const port = createV1HostPort(client)

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    authHandler.setPort(port)

    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, port)

    // Compute the base URL once so both the config hook and auth loader use the same value
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    // Initialize model registry with bundled fallback data immediately.
    // This ensures credit multipliers are available before the config hook runs.
    initializeRegistry()

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        // Always set npm and api — these must be present regardless of whether
        // the user has already defined the provider in their opencode.json.
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        // Set the base URL at the provider level. OpenCode reads provider.api as
        // model.api.url, which resolveSDK() uses to construct the endpoint URL.
        // Only set if not already overridden by the user.
        if (!input.provider[id].api) {
          input.provider[id].api = baseURL
        }
        if (!input.provider[id].models) {
          input.provider[id].models = buildModelRegistry()
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize()

          // Refresh model catalog from remote source after auth is established.
          // This updates credit multipliers with the latest data from kiro.dev.
          // Failures are handled gracefully by the catalog's bundled fallback.
          refreshRegistry().catch(() => {})

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch below intercepts all Kiro
            // API calls, so this value is only used for URL construction.
            baseURL,
            fetch: (input: any, init?: any) => requestHandler.handle(input, init)
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible',
                // Ensure url is always set. modelInfo.api.url should already be
                // populated from the config hook's provider.api field, but we
                // set it explicitly as a fallback for any edge cases.
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      },
      tool: buildTools(config, accountManager, repository)
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
