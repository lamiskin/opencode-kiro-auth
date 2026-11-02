# src/infrastructure/transformers/

## Responsibility

Pure transforms between OpenAI/Anthropic-style chat payloads and the CodeWhisperer (Kiro) wire format. Covers:

- Request side: tool schema conversion, tool name aliasing, conversation history construction, trimming, and cleanup.
- Response side: AWS event-stream frame extraction, bracket-style `[Called x with args: {...}]` tool call parsing, and reverse tool name mapping.

No I/O, no network, no SDK calls. Stateless except for the per-request `ToolNameRegistry`.

## Design (patterns, abstractions, interfaces)

- `ToolNameRegistry` (tool-transformer.ts): interface `{ toWire(name), toOriginalMap() }`, built by `createToolNameRegistry(tools)`. Request-scoped on purpose so concurrent requests cannot share alias maps.
- Alias scheme: names matching `SAFE_TOOL_NAME_PATTERN` (`^[A-Za-z][A-Za-z0-9_]{0,63}$`) pass through. Others become `<stem>_<sha256[0..32]>` via `generatedAlias`, retrying up to 1024 attempts on collision. Safe names are reserved before generated aliases.
- `restoreToolName(name, map)` is the inverse lookup, guarded with `hasOwnProperty`.
- Schema reduction: `sanitizeCodeWhispererSchema` → recursive `sanitizeSchemaNode` with `depth` cap (`CODEWHISPERER_SCHEMA_MAX_DEPTH = 32`), a `WeakSet` ancestor guard against cycles, and local `$ref` resolution via `resolveLocalReference` (JSON pointer). `allOf` is merged via `mergeSchemas`. `anyOf`/`oneOf` is kept only when it reduces to one unique non-null branch. Otherwise only parent constraints survive.
- `truncateCodePoints` caps descriptions at 1024 code points.
- Dedup: `deduplicateToolCalls` (by `toolUseId`), `deduplicateToolResults` (by `toolUseId`).
- History is a state machine over alternating `userInputMessage` / `assistantResponseMessage` entries. `sanitizeHistory` enforces valid tool_use → tool_result adjacency and strips a leading non-tool-result user turn.
- Hysteresis trimming: `trimHistory` drops in 60-entry blocks, or exactly to cap when `exact=true` (reactive retry). Pairs are kept intact by extending `toDrop` by 2 when a cut would orphan a tool_use/tool_result.
- Message merging: `mergeAdjacentMessages` coalesces same-role neighbours. `buildHistory` merges consecutive assistant turns and inserts `[system: conversation continues]` placeholders where Kiro requires alternation.

## Flow (data in -> key calls -> data out)

Request:
1. OpenAI/Anthropic `tools[]` → `createToolNameRegistry(tools)` → `convertToolsToCodeWhisperer(tools, registry)` → `toolSpecification[]` with sanitized `inputSchema.json`.
2. `messages[]` → `buildHistory(msgs, modelId)` → `CodeWhispererMessage[]`, then `collapseAgenticLoops` strips duplicate preambles from intermediate tool loops.
3. `injectSystemPrompt(history, system, modelId)` prepends the system text to the first user turn.
4. `trimHistory(history, max, exact?)` → `sanitizeHistory` if needed → `historyHasToolCalling` / `extractToolNamesFromHistory` for header decisions.

Response:
1. Raw bytes → `parseAwsEventStreamBuffer(buffer)` → `ParsedEvent[]` (`content`, `toolUse`, `toolUseInput`, `toolUseStop`, `contextUsage`, `meteringEvent`). Frames are found by scanning for known JSON prefixes and brace-matching while respecting strings and escapes.
2. Text content → `parseBracketToolCalls(text)` → `ToolCall[]` with generated `tool_<ts>_<rand>` ids. `cleanToolCallsFromText` removes those spans and normalizes whitespace.
3. Names → `restoreToolName(name, toolNameMap)` back to the original tool name.

## Integration (consumers and dependencies)

Consumers (from import search):
- `src/plugin/request.ts`: imports from history-builder, message-transformer, tool-transformer.
- `src/plugin/response.ts`: `parseAwsEventStreamBuffer`, bracket parser functions.
- `src/plugin/streaming/stream-transformer.ts` and `sdk-stream-transformer.ts`: `parseBracketToolCalls`, `restoreToolName`.
- `src/plugin/streaming/stream-parser.ts`: `parseEventLine`.
- `src/core/request/response-handler.ts`: `restoreToolName`.
- Tests: `history-empty-user`, `history-trim`, `tool-compatibility`, `event-stream-parser`.

Dependencies:
- `history-builder.ts` → `constants.js` (`KIRO_CONSTANTS.ORIGIN_AI_EDITOR`), `plugin/image-handler.js` (`extractAllImages`, `convertImagesToKiroFormat`, `extractTextFromParts`), `plugin/logger.js`, `message-transformer.js` (`getContentText`), `tool-transformer.js` (`deduplicateToolResults`).
- `tool-transformer.ts` → `node:crypto`, `plugin/types.js` (`ToolNameMap`).
- `tool-call-parser.ts` → `plugin/types` (`ToolCall`).
- `event-stream-parser.ts`, `message-transformer.ts`: no internal transformer deps.

Known notes for maintainers:
- `tool-call-parser.ts` dedup/clean regexes are built per call from tool names, so tool names must be regex-escaped (they are).
- `buildHistory` calls `JSON.parse` on string `tool_calls` arguments without try/catch. A malformed argument string throws.
- `parseBracketToolCalls` uses `Date.now()` plus `Math.random()` for ids, so ids are not deterministic across runs.
