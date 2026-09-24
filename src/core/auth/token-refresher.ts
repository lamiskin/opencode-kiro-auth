import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

export class TokenRefresher {
  private static refreshLocks = new Map<
    string,
    Promise<{ account: ManagedAccount; shouldContinue: boolean }>
  >()

  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  private async withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const existing = TokenRefresher.refreshLocks.get(accountId)
    if (existing) {
      // A refresh is already in flight for this account; wait for it and adopt its result
      return existing as Promise<T>
    }

    // Start a new refresh for this account
    const promise = fn()
    TokenRefresher.refreshLocks.set(
      accountId,
      promise as Promise<{ account: ManagedAccount; shouldContinue: boolean }>
    )

    try {
      return await promise
    } finally {
      // Clean up the lock entry after the refresh settles (success or failure)
      if (TokenRefresher.refreshLocks.get(accountId) === promise) {
        TokenRefresher.refreshLocks.delete(accountId)
      }
    }
  }

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    return this.withAccountLock(account.id, async () => {
      if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
        return { account, shouldContinue: false }
      }

      try {
        const newAuth = await refreshAccessToken(auth)
        this.accountManager.updateFromAuth(account, newAuth)
        // Persist only the updated account instead of all accounts — avoids
        // invalidating the whole AccountCache on every token refresh.
        await this.repository.save(account)
        return { account, shouldContinue: false }
      } catch (e: any) {
        return await this.handleRefreshError(e, account, showToast)
      }
    })
  }

  async forceRefresh(
    account: ManagedAccount,
    auth: KiroAuthDetails
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    // Use the same lock as refreshIfNeeded to serialize against concurrent refreshes
    // Return same shape as refreshIfNeeded so joining is safe (prevents void/undefined crashes)
    return this.withAccountLock(account.id, async () => {
      if (this.config.auto_sync_kiro_cli) {
        await this.syncFromKiroCli()
      }

      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      const synced = accounts.find((a: ManagedAccount) => a.id === account.id)

      if (synced && synced.accessToken !== account.accessToken) {
        this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
        await this.repository.batchSave(this.accountManager.getAccounts())
        logger.debug('Force refresh: recovered newer token from CLI sync')
        return { account, shouldContinue: false }
      }

      try {
        const newAuth = await refreshAccessToken(auth)
        this.accountManager.updateFromAuth(account, newAuth)
        await this.repository.batchSave(this.accountManager.getAccounts())
        logger.debug('Force refresh: token refreshed via OIDC')
      } catch (e: any) {
        logger.warn('Force refresh failed, will retry with current token', {
          message: e instanceof Error ? e.message : String(e)
        })
      }
      return { account, shouldContinue: false }
    })
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const synced = accounts.find((a: ManagedAccount) => a.id === account.id)

    // IdC refresh tokens are single-use: if kiro-cli refreshed behind our back, the
    // token we just tried is dead but the one it stored is live. The same goes for
    // the client registration: a stale client_id/secret fails with "Client is
    // expired" no matter how fresh the refresh token is. Adopt the synced
    // credentials into the in-memory account (the request loop re-selects from
    // memory, and a later save would otherwise clobber the DB row with our stale
    // values), then retry the refresh with them before giving up on the account.
    if (
      synced &&
      (synced.refreshToken !== account.refreshToken ||
        synced.accessToken !== account.accessToken ||
        synced.clientId !== account.clientId ||
        synced.clientSecret !== account.clientSecret)
    ) {
      const syncedAuth = this.accountManager.toAuthDetails(synced)
      this.accountManager.updateFromAuth(account, syncedAuth)

      if (!accessTokenExpired(syncedAuth, this.config.token_expiry_buffer_ms)) {
        showToast('Credentials recovered from Kiro CLI sync.', 'info')
        return { account, shouldContinue: true }
      }

      try {
        const newAuth = await refreshAccessToken(syncedAuth)
        this.accountManager.updateFromAuth(account, newAuth)
        await this.repository.save(account)
        logger.debug('Refreshed with credentials recovered from Kiro CLI sync')
        return { account, shouldContinue: true }
      } catch (e: any) {
        logger.error('Token refresh with synced credentials failed', {
          email: account.email,
          code: e instanceof KiroTokenRefreshError ? e.code : undefined,
          message: e instanceof Error ? e.message : String(e)
        })
        error = e
      }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
        error.message.includes('Client is expired'))
    ) {
      this.accountManager.markUnhealthy(account, error.code || error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
