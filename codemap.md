# opencode-kiro-auth/

## Responsibility

OpenCode plugin that exposes Kiro (AWS CodeWhisperer-backed) models as an OpenAI-compatible provider. It handles multi-account OAuth (IAM Identity Center device flow), token refresh, request translation to the Kiro wire format, event-stream conversion back to OpenAI SSE, model catalog and credit-rate lookup, and a usage/quota report.

Two host entry points ship from one codebase:
- `src/index.ts`: v1 plugin shape (`{ id, server }`). Package `main` loads `dist/index.js`.
- `src/v2.ts`: v2 plugin shape (`{ id, setup }`). Kept in a separate file because the v2 host misdetects a dual-export file.

Root-level files are config and build only: `package.json`, `AGENTS.md`, `codemap.md`, and `.slim/codemap.json` (change-detection state for the codemap skill).

## Design (patterns, abstractions, interfaces)

- Ports and adapters. `host/port.ts` defines `HostPort` (`notify`, `reauthorize`). `adapters/v1.ts` and `adapters/v2.ts` implement it for each host. Core code never touches host APIs.
- Layered runtime. `runtime.ts` (`createRuntime`) wires account store, auth handler, request handler and tools. `adapters/` binds that runtime to a host. `core/` owns request and auth logic, and `plugin/` owns Kiro-specific domain logic.
- Two entry files, one runtime. The adapters differ only in wiring, so v1 and v2 share behaviour.
- Data-driven model metadata. `MODEL_CAPABILITIES` (static, in `plugin/model-registry.ts`) is overridden at runtime by a catalog fetched from `kiro.dev/docs/models.md` with a 24h TTL and a bundled fallback.
- Persistence in two layers. `infrastructure/database/` is a read-through cache over `plugin/storage/` (libsql/SQLite, `kiro.db`).

## Flow (data in -> key calls -> data out)

Startup (v1 `createKiroPlugin`, v2 `kiroSetup`):
1. `loadConfig(directory)` reads `kiro.json` (`plugin/config/`).
2. `AccountManager.loadFromDisk()` loads the account pool from storage. `initializeRegistry()` seeds the model registry from bundled data.
3. Host hooks are registered: `config` and `provider` (v1), or `ctx.provider.transform` and `ctx.tool.transform` (v2).

Request (chat call from OpenCode):
1. v1: OpenCode calls the `auth.loader` fetch, which goes to `RequestHandler.handle()`. v2: OpenCode calls a loopback HTTP proxy (`127.0.0.1`, token-prefixed path), which goes to `RequestHandler.handleForced()`.
2. `AccountSelector` picks an account. `TokenRefresher` renews its token if needed.
3. `core/request/` builds the request through `infrastructure/transformers/` and `plugin/request.ts`, then sends it via the Kiro SDK client (`plugin/sdk-client.ts`).
4. `plugin/response.ts` parses the event stream. `plugin/streaming/` converts it to OpenAI or Anthropic SSE.
5. `UsageTracker` records usage. 429 and failures mark the account rate-limited or unhealthy, and `saveToDisk()` persists the change.

Tools and reporting:
- `tools.ts` (`buildTools`) registers `kiro_usage` always, and `kiro_web_search` when enabled for a Pro account.
- `usage.ts` builds the usage report from per-account quota fetches.

## Integration (consumers and dependencies)

Consumers:
- OpenCode v1 and v2 hosts load the plugin. The OpenChamber GUI launch path loads the same build.
- The Usage panel reads the plugin log directory with fixed file-name patterns (`request.json`, `response.json`, `shape.json`).

Dependencies:
- External: `@aws-sdk/client-codewhisperer-streaming`, `@opencode-ai/plugin` (runtime `tool.schema`), `@opencode/plugin` and `@opencode/schema` (types only), Node `http`, `os`, `crypto`.
- Remote: Kiro and CodeWhisperer endpoints (`constants.ts`), `kiro.dev/docs/models.md` for the model catalog, and the Kiro MCP endpoint for web search.
- Local state: `kiro.db` under the opencode config dir, the OpenCode auth file, and the plugin log directory.

Build and test:
- `npm run build` produces `dist/`, which OpenCode loads. Rebuild after any `src/` change, then fully relaunch OpenChamber/OpenCode.
- `bun test` runs the suite under `src/__tests__/`. Panel code is not covered by tests.

## Repository Directory Map

| Directory | Responsibility | Link |
|-----------|----------------|------|
| `src/` | Entry points (v1 `index.ts`, v2 `v2.ts`), runtime, tools, usage, constants | [View Map](src/codemap.md) |
| `src/adapters/` | Binds the runtime to v1 and v2 hosts | [View Map](src/adapters/codemap.md) |
| `src/core/` | Request interception, auth, account selection | [View Map](src/core/codemap.md) |
| `src/core/account/` | Account selection and usage sync | [View Map](src/core/account/codemap.md) |
| `src/core/auth/` | Auth handler, token refresh, IdC login | [View Map](src/core/auth/codemap.md) |
| `src/core/request/` | Request orchestration, retry, response shaping | [View Map](src/core/request/codemap.md) |
| `src/host/` | `HostPort` interface, the host seam | [View Map](src/host/codemap.md) |
| `src/infrastructure/` | Container for transformers and database layers | [View Map](src/infrastructure/codemap.md) |
| `src/infrastructure/database/` | Account repository and read-through cache | [View Map](src/infrastructure/database/codemap.md) |
| `src/infrastructure/transformers/` | OpenAI/Anthropic to CodeWhisperer payload transforms | [View Map](src/infrastructure/transformers/codemap.md) |
| `src/kiro/` | Refresh-token wire format, IdC device-code flow | [View Map](src/kiro/codemap.md) |
| `src/plugin/` | Account pool, request/response translation, model registry, usage | [View Map](src/plugin/codemap.md) |
| `src/plugin/config/` | Config schema, loader, env overrides | [View Map](src/plugin/config/codemap.md) |
| `src/plugin/storage/` | libsql persistence, migrations, write locking | [View Map](src/plugin/storage/codemap.md) |
| `src/plugin/streaming/` | Event-stream to OpenAI/Anthropic SSE conversion | [View Map](src/plugin/streaming/codemap.md) |
| `src/plugin/sync/` | kiro-cli SQLite import and write-back | [View Map](src/plugin/sync/codemap.md) |
