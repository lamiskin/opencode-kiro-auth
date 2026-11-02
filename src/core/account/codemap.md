# src/core/account/
## Responsibility

Account-level policy for choosing which Kiro account serves a request and for keeping per-account usage numbers fresh. Two modules:

- `account-selector.ts`: `AccountSelector`. Picks a healthy account, handles empty-pool recovery, rate-limit waits, and a circuit breaker.
- `usage-tracker.ts`: `UsageTracker`. Pulls usage/quota for an account, throttled per account, with retry and health marking.

Storage, token handling, and rate-limit state live outside this folder in `plugin/accounts`, `plugin/usage`, and `infrastructure/database/account-repository`.

## Design (patterns, abstractions, interfaces)

- Constructor injection only. No singletons. Dependencies are typed structurally or by import type:
  - `AccountManager` (`plugin/accounts`): in-memory pool and rate-limit state.
  - `AccountRepository` (`infrastructure/database/account-repository`): persistence.
  - `AccountSelectorConfig` / `UsageTrackerConfig`: local interfaces, subsets of the global config.
  - `syncFromKiroCli: () => Promise<void>`: injected callback, so the selector does not import the CLI sync code.
- `ToastFunction` is injected per call to `selectHealthyAccount`, so the UI layer owns presentation.
- Per-instance state:
  - `AccountSelector`: `triedEmptySync` (one-shot), `circuitBreakerTrips`, `lastCircuitBreakerReset`.
  - `UsageTracker`: `lastSyncTime: Map<accountId, epochMs>` and `cooldownMs` (default 60000, from `usage_sync_cooldown_ms`).
- Circuit breaker: trips increment on each "no account available" pass. The counter resets after 60 s of quiet time, or on the next successful selection. At 10 trips, `checkCircuitBreaker` throws.
- Retry: exponential backoff in `UsageTracker.syncWithRetry`, delay `1000 * 2^attempt` ms, up to `usage_sync_max_retries`. Rate-limit errors (`429`, `ThrottlingException`, `TooManyRequests`) are never retried.
- Fire-and-forget: `syncUsage` returns before the fetch completes. Errors go to `logger.warn`.
- Interfaces are narrow. The selector uses `getAccountCount`, `getCurrentOrNext`, `getMinWaitTime`, `shouldShowToast`, `shouldShowUsageToast`, and `addAccount`. The tracker uses `markUnhealthy`, `getAccounts`, and `save`/`batchSave`.

## Flow (data in -> key calls -> data out)

`AccountSelector.selectHealthyAccount(showToast)`:
1. `checkCircuitBreaker()` may throw `Circuit breaker tripped`.
2. `getAccountCount()`. If 0 and `auto_sync_kiro_cli` is set and not yet tried, call `handleEmptyAccounts()`: `syncFromKiroCli()`, then `repository.invalidateCache()`, then `repository.findAll()`, then `addAccount` for each.
3. Count still 0: throw `No accounts`.
4. `getCurrentOrNext()`. If null:
   - Increment the trip counter.
   - If `getMinWaitTime()` is in (0, 30000) ms: optional warning toast, `sleep(wait)`, return `null`.
   - Otherwise throw `All accounts are unhealthy or rate-limited: reauth required`.
5. Otherwise `resetCircuitBreaker()`. If `used/limit >= 0.9` and `shouldShowUsageToast()`, emit a usage warning via `summarizeUsage`.
6. Return the `ManagedAccount`.

`UsageTracker.syncUsage(account, auth)`:
1. Return early if `usage_tracking_enabled` is false or the cooldown has not elapsed.
2. Stamp `lastSyncTime`, then call `syncWithRetry(account, auth, 0)` without awaiting.

`syncWithRetry` -> `syncNow`:
1. `fetchUsageLimits(auth)` (`plugin/usage`).
2. `updateAccountQuota(account, u, accountManager)`.
3. `repository.batchSave(accountManager.getAccounts())`.
4. On error:
   - Rate limit: log and return. No health change.
   - `FEATURE_NOT_SUPPORTED`: return silently. Some IDC profiles lack `getUsageLimits`.
   - `403`, `invalid`, or `bearer token`: `markUnhealthy`, then `repository.save(account)` (errors swallowed).
   - Otherwise: rethrow to the caller's catch, which logs.

`syncNow` is public and bypasses the cooldown and retry. The startup refresh calls it directly.

Data out: a `ManagedAccount` (or `null` after a wait), or side effects on the account pool, quota fields, health, and persistence.

## Integration (consumers and dependencies)

Depends on:
- `plugin/accounts` (`AccountManager`): pool, rate-limit timing, toast throttling, health.
- `plugin/usage`: `summarizeUsage`, `fetchUsageLimits`, `updateAccountQuota`.
- `plugin/logger`: `warn`.
- `plugin/types`: `ManagedAccount`, `KiroAuthDetails`.
- `infrastructure/database/account-repository`: `findAll`, `invalidateCache`, `save`, `batchSave`.

Consumed by:
- The request path, which calls `selectHealthyAccount` before each upstream call and must handle the `null` return (retry the selection).
- Plugin startup, which calls `UsageTracker.syncNow` for the initial quota refresh and handles token refresh and fallback itself.
- Post-request handling, which calls `syncUsage` for background refresh.

Notes for maintainers:
- `AccountSelectorConfig.account_selection_strategy` (`sticky` | `round-robin` | `lowest-usage`) is declared but not read in this folder. Strategy is presumably applied inside `AccountManager.getCurrentOrNext`.
- `UsageTracker.syncUsage` may leave `lastSyncTime` set after a failed sync, so a failed account waits a full cooldown before retrying.
- The `sleep` helper is duplicated in both classes.
- The selector's 30 s wait ceiling is a hard-coded constant, not config.
