import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { HostPort } from './host/port.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'
import { initializeRegistry } from './plugin/model-registry.js'
import { buildTools } from './tools.js'

export interface Runtime {
  config: any
  repository: AccountRepository
  authHandler: AuthHandler
  accountManager: AccountManager
  requestHandler: RequestHandler
  baseURL: string
  tools: Record<string, any>
}

/**
 * Creates the Kiro runtime — the generation-agnostic core that handles
 * account management, auth, and request handling.
 *
 * This function encapsulates all the construction logic that was previously
 * inlined in createKiroPlugin, extracting it behind a HostPort seam so the
 * same core works under different host environments.
 */
export async function createRuntime(directory: string, port: HostPort): Promise<Runtime> {
  const config = loadConfig(directory)

  const cache = new AccountCache(60000)
  const repository = new AccountRepository(cache)

  const authHandler = new AuthHandler(config, repository)
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
  authHandler.setAccountManager(accountManager)

  // RequestHandler receives the HostPort for notifications and reauthorization
  const requestHandler = new RequestHandler(accountManager, config, repository, port)

  // Compute the base URL once so both the config hook and auth loader use the same value
  const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
    '{{region}}',
    config.default_region || 'us-east-1'
  )

  // Initialize model registry with bundled fallback data immediately.
  // This ensures credit multipliers are available before the config hook runs.
  initializeRegistry()

  const tools = buildTools(config, accountManager, repository)

  return {
    config,
    repository,
    authHandler,
    accountManager,
    requestHandler,
    baseURL,
    tools
  }
}
