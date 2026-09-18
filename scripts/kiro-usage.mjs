import { AccountCache } from '../dist/infrastructure/database/account-cache.js'
import { AccountRepository } from '../dist/infrastructure/database/account-repository.js'
import { AccountManager } from '../dist/plugin/accounts.js'
import { loadConfig } from '../dist/plugin/config/index.js'
import { fetchUsageReport, collectUsageEntries } from '../dist/plugin.js'

const config = loadConfig(process.cwd())
const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
const repository = new AccountRepository(new AccountCache(60000))

if (process.argv.includes('--json')) {
  const entries = await collectUsageEntries(config, accountManager, repository)
  console.log(JSON.stringify(entries))
} else {
  console.log(await fetchUsageReport(config, accountManager, repository))
}
