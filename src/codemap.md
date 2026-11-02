# src/

## Responsibility

Package root for the OpenCode Kiro auth plugin. Holds the two host entry points (v1 `index.ts`, v2 `v2.ts`), the shared runtime factory (`runtime.ts`), the tool registry (`tools.ts`), the shared usage report (`usage.ts`), the constants and region helpers (`constants.ts`), and the v1 re-export shim (`plugin.ts`). Business logic lives in subfolders; this level wires them together.

## Design (patterns, abstractions, interfaces)

- Entry-point split: `index.ts` default-exports `{ id, server: KiroOAuthPlugin }` (v1 `server` hook shape). `v2.ts` default-exports `{ id, setup: kiroSetup }` (v2 `setup` shape). Both `id` values are `'kiro'`.
- `index.ts` is the v1 entry and is the public package `main` surface, including type exports (`KiroConfig`, `KiroAuthMethod`, `KiroRegion`, `ManagedAccount`).
- `v2.ts` is the v2 entry. The two stay separate because the host contracts differ (`server` vs `setup`). Keeping v1 intact preserves backward compatibility for existing configs, while v2 can change its shape without touching v1 consumers.
- `plugin.ts` is a pure re-export shim over `adapters/v1.js` (`KiroOAuthPlugin`, `createKiroPlugin`, `collectUsageEntries`, `fetchUsageReport`). No logic of its own.
- `runtime.ts` exports the `Runtime` interface and `createRuntime(directory, port: HostPort)`. The `HostPort` seam keeps the core independent of host environment, so adapters differ only in wiring.
- `tools.ts` exports `buildTools(config, accountManager, repository)`, returning a `Record<string, any>` of OpenCode `tool(...)` definitions. Always registers `kiro_usage`. Registers `kiro_web_search` only when `config.web_search_enabled` is true and the current or next account has a `profileArn` (Pro). The gate runs once at build time, so an account switch after startup does not add or remove the tool.
- `usage.ts` is the shared usage logic, pulled out of the v1 adapter to avoid layering inversion (tools must not depend on `adapters/v1`).
- `constants.ts` is a data-plus-pure-helper module: `KIRO_CONSTANTS` (endpoint templates with `{{region}}`, timeouts, UA, SDK versions), `KIRO_AUTH_SERVICE` (auth endpoints and OAuth scopes), `MODEL_MAPPING` (public model id to Kiro model id), and derived sets `SUPPORTED_MODELS`, `CAPPED_272K_MODELS`, `LONG_CONTEXT_MODELS`. Helpers: `isValidRegion`, `normalizeRegion` (falls back to `us-east-1`), `buildUrl` (template fill plus `new URL` validation), `extractRegionFromArn`, `is272KModel`, `isLongContextModel`.

## Flow (data in -> key calls -> data out)

Runtime construction (`createRuntime`):
- `directory` -> `loadConfig(directory)` -> `config`
- `AccountCache(60000)` -> `AccountRepository(cache)`
- `AuthHandler(config, repository)`; `AccountManager.loadFromDisk(config.account_selection_strategy)` -> `setAccountManager`
- `RequestHandler(accountManager, config, repository, port)`
- `baseURL` derived from `KIRO_CONSTANTS.BASE_URL` and `config.default_region || 'us-east-1'`
- `initializeRegistry()` seeds bundled model data (credit multipliers) before the config hook runs
- `buildTools(...)` -> `Runtime { config, repository, authHandler, accountManager, requestHandler, baseURL, tools }`

`kiro_usage` tool:
- `execute()` -> `fetchUsageReport` -> `collectUsageEntries`
- per account: `TokenRefresher.refreshIfNeeded` -> `fetchUsageLimits(toAuthDetails)` -> `updateAccountQuota` -> `summarizeUsage`. Failures become per-account `error` entries (whitespace-collapsed, max 200 chars).
- `repository.batchSave(accounts)` -> `formatUsageReport(entries)` -> string

`kiro_web_search` tool:
- `execute({ query })` -> `kiroWebSearch(accountManager, query)` -> `formatWebSearchResults`
- errors are returned as `"Web search failed: ..."` strings, not thrown

## Integration (consumers and dependencies)

Consumers:
- OpenCode host loads `dist/index.js` (v1) or `v2.ts` via the plugin list. The OpenChamber GUI launch path loads the same build.
- `adapters/v2.ts` consumes `runtime.ts` (`createRuntime`) and `host/port.ts`. `adapters/v1.ts` does not use `runtime.ts`; it wires core, infrastructure and plugin modules directly and re-exports `buildTools` and the `usage.ts` helpers.
- `tools.ts` is the only producer of `Runtime.tools`.
- `constants.ts` is imported across `core/`, `plugin/`, and `kiro/`.

Dependencies:
- `@opencode-ai/plugin` (`tool`, `tool.schema`)
- `./core/auth/token-refresher.js`, `./core/request/request-handler.js`, `./core/auth/auth-handler.js`
- `./infrastructure/database/account-cache.js`, `account-repository.js`
- `./plugin/accounts.js`, `./plugin/config/index.js`, `./plugin/model-registry.js`, `./plugin/usage.js`, `./plugin/sync/kiro-cli.js`, `./plugin/web-search.js`, `./plugin/types.js`
- `./host/port.js` (`HostPort`)
- `./plugin/config/schema` (`RegionSchema`) is the source of valid regions in `constants.ts`

## Subdirectories

| Subfolder | Codemap |
|---|---|
| `adapters/` | [adapters/codemap.md](adapters/codemap.md) |
| `core/` | [core/codemap.md](core/codemap.md) |
| `host/` | [host/codemap.md](host/codemap.md) |
| `infrastructure/` | [infrastructure/codemap.md](infrastructure/codemap.md) |
| `kiro/` | [kiro/codemap.md](kiro/codemap.md) |
| `plugin/` | [plugin/codemap.md](plugin/codemap.md) |

Nested codemaps exist under `core/` (account, auth, request), `infrastructure/` (database, transformers), and `plugin/` (config, storage, streaming, sync). `__tests__/` has no codemap.
