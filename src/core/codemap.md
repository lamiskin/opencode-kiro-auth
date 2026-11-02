# src/core/

## Responsibility

Core runtime of the Kiro auth plugin. Intercepts outbound requests to the Kiro API, attaches and refreshes credentials, picks a healthy account, tracks usage, and turns upstream responses and errors into something OpenCode can consume. Barrel entry is `index.ts`, which re-exports every module in `account/`, `auth/` and `request/`. Top-level files in this folder are only the barrel; the logic lives in the three subfolders.

## Design (patterns, abstractions, interfaces)

- Class-per-concern. Each file exports one class: `RequestHandler`, `ResponseHandler`, `ErrorHandler`, `RetryStrategy` (request/), `AuthHandler`, `TokenRefresher`, `IdcAuthMethod` (auth/), `AccountSelector`, `UsageTracker` (account/).
- Config objects over positional args. Each class takes a typed config interface: `ErrorHandlerConfig`, `RetryConfig`, `TokenRefresherConfig`, `UsageTrackerConfig`, `AccountSelectorConfig`. Shared per-call shapes are `RequestContext`, `RetryContext`, `AccumulatedToolCall`.
- Callback injection for UI. `ToastFunction` is declared in `account-selector.ts`, `token-refresher.ts` and `error-handler.ts`, so toasts are passed in by the caller rather than imported.
- Pure helpers stay module-private. `readBody` in `error-handler.ts`, and `openBrowser`, `normalizeStartUrl`, `buildDeviceUrl` in `idc-auth-method.ts`, are not exported.
- Retry is a decision object, not a loop. `RetryStrategy.shouldContinue(context)` returns `{ canContinue, error? }`; `createContext()` builds the initial `RetryContext`. The caller owns the loop.
- Constants gate behaviour. `KIRO_API_PATTERN` (URL match) and `REAUTH_FAILURE_COOLDOWN_MS` (throttle for re-auth after failure) live at the top of `request-handler.ts`.
- Two-phase refresh. `TokenRefresher.refreshIfNeeded()` is the cheap check on the hot path; `forceRefresh()` is used after a 401/403.
- SDK vs. raw paths. `ResponseHandler` splits SDK responses into `handleSdkSuccess` → `handleSdkStreaming` or `handleSdkNonStreaming`, so streaming and buffered bodies share one entry point.

## Flow (data in -> key calls -> data out)

Outbound request:
1. `RequestHandler.handle(input, init)` (or `handleForced` to skip cache) receives the fetch-style call. Non-Kiro URLs (not matching `KIRO_API_PATTERN`) pass through.
2. `AccountSelector.selectHealthyAccount(showToast)` returns a `ManagedAccount` or `null`. An empty pool goes through the private `handleEmptyAccounts()`.
3. `TokenRefresher.refreshIfNeeded()` returns fresh `KiroAuthDetails`. It calls `forceRefresh()` on auth failure.
4. The request is sent. On a 2xx, `ResponseHandler` reshapes the body (`handleSdkSuccess`). `UsageTracker.syncUsage()` runs, with `syncNow()` for an immediate sync.
5. On failure, `ErrorHandler.handle()` classifies the response. `handleNetworkError()` covers transport errors. `RetryStrategy.shouldContinue()` decides whether to loop back to step 2.

Login:
1. `AuthHandler.initialize()` binds the callback server, using `setPort(HostPort)` to set the port.
2. `IdcAuthMethod.authorize(inputs?)` runs the IAM Identity Center device flow. It builds the URL with `buildDeviceUrl`, normalises the start URL, and opens the browser with `openBrowser`.
3. Output is an `AuthOuathResult`, which the caller stores on the account.

Data out: `Response` objects to OpenCode, `ManagedAccount` and `KiroAuthDetails` to the account store, and toasts through the injected callback.

## Integration (consumers and dependencies)

Consumers:
- No file in `src/` imports `core/index.ts`. The v1 and v2 adapters import `RequestHandler` and `AuthHandler` from their own module paths (`core/request/request-handler.js`, `core/auth/auth-handler.js`), so the barrel is currently unused.
- `ErrorHandler` and `ResponseHandler` being used only from `RequestHandler` is not verified.

Dependencies:
- `ManagedAccount` and `KiroAuthDetails` types from the account and auth model modules, outside this folder.
- Account state comes from `AccountSelector` and `UsageTracker`. Both depend on the account store.
- `TokenRefresher` and `IdcAuthMethod` call the Kiro/AWS OIDC endpoints. Endpoints come from config or env, not literals.
- Standard `fetch`/`Response` and the Node/Bun runtime for browser open and the callback server.

Notes:
- `index.ts` uses `export *`, so any new export in a submodule is public. Keep helpers unexported.
- `ToastFunction` is declared in three files. Consider one shared declaration.

## Subdirectories

| Folder | Codemap | Contents |
|---|---|---|
| `request/` | [request/codemap.md](request/codemap.md) | Request interception, response shaping, error classification, retry |
| `auth/` | [auth/codemap.md](auth/codemap.md) | Login flows, token refresh |
| `account/` | [account/codemap.md](account/codemap.md) | Account selection, usage sync |
