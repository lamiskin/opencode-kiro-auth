/**
 * Shared usage reporting logic — extracted from v1 adapter to avoid
 * layering inversion (tools depending on v1 adapter).
 */

import { TokenRefresher } from './core/auth/token-refresher.js'
import type { AccountRepository } from './infrastructure/database/account-repository.js'
import type { AccountManager } from './plugin/accounts.js'
import { syncFromKiroCli } from './plugin/sync/kiro-cli.js'
import {
  fetchUsageLimits,
  formatUsageReport,
  KiroUsageReportEntry,
  summarizeUsage,
  updateAccountQuota
} from './plugin/usage.js'

export async function collectUsageEntries(
  config: any,
  accountManager: AccountManager,
  repository: AccountRepository
): Promise<KiroUsageReportEntry[]> {
  const refresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
  const entries: KiroUsageReportEntry[] = []

  for (const account of accountManager.getAccounts()) {
    try {
      const refreshed = await refresher.refreshIfNeeded(
        account,
        accountManager.toAuthDetails(account),
        () => {}
      )
      const current = refreshed.account
      const usage = await fetchUsageLimits(accountManager.toAuthDetails(current))
      updateAccountQuota(current, usage, accountManager)
      entries.push({
        email: current.email,
        ...summarizeUsage(usage.usedCount || 0, usage.limitCount || 0)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      entries.push({
        email: account.email,
        error: message.replace(/\s+/g, ' ').slice(0, 200)
      })
    }
  }

  await repository.batchSave(accountManager.getAccounts())
  return entries
}

export async function fetchUsageReport(
  config: any,
  accountManager: AccountManager,
  repository: AccountRepository
): Promise<string> {
  const entries = await collectUsageEntries(config, accountManager, repository)
  return formatUsageReport(entries)
}
