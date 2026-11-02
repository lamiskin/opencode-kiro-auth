# src/plugin/
## Responsibility

Plugin core for the Kiro provider inside OpenCode. It owns account pooling and selection, token refresh, request translation into the CodeWhisperer/Kiro wire format, response and event-stream parsing, model catalog and registry generation, effort and thinking configuration, usage and quota reporting, image and web-search helpers, and logging. Persistence and stream conversion live in subfolders (see table below).

## Design (patterns, abstractions, interfaces)

- `AccountManager` (accounts.ts, lines 28-318) is the stateful pool. Public methods include `loadFromDisk()` (static), `getCurrentOrNext()`, `updateUsage()`, `addAccount()`, `removeAccount()`, `updateFromAuth()`, `markRateLimited()`, `markUnhealthy()`, `saveToDisk()`, and `toAuthDetails()`. The constructor takes a `strategy` (default `'sticky'`), which is typed as `AccountSelectionStrategy`.
- Shared shapes live in types.ts: `KiroAuthDetails`, `ManagedAccount`, `RefreshParts`, `CodeWhispererRequest`, `PreparedRequest`, `SdkPreparedRequest`, `ParsedResponse`, `ToolCall`, plus the `KiroAuthMethod`, `KiroRegion`, `Effort` aliases.
- Request building is a two-stage pipeline. `buildCodeWhispererRequest()` (request.ts, lines 54-307) builds the shared body. Two thin wrappers then specialize it:
  - `transformToCodeWhisperer()` (request.ts, line 309) returns a raw HTTP `PreparedRequest` with the Kiro headers (`amz-sdk-invocation-id`, `x-amzn-kiro-agent-mode: vibe`, the aws-sdk-js user agent).
  - `transformToSdkRequest()` (request.ts, line 354) returns an `SdkPreparedRequest` and applies history trimming through `trimHistory()`. It runs a proactive trim for non-OpenAI models when `maxHistoryEntries` is set, and a reactive trim when `historyCapOverride` is passed.
- `createSdkClient()` (sdk-client.ts, lines 21-81) caches `CodeWhispererStreamingClient` instances in `clientCache`, keyed by `region:email:effort:provider`. It adds two build-step middlewares: `addKiroHeaders`, and `addEffortConfig`. The second rewrites the JSON body to `reasoning.effort` for OpenAI models or `additionalModelRequestFields.output_config.effort` for Claude models. `KIRO_CLI_MAX_ATTEMPTS` sets the retry cap.
- Effort logic is in effort.ts: `resolveEffort`, `getEffectiveEffort`, `budgetToEffort`, `supportsEffort`, `supportsXHighEffort`, and the constant tables `EFFORT_LEVELS`, `THINKING_BUDGETS`, `EFFORT_CAPABLE_MODELS`, `XHIGH_CAPABLE_MODELS`. Effort capability is checked on the resolved Kiro model ID, not the OpenCode-facing ID.
- Model metadata is data-driven. `MODEL_CAPABILITIES` (model-registry.ts, lines 63-213) is a static table of `ModelCapabilities`, and the `CONTEXT_*` and `MULTIMODAL` constants are its building blocks. `buildModelRegistry()` (model-registry.ts, lines 253-340) turns that table into the OpenCode model map. It adds `-thinking`, `-272k`, `-100k`, and `-100k-thinking` variants, and sets `reasoning` and `interleaved.field = 'reasoning_content'` on reasoning entries. Credit-rate labels come from `getModelRate()`/`rateLabel()`.
- Catalog is cached and fetched lazily. model-catalog.ts holds `BUNDLED_MODEL_CATALOG` as a fallback, `refreshModelCatalog()` (with `MODEL_CATALOG_TTL_MS`), `parseModelsMarkdown()`, and `getModelCatalogEntry()`. Rate tiers live in model-rate.ts (`effectiveRate`, `rateForLog`, `TIERS`). Context windows come from models.ts (`refreshContextWindowSizes`, `getContextWindowSize`, `resolveKiroModel`), with `DEFAULT_CONTEXT_WINDOW` as the fallback.
- Response parsing (response.ts) is layered. `parseEventStream()` (lines 11-34) merges `parseEventStreamChunk()` output with `parseBracketToolCalls()`, then runs `deduplicateToolCalls()` and `cleanToolCallsFromText()`. `estimateTokens()` is a rough local counter.
- Errors and health: `KiroTokenRefreshError` (errors.ts) carries an optional `code`. `isPermanentError()` (health.ts) decides whether an account is dead or only temporarily unhealthy.

## Flow (data in -> key calls -> data out)

1. Startup: `AccountManager.loadFromDisk()` reads the account store. `bootstrapAuthIfNeeded()` (auth-bootstrap.ts) imports OpenCode auth via `readAuthFile()`/`writeAuthFile()`. `initializeModelCatalog()` and `initializeRegistry()` seed the catalog and the model registry.
2. Request: the OpenAI or Anthropic body arrives. `getCurrentOrNext()` picks an account. `refreshAccessToken()` (token.ts) renews the token when needed. `transformToSdkRequest()` (or `transformToCodeWhisperer()`) builds the wire body, using `getEffectiveEffort()` and the history trim. Images go through `convertImagesToKiroFormat()` (image-handler.ts).
3. Send: `createSdkClient()` returns a cached client. The middlewares add headers and effort config. The SDK call or raw fetch goes out.
4. Response: `parseEventStream()` turns the raw event stream into `ParsedResponse` (content, `toolCalls`, `stopReason`, token counts). The `streaming/` folder converts it to OpenAI or Anthropic SSE.
5. Accounting: `updateUsage()` and `updateAccountQuota()` (usage.ts) record usage. On 429 or failure, `markRateLimited()` or `markUnhealthy()` runs. `saveToDisk()` persists the change.
6. Reporting: `fetchUsageLimits()` and `summarizeUsage()` feed `formatUsageReport()`. `kiroWebSearch()` (web-search.ts) calls the MCP endpoint `MCP_TARGET` and formats results with `formatWebSearchResults()`.

## Integration (consumers and dependencies)

Subdirectories:

| Folder | Role | Codemap |
|---|---|---|
| sync/ | Kiro CLI sync, profile and token parsing, stale-account pruning | [sync/codemap.md](sync/codemap.md) |
| streaming/ | Event-stream parsing and OpenAI/Anthropic stream conversion | [streaming/codemap.md](streaming/codemap.md) |
| storage/ | SQLite persistence, migrations, locked operations | [storage/codemap.md](storage/codemap.md) |
| config/ | Config schema, loader, and index | [config/codemap.md](config/codemap.md) |

Upstream consumers: the OpenCode plugin entry point calls `AccountManager`, `buildModelRegistry()`, and the request and response transforms. I did not trace the exact import sites, so treat that list as unverified.

External dependencies:
- `@aws-sdk/client-codewhisperer-streaming` (`CodeWhispererStreamingClient`), used by sdk-client.ts.
- Node `os` and `crypto` (`randomUUID`), and `process.version`, used by request.ts.
- Remote endpoints: `https://q.<region>.amazonaws.com` (sdk-client.ts), `KIRO_CONSTANTS.BASE_URL` (request.ts), `MODEL_CATALOG_URL` (model-catalog.ts), and `MCP_TARGET` (web-search.ts). Endpoints come from constants, not env.
- Local state: the account store (via accounts.ts and storage/), the OpenCode auth file (auth-bootstrap.ts), and the plugin log directory (logger.ts `getLogDir()`, with `rotatePluginLog()` and `pruneOldLogs()`). Logs run through `redactRequestContent()` before writing.

Cross-file hot spots:
- Model IDs go through `resolveKiroModel()` before any capability or effort lookup. Mixing the OpenCode-facing ID with the Kiro ID is the most likely bug source.
- `model-registry.ts` documents that `reasoning` and `interleaved` must stay set on `-thinking` entries. Without them OpenCode drops reasoning chunks.
