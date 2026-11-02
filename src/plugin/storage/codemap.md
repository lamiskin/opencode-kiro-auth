# src/plugin/storage/
## Responsibility
Persists Kiro managed accounts in a libsql (SQLite) file, `kiro.db`, under the opencode config dir (`%APPDATA%/opencode` on win32, else `$XDG_CONFIG_HOME` or `~/.config/opencode`). Owns schema creation, schema migrations, cross-process write locking, and account merge/dedupe rules.

Files:
- `sqlite.ts`: `KiroDatabase` class, `DB_PATH`, and the `kiroDb` singleton (`new KiroDatabase()` runs at import time).
- `locked-operations.ts`: `withDatabaseLock`, `mergeAccounts`, `deduplicateAccounts`.
- `migrations.ts`: `runMigrations` and six idempotent `migrate*` steps.

## Design
- Repository-style class. `KiroDatabase` wraps one connection and exposes intent-level methods: `upsertAccount`, `batchUpsertAccounts`, `deleteAccount`, `markAccountsUnhealthy`, `cleanupTestAndStaleAccounts`, `deleteStaleIdcDuplicates`, `getAccounts`.
- Row mapping is two-way: `upsertAccountInternal` maps `ManagedAccount` camelCase to snake_case SQL params, and `rowToAccount` maps back. `rowToAccount` is `private` but used through `.map(this.rowToAccount)`, so `this` is unbound there. It works only because the method does not touch `this`.
- Write path is read-merge-dedupe-write. Each write method reads all rows, merges in memory, dedupes by id, then rewrites every row inside `BEGIN IMMEDIATE` / `COMMIT`, with `ROLLBACK` on error. Full-table rewrite, so cost scales with account count (expected to be small).
- Two-level concurrency control. `withDatabaseLock` takes a `proper-lockfile` lock on the db path (stale 10s, 5 retries with exponential backoff). SQLite `busy_timeout=5000` and `BEGIN IMMEDIATE` cover in-process and cross-process contention.
- `mergeAccounts` takes the max of counters (`usedCount`, `limitCount`, `lastUsed`, `rateLimitResetTime`, `lastSync`). Health is resolved by `isPermanentError` from `../health`. A healthy incoming account clears `unhealthyReason`, `recoveryTime` and `failCount`.
- `deduplicateAccounts` keeps one row per id, preferring the higher `lastUsed`, then the higher `expiresAt`.
- Migrations run on every open. `init()` runs `CREATE TABLE IF NOT EXISTS`, then `runMigrations`. Each step checks `sqlite_master` or `PRAGMA table_info` before acting. Current steps, in order:
  1. `migrateToUniqueRefreshToken`: merges duplicate refresh tokens, then creates a unique index.
  2. `migrateRealEmailColumn`: rebuilds the table to drop `real_email`, or adds missing columns.
  3. `migrateUsageTable`: folds the legacy `usage` table into `accounts`, then drops it.
  4. `migrateStartUrlColumn`: adds `start_url`.
  5. `migrateOidcRegionColumn`: adds `oidc_region` and backfills it from `region`.
  6. `migrateDropRefreshTokenUniqueIndex`: drops that index and removes `(email, refresh_token)` duplicates, preferring non-`kiro-cli-sync-%` ids.
- Lock file is `${dbPath}.lock`. `withDatabaseLock` creates the db file if missing.

## Flow (data in -> key calls -> data out)
- In: `ManagedAccount` objects from the auth/plugin layer, or account ids and emails for deletes and health updates.
- `upsertAccount` / `batchUpsertAccounts`: `withDatabaseLock` -> `getAccounts` + `rowToAccount` -> `mergeAccounts` -> `deduplicateAccounts` -> `BEGIN IMMEDIATE` -> `upsertAccountInternal` per row (`ON CONFLICT(id) DO UPDATE`) -> `COMMIT`.
- `markAccountsUnhealthy(ids, reason)`: one transaction, sets `is_healthy=0`, `fail_count=10`, `rate_limit_reset=0`, `last_sync=now`. Returns early on an empty id list.
- `cleanupTestAndStaleAccounts(staleDays=30)`: deletes placeholder/test emails and unhealthy `Account Suspended` / `ExpiredTokenException` rows past their recovery time. Returns the row-count delta.
- `deleteStaleIdcDuplicates(canonicalId, email, profileArn)`: removes other `idc` rows with the same email+profile, plus `placeholder-%` rows for the same profile.
- Out: `getAccounts()` returns raw rows (`any[]`). Callers that need `ManagedAccount` must map them themselves. `rowToAccount` is not exposed.

## Integration (consumers and dependencies)
- Depends on `libsql` (`Database`, `pragma`, `exec`, `prepare`), `node:fs`, `node:os`, `node:path`, `proper-lockfile`.
- Depends on `../types` (`ManagedAccount`) and `../health` (`isPermanentError`, used by `mergeAccounts`).
- Consumers: the plugin's account-management code imports `kiroDb` or constructs `KiroDatabase(path)` directly, and reads `DB_PATH`. Exact call sites were not traced in this pass.
- Tests: none found in this folder. Migrations and merge rules have no direct coverage here.

Risks noted while reading (not changed):
- `migrateRealEmailColumn` swallows errors in its `catch`, with no rethrow. The table rebuild can fail silently.
- `withDatabaseLock` builds the dir with `lastIndexOf('/')`, which breaks on win32 paths.
- `rowToAccount` depends on not using `this`.
- The `kiroDb` singleton opens the DB on import.
