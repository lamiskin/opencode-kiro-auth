# src/plugin/streaming/

## Responsibility

Turns raw Kiro upstream streams into OpenAI-compatible chat completion chunks. Handles three jobs: parsing Kiro event frames, splitting inline `<thinking>` reasoning from text, and accumulating tool calls. Output feeds `@ai-sdk/openai-compatible` consumers.

Files:
- `sdk-stream-transformer.ts`: `transformSdkStream`, the active path. Consumes SDK events from `sdkResponse.generateAssistantResponseResponse`.
- `stream-transformer.ts`: `transformKiroStream`, the legacy raw-`Response` path. It parses the byte stream itself via `parseStreamBuffer`.
- `stream-parser.ts`: `parseStreamBuffer` (brace-matching JSON extraction from raw bytes) and `findRealTag` (tag lookup that skips fenced code blocks).
- `stream-state.ts`: block bookkeeping. `ensureBlockStart`, `stopBlock`, `createTextDeltaEvents`, `createThinkingDeltaEvents`.
- `openai-converter.ts`: `convertToOpenAI`, maps Anthropic-style events to `chat.completion.chunk` objects or `null`.
- `types.ts`: `StreamEvent`, `StreamState`, `ToolCallState`, `THINKING_START_TAG`, `THINKING_END_TAG`.
- `index.ts`: barrel. Re-exports `findRealTag` and `transformKiroStream` only.

## Design

- Event-as-data pipeline. Stream handlers emit Anthropic-shaped `StreamEvent` objects (`content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`). `convertToOpenAI` is the single translation point to OpenAI chunks.
- Mutable `StreamState` per request. Holds `buffer`, `inThinking`, `thinkingExtracted`, `thinkingBlockIndex`, `textBlockIndex`, `nextBlockIndex`, and `stoppedBlocks` (a Set that makes `stopBlock` idempotent).
- Lazy block creation. `ensureBlockStart` opens a thinking or text block on first use and returns `[]` if it already exists.
- Streaming tag scrubber. The `<thinking>` scanner keeps `THINKING_START_TAG.length` / `THINKING_END_TAG.length` bytes in `buffer` so a split tag is not emitted as text. `findRealTag` skips matches inside ``` fences.
- Native reasoning wins over tags. In `sdk-stream-transformer.ts`, `reasoningContentEvent` sets `sawNativeReasoning`. The first `assistantResponseEvent` then closes the thinking block and bypasses tag scraping. Tag scraping remains the fallback.
- Tool calls are accumulated, then emitted at end. `toolCallFragments` (Map) plus `toolCallOrder` in the SDK path. `toolCalls` array with `currentToolCall` in the legacy path. Emitted as `content_block_start`, `input_json_delta`, and `content_block_stop` after the text block closes.
- Fail-fast error chunks. `errorChunk` yields `{ error: { message, type, code } }` and returns early for in-band `event.error`, `invalidStateEvent`, and truncated reasoning (`kiro_stream_truncated`). This stops the SDK from reporting a generic "Failed to process successful response".
- `StreamFinalUsage` is returned as the generator's return value so the caller can read metering and token counts.

## Flow

Data in:
- SDK path: `transformSdkStream(sdkResponse, model, conversationId, toolNameMap?)`. Each event is one of `reasoningContentEvent`, `assistantResponseEvent.content`, `toolUseEvent`, `error`, `invalidStateEvent`, `metadataEvent`, `contextUsageEvent`, or `meteringEvent`.
- Legacy path: `transformKiroStream(response: Response, ...)`. Reads `response.body` via TextDecoder, then `parseStreamBuffer(rawBuffer)` returns `{ events, remaining }`.

Key calls, in order:
1. Content event: `buffer += text`, then the tag loop runs `findRealTag(buffer, THINKING_START_TAG)` and `findRealTag(buffer, THINKING_END_TAG)`. It builds deltas with `createTextDeltaEvents` and `createThinkingDeltaEvents`.
2. Tool events: `restoreToolName(name, toolNameMap)` from `infrastructure/transformers/tool-transformer.js` maps names back. Fragments are merged by `toolUseId`.
3. End of stream: flush `buffer`, then `parseBracketToolCalls(totalContent)` from `infrastructure/transformers/tool-call-parser.js` for inline bracket tool calls. Emit the credits footer `_Credits Used: X.XX_` only on the final step of a turn (no tool calls), showing the turn's total credits. Totals are kept per session in `credits-footer.ts`.
4. Usage: `estimateTokens(textOnlyContent)` from `plugin/response.js` when no token metadata arrives. `getContextWindowSize(model)` from `plugin/models.js` derives input tokens from `contextUsagePercentage`.
5. Terminate with `message_delta` (stop reason `tool_use` or `end_turn`) and `message_stop`.

Data out:
- Async generator of OpenAI chunk objects (`object: 'chat.completion.chunk'`) with `choices[0].delta` set to `content`, `reasoning_content`, or `tool_calls`. The `message_delta` chunk also carries `usage`.
- Return value `StreamFinalUsage { meteringUsage, inputTokens, outputTokens, totalTokens, cacheReadInputTokens, cacheWriteInputTokens, contextUsagePercentage }`.

## Integration

Consumers:
- `src/core/request/response-handler.ts` imports `transformSdkStream`. This is the production entry point.
- Tests import the streaming modules directly: `stream-errors.test.ts`, `tool-compatibility.test.ts`, `native-reasoning.test.ts` (via `transformSdkStream`), `stream-parser.test.ts` (`findRealTag`, `parseStreamBuffer`), and `openai-converter.test.ts` (`convertToOpenAI`).
- `transformKiroStream` is exported via `index.ts` but I found no direct importer in `src/` outside the barrel. Treat it as legacy. Confirm before removing.

Dependencies:
- `infrastructure/transformers/event-stream-parser.js` (`parseEventLine`), used by `stream-parser.ts`.
- `infrastructure/transformers/tool-call-parser.js` (`parseBracketToolCalls`).
- `infrastructure/transformers/tool-transformer.js` (`restoreToolName`).
- `plugin/logger.js` (`debug`), `plugin/models.js` (`getContextWindowSize`), `plugin/response.js` (`estimateTokens`), and `plugin/types.js` (`ToolNameMap`).

Downstream contract: `@ai-sdk/openai-compatible` expects OpenAI chunk shape. Changing `convertToOpenAI` output or error chunk shape affects every provider response.
