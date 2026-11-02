# src/adapters/
## Responsibility

Binds the version-agnostic Kiro runtime to two OpenCode plugin hosts.

- `v1.ts`: legacy OpenCode plugin factory. Exports `createKiroPlugin(id)`, `KiroOAuthPlugin`, and re-exports `collectUsageEntries`, `fetchUsageReport`, `buildTools`.
- `v2.ts`: OpenCode v2 entrypoint `kiroSetup(ctx: V2Context)`. Registers the provider, tools, and `model.request` hook, and fronts requests with a loopback HTTP proxy.

Neither file owns auth, quota, or Kiro API logic. That lives in `core/`, `plugin/`, and `runtime.ts`.

## Design (patterns, abstractions, interfaces)

- Host port injection: each adapter builds a `HostPort` (`notify`, `reauthorize`) and passes it to the runtime. v1 uses `createV1HostPort(client)` (toast via `client.tui.showToast`, OAuth via `client.provider.oauth`). v2 uses `createV2HostPort()` (logger only; `reauthorize` throws, deferred to Phase 5).
- Structural host types: `V2Context`, `ProviderEditor`, `ToolEditor`, `SessionModelRequest`, `ProviderInfo`, `ToolInfo` are declared locally. `@opencode/plugin` is type-only, so there is no runtime coupling.
- Factory with id: `createKiroPlugin(id)` returns `async ({ client, directory })`. `KiroOAuthPlugin = createKiroPlugin('kiro')`.
- Runtime-scoped resources: `createRuntime(directory, port)` returns `runtime` with `authHandler`, `accountManager`, `requestHandler`, `tools`. Each `kiroSetup` call makes a new runtime and a new proxy.
- Disposal: v2 collects `registrations[]` (proxy, provider, hook, tool) and returns an idempotent LIFO cleanup. v1 has no explicit disposal.
- Tool shape mapping: v2 `mapTools` wraps v1-style tools (`toolAny.args`, `execute` returning string) into `Tool.Info`. `input = tool.schema.object(args)`, `output = tool.schema.string()`, errors become `{ output, metadata: { error: true } }`.
- Model shape mapping: v2 `buildV2Models()` turns `buildModelRegistry()` into `Model.Info[]`. Modalities map to `capabilities`, `reasoning` or `-thinking` suffix maps to `compatibility.reasoningField`, and variants map from a Record to an array.

## Flow (data in -> key calls -> data out)

v1 (`createKiroPlugin`):
1. `loadConfig(directory)`, `AccountCache`, `AccountRepository`, `AuthHandler`, `AccountManager.loadFromDisk`, `RequestHandler`.
2. Compute `baseURL` from `KIRO_CONSTANTS.BASE_URL` and `default_region`. Call `initializeRegistry()`.
3. Return hooks: `config` (sets `provider[id].npm`, `api`, `models`), `chat.headers`, `auth.loader` (`authHandler.initialize()`, `refreshRegistry()`, `fetch -> requestHandler.handle`), `provider.models` (normalizes `api.npm` and `api.url`), and `tool: buildTools(...)`.

v2 (`kiroSetup`):
1. `createRuntime(ctx.location.directory, createV2HostPort())`, then `authHandler.setPort`.
2. `createLocalProxyServer(runtime)`: `127.0.0.1:0`, `/k/<uuid>` token prefix, Bearer header also accepted. Only `POST /chat/completions` (or `/v1/...`) is routed. Body cap 50 MB. Tag headers `x-kiro-agent`, `x-kiro-session` (fallback `x-opencode-session-id`), `x-kiro-kind` forwarded. Calls `runtime.requestHandler.handleForced(url, { method, headers, body })`. Response body is piped chunk by chunk and cancelled on client close.
3. `ctx.provider.transform` adds provider `kiro` with package `@opencode/ai/providers/openai-compatible`, `settings.baseURL = proxy URL`, `settings.apiKey = token`, and `headers.authorization = Bearer token`.
4. `ctx.session.hook('model.request')` sets the `x-kiro-*` headers. Optional: skipped if `ctx.session` is absent.
5. `ctx.tool.transform` registers `mapTools(runtime)`. `authHandler.initialize()` runs. `refreshRegistry().then(() => ctx.model.reload())` runs in the background.

Data out: v1 returns a hooks object to OpenCode. v2 returns a cleanup function. Requests in: OpenCode chat calls over HTTP or `fetch`. Requests out: `RequestHandler` to the Kiro API.

## Integration (consumers and dependencies)

Consumers:
- `src/plugin.ts`: re-exports from `adapters/v1.js` (`KiroOAuthPlugin`, `createKiroPlugin`, `collectUsageEntries`, `fetchUsageReport`).
- `src/v2.ts`: re-exports `kiroSetup` from `adapters/v2.js`.
- Tests: `__tests__/adapters/v2.test.ts`, `__tests__/v2-agent-tag.test.ts`, `__tests__/types/v2-conformance.ts`.

Dependencies:
- `runtime.ts` (`createRuntime`, `Runtime`).
- `host/port.ts` (`HostPort`).
- `core/auth/auth-handler.ts`, `core/request/request-handler.ts`.
- `infrastructure/database/account-cache.ts`, `account-repository.ts`.
- `plugin/accounts.ts`, `plugin/auth-bootstrap.ts`, `plugin/config/index.ts`, `plugin/model-registry.ts`, `plugin/logger.ts`.
- `tools.ts` (`buildTools`), `usage.ts` (shared usage logic, re-exported from v1 to keep tools off `adapters/`).
- `constants.ts` (`KIRO_CONSTANTS`).
- External: `@opencode-ai/plugin` (runtime `tool.schema`), `@opencode/plugin` and `@opencode/schema` (types only), `node:http`, global `crypto.randomUUID`.

Notes:
- `v1.ts` and `v2.ts` are independent. Shared logic belongs in `runtime.ts`, `plugin/`, or `core/`.
- Not verified here: whether the v2 header auth path works live. The code comments say the path-prefix token is a fallback.
