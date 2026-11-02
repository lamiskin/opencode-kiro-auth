# src/core/auth/
## Responsibility
Auth orchestration for Kiro accounts. Three non-test modules:
- `auth-handler.ts`: `AuthHandler`, plugin-facing entry. Startup init, CLI sync, startup usage refresh, OAuth method list.
- `idc-auth-method.ts`: `IdcAuthMethod`, IAM Identity Center / Builder ID device-code login.
- `token-refresher.ts`: `TokenRefresher`, access-token refresh with per-account dedupe and error recovery.

## Design (patterns, abstractions, interfaces)
- Constructor injection everywhere. No DI container. `AuthHandler(config, repository)`, plus `setPort(HostPort)` and `setAccountManager(am)` set after construction.
- `TokenRefresher` takes `(config: TokenRefresherConfig, accountManager, syncFromKiroCli, repository)`. `TokenRefresherConfig` is a structural subset: `token_expiry_buffer_ms`, `auto_sync_kiro_cli`, `account_selection_strategy`.
- Single-flight lock: `private static refreshLocks: Map<accountId, Promise<{account, shouldContinue}>>`. `withAccountLock` returns the in-flight promise if one exists. Entry is deleted in `finally` only if it still matches. Static, so shared across all instances in the process.
- Result shape `{ account: ManagedAccount; shouldContinue: boolean }` is returned by every refresh path. Joiners get the same shape, so no void/undefined.
- `IdcAuthMethod.authorize(inputs?)` returns `AuthOuathResult` (`url`, `instructions`, `method: 'auto'`, `callback`). Two-phase: device code now, token poll in `callback`.
- Module helpers: `openBrowser` (execFile, per-platform bin), `normalizeStartUrl` (forces `/start` suffix, strips query/hash), `buildDeviceUrl` (builds `/start/#/device?user_code=`).
- Typing gap: `config: any` and `accountManager: any` in `AuthHandler` and `IdcAuthMethod`. `TokenRefresher` is typed.

## Flow (data in -> key calls -> data out)
- Startup: `AuthHandler.initialize()`
  - If `auto_sync_kiro_cli`: dynamic import `syncFromKiroCli`, `repository.invalidateCache()`, `findAll()`, `accountManager.addAccount()` for each.
  - Background `void` task: `refreshUsageFromApi()` then `logUsageSummary()`, which calls `summarizeUsage` and `notify` after 3 s.
- `refreshUsageFromApi()`: runs once per process (`startupUsageFetched`). Skips when usage tracking is off. For each healthy account: `TokenRefresher.refreshIfNeeded` then `UsageTracker.syncNow`. Errors are logged and the stored value is kept.
- `refreshIfNeeded(account, auth, toast)`: under lock, `accessTokenExpired(auth, buffer)`. If not expired, return unchanged. Otherwise `refreshAccessToken(auth)` (plugin/token), `accountManager.updateFromAuth`, `repository.save(account)`. On error, go to `handleRefreshError`.
- `forceRefresh(account, auth)`: under lock. Optional CLI sync, `invalidateCache`, `findAll`. If a newer token exists, adopt it and `batchSave`. Otherwise refresh via OIDC. Failures are logged and swallowed.
- `handleRefreshError(error, account, toast)`:
  1. Optional CLI sync, then reload from repository.
  2. If the synced `refreshToken`, `accessToken`, `clientId` or `clientSecret` differ, adopt them. If still valid, toast and return `shouldContinue: true`. Else refresh with synced creds.
  3. If the error is `KiroTokenRefreshError` with code `ExpiredTokenException`, `InvalidTokenException`, `ExpiredClientException`, `HTTP_401`, `HTTP_403`, or a message containing a known invalid-grant string: `markUnhealthy`, `batchSave`, return `shouldContinue: true`.
  4. Otherwise log and rethrow.
- Device login: `IdcAuthMethod.authorize(inputs)`
  - Resolve `startUrl` (inputs, then config), `oidcRegion` (idc_region, then ARN region, then default_region).
  - `authorizeKiroIDC(oidcRegion, startUrl)`, build verification URL, `openBrowser`.
  - `callback`: `pollKiroIDCToken` (clientId, clientSecret, deviceCode, interval, expiresIn), then profileArn (inputs, config, `readActiveProfileArnFromKiroCli`).
  - `fetchUsageLimits`. On failure: throw if startUrl without profileArn. Treat `FEATURE_NOT_SUPPORTED` as zero usage. Otherwise rethrow.
  - Email: usage.email, else JWT payload `email`/`sub` (unverified decode), else `makePlaceholderEmail`.
  - Build `ManagedAccount` (id from `createDeterministicAccountId`), `repository.save`, `accountManager.addAccount`. Return `{ type: 'success', key: accessToken }`.
- `getMethods()`: returns two OAuth methods, both bound to `IdcAuthMethod.authorize`.
  - "AWS Builder ID / IAM Identity Center": prompts `start_url`, `idc_region`.
  - "IAM Identity Center with Profile ARN": adds `profile_arn` prompt.
  - Validation: `RegionSchema.safeParse`, URL parse, ARN prefix `arn:aws:codewhisperer:` or `arn:aws:qdeveloper:`.

## Integration (consumers and dependencies)
- Dependencies:
  - `infrastructure/database/account-repository`: `save`, `batchSave`, `findAll`, `invalidateCache`
  - `kiro/auth` (`accessTokenExpired`), `kiro/oauth-idc` (`authorizeKiroIDC`, `pollKiroIDCToken`)
  - `plugin/token` (`refreshAccessToken`), `plugin/accounts` (`AccountManager`, `createDeterministicAccountId`)
  - `plugin/errors` (`KiroTokenRefreshError`), `plugin/logger`, `plugin/types`
  - `plugin/usage` (`fetchUsageLimits`, `summarizeUsage`), `plugin/config/schema` (`RegionSchema`)
  - `plugin/sync/kiro-cli` (`syncFromKiroCli`, dynamic import), `plugin/sync/kiro-cli-parser`, `plugin/sync/kiro-cli-profile`
  - `constants` (region helpers), `host/port` (`HostPort.notify`), `account/usage-tracker` (`UsageTracker.syncNow`)
  - External types: `@opencode-ai/plugin` (`AuthHook`, `AuthOuathResult`)
- Consumers: not verified. I did not grep for importers. Likely the plugin entry wiring `AuthHandler` and calling `setPort`, `setAccountManager`, `initialize`, `getMethods`.
- Side effects: `openBrowser` spawns an OS process. Lock map is process-global. `setTimeout` toasts in `logUsageSummary`.
- Minor inconsistency: `idc-auth-method.ts` uses `.js` import suffixes, `token-refresher.ts` has none.
