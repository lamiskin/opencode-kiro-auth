# src/plugin/sync/
## Responsibility
Imports credentials from the local kiro-cli SQLite store (`data.sqlite3`) into the plugin's account DB, and writes refreshed tokens back. Also marks cached accounts stale when the CLI has replaced them.

Files:
- `kiro-cli.ts`: `syncFromKiroCli()`, `writeToKiroCli()`. Main entry points.
- `kiro-cli-parser.ts`: pure helpers. `getCliDbPath()`, `safeJsonParse()`, `normalizeExpiresAt()`, `findClientCredsRecursive()`, `makePlaceholderEmail()`.
- `kiro-cli-profile.ts`: `readActiveProfileArnFromKiroCli()`, reads `state` row `api.codewhisperer.profile`.
- `stale-accounts.ts`: `getStaleKiroCliAccountIds()`, `SyncedCliAccount`, `STALE_CLI_ACCOUNT_REASON`.

## Design (patterns, abstractions, interfaces)
- Procedural module, no classes. Each function opens its own `libsql` Database handle.
- Read-only handles for reads (`new Database(path, { readonly: true })`). The write path in `writeToKiroCli` opens a read-write handle.
- Key-based row selection. `auth_kv` rows are matched by key substring (`:token`, `odic`, `device-registration`).
- Legacy filter: when any `kirocli:` key exists, `codewhisperer:` rows are dropped.
- Credential resolution order for IDC: row fields first, then `findClientCredsRecursive()` over the device-registration JSON (DFS with a visited set).
- Account identity is `createDeterministicAccountId(email, authMethod, clientId, profileArn)`. Placeholder emails from `makePlaceholderEmail()` are a SHA-256 derived `<method>-placeholder+<hash>@awsapps.local`.
- `SyncedCliAccount` is the only shared type. It carries identity fields into the stale-account pass.
- Stale rule (`getStaleKiroCliAccountIds`): an account not in the synced set is stale if auth method matches and (email, clientId or profileArn match, or it has `lastSync > 0`). It is also stale if its `unhealthyReason` is a permanent error and identity matches.
- Region split: `serviceRegion` (from profileArn, else `data.region`) is used for the Q API. `oidcRegion` (from `data.region`) is used for token refresh.
- Expiry: `normalizeExpiresAt()` treats numbers under 1e10 as seconds. Unparseable expiry becomes `0`, which forces refresh.

## Flow (data in -> key calls -> data out)
`syncFromKiroCli()`:
1. `getCliDbPath()` (env `KIROCLI_DB_PATH` override, else per-platform path). Returns early if missing.
2. Read all `auth_kv` rows. Read active profile ARN from `state`.
3. For each `:token` row with a refresh token:
   - Resolve clientId/clientSecret, serviceRegion, oidcRegion, startUrl, cliExpiresAt.
   - `fetchUsageLimits()` (from `../usage`) gives usedCount, limitCount, email. Failure falls back to a placeholder.
   - Reuse an existing email from `kiroDb.getAccounts()` matched by profileArn or clientId.
   - Skip if the stored row is healthy, unexpired, same oidcRegion and same client registration.
   - If usage succeeded, migrate a placeholder-id row into the real id (marked unhealthy, "Replaced by real email").
   - `kiroDb.upsertAccount()` with `isHealthy: true`. For IDC with a profileArn, call `kiroDb.deleteStaleIdcDuplicates()`.
4. Compute stale IDs with `getStaleKiroCliAccountIds()`. Call `kiroDb.markAccountsUnhealthy()`.
5. Close the CLI handle. Errors are caught and logged (`logger.error`).

Output: rows in the plugin account store (`../storage/sqlite`). Nothing is returned.

`writeToKiroCli(acc)`:
- Picks `kirocli:odic:token` (idc) or `kirocli:social:token`. Updates access_token, refresh_token, and expires_at (ISO string) on that row. Errors are logged as warnings.

## Integration (consumers and dependencies)
Depends on:
- `libsql` (SQLite driver), `node:fs`, `node:os`, `node:path`, `node:crypto`.
- `../../constants`: `extractRegionFromArn`, `normalizeRegion`.
- `../accounts`: `createDeterministicAccountId`.
- `../storage/sqlite`: `kiroDb` (`getAccounts`, `upsertAccount`, `deleteStaleIdcDuplicates`, `markAccountsUnhealthy`).
- `../usage`: `fetchUsageLimits`.
- `../health`: `isPermanentError` (used by stale-accounts).
- `../logger`.

Consumers (not checked in this pass): callers of `syncFromKiroCli` and `writeToKiroCli` outside this folder. Run a grep for these names to confirm.

Notes from reading (not fixed, report only):
- `resolvedEmail.startsWith('placeholder-')` in `kiro-cli.ts` does not match the real placeholder format `<method>-placeholder+...`. The reuse branch may never run.
- `cliDb` in `syncFromKiroCli` is not closed if an exception is thrown before line 283. `writeToKiroCli` has the same issue.
- `kiroDb.getAccounts()` is re-read for each row, inside the loop.
- `writeToKiroCli` overwrites `expires_at` as ISO text, while the reader accepts numbers, ISO strings and numeric strings.
