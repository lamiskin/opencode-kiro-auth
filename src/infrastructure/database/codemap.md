# src/infrastructure/database/

## Responsibility

Account persistence access layer. Wraps the SQLite account store (`kiroDb` from `plugin/storage/sqlite.js`) with a read-through in-memory cache. Maps DB rows (snake_case) to account objects (camelCase). Two files:

- `account-repository.ts`: `AccountRepository`, the public data-access API.
- `account-cache.ts`: `AccountCache`, the TTL-based in-memory cache.

## Design (patterns, abstractions, interfaces)

- Repository pattern. `AccountRepository` exposes `findAll`, `findById`, `findHealthyAccounts`, `save`, `delete`, `batchSave`, `invalidateCache`. Callers never touch `kiroDb` directly for accounts.
- Cache-aside / read-through. `findAll` checks `cache.getAll()` first, falls back to `kiroDb.getAccounts()`, then calls `cache.setAll()`. `findById` checks `cache.get(id)`, then falls back to `findAll()` and a linear `Array.find`.
- Constructor injection. `AccountRepository(private cache: AccountCache)`. The cache is swappable and testable.
- Row mapping inline in `findAll`. Fields are renamed (`auth_method` to `authMethod`, `is_healthy === 1` to boolean, `fail_count || 0` default). `oidc_region` and `start_url` coerce empty values to `undefined`.
- Write-through with targeted invalidation. `save` calls `kiroDb.upsertAccount` then `cache.invalidate(id)`. `delete` calls `kiroDb.deleteAccount` then `cache.invalidate(id)`. `batchSave` calls `kiroDb.batchUpsertAccounts` then `cache.invalidateAll()`.
- TTL expiry in `AccountCache`. Default `ttlMs = 60000`. `isExpired()` compares `Date.now()` against `lastUpdate`. `getAll()` and `get()` return `null` once expired.
- `AccountCache` holds two stores: a per-id `Map<string, any>` and a snapshot array `allAccountsCache`. `getAll()` returns a shallow copy of the array.
- Types are `any` throughout. No shared `Account` interface exists in this folder.

Caveats seen while reading:
- `invalidate(id)` clears `allAccountsCache` but leaves `lastUpdate` alone. The per-id entries still serve until TTL expiry.
- `setAll()` does not clear stale per-id entries. An account removed from the DB can linger in `cache.get()` until `invalidateAll()` or TTL expiry.
- `get()` uses `||`, so falsy cached values are treated as misses.

## Flow (data in -> key calls -> data out)

Read path:
1. Caller calls `findAll()` or `findById(id)`.
2. `cache.getAll()` or `cache.get(id)` returns data if not expired. Otherwise `null`.
3. On a miss, `kiroDb.getAccounts()` returns raw rows.
4. Rows are mapped to camelCase objects.
5. `cache.setAll(accounts)` stores them. Returns the account array.

Write path:
1. `save(account)` or `delete(id)` runs the DB write first, then invalidates the affected id.
2. `batchSave(accounts)` runs `batchUpsertAccounts`, then `invalidateAll()`.

Derived read:
- `findHealthyAccounts()` calls `findAll()` and filters on `isHealthy`.

## Integration (consumers and dependencies)

Dependencies:
- `../../plugin/storage/sqlite.js`: exports `kiroDb` with `getAccounts`, `upsertAccount`, `deleteAccount`, `batchUpsertAccounts`.
- `./account-cache.js`: `AccountCache`.

Consumers:
- Not verified. I read only the two files in this folder. Callers of `AccountRepository` are outside this scope, so check with a repo-wide search before changing the public method signatures.
