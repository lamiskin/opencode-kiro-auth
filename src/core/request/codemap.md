# src/core/request/
## Responsibility
Runs one Kiro API call end to end: picks an account, refreshes its token, builds the SDK request, sends `GenerateAssistantResponseCommand`, retries or fails over on errors, and converts the reply to an OpenAI-shaped `Response`. Files:
- `request-handler.ts`: `RequestHandler`, the orchestrator and retry loop.
- `error-handler.ts`: `ErrorHandler`, per-HTTP-status policy (returns retry/switch/refresh decisions).
- `retry-strategy.ts`: `RetryStrategy`, iteration and timeout budget.
- `response-handler.ts`: `ResponseHandler`, SSE and non-streaming response builders.

## Design (patterns, abstractions, interfaces)
- Composition: `RequestHandler` owns `AccountSelector`, `TokenRefresher`, `UsageTracker`, `ErrorHandler`, `ResponseHandler`, `RetryStrategy`, built in its constructor.
- Global FIFO mutex: `private static kiroRequestQueue` (Promise chain) in `enqueueKiroRequest()` serializes all Kiro requests process-wide.
- Two entry points: `handle(input, init)` passes non-Kiro URLs (not matching `KIRO_API_PATTERN`) straight to `fetch`. `handleForced()` skips the pattern check for the v2 loopback proxy.
- Re-auth is deduplicated: `triggerReauth()` shares `reauthInFlight`, and a 60 s cooldown (`REAUTH_FAILURE_COOLDOWN_MS`) follows a failure. `performReauth()` calls `port.reauthorize()` (HostPort), then reloads accounts via `repository.findAll()` after `invalidateCache()`.
- Error policy is data, not control flow: `ErrorHandler.handle()` returns `{ shouldRetry, newContext, switchAccount, forceRefresh }`. The loop in `handleKiroRequest()` acts on those flags. The 500 path sleeps internally (1s, 2s, 4s, 8s), then marks the account unhealthy after 5 failures.
- Retry budget: `RetryStrategy.shouldContinue()` increments `iterations` on every loop pass, including `continue` paths, and checks `request_timeout_ms` from `createContext()`.
- Logging is opt-in: `logSdkRequest/logSdkResponse/logSdkError` run only when `enable_log_api_request` is on. Content is redacted when `log_redact_content` is set. `logSdkError` strips auth, cookie, token, and secret headers.
- `ResponseHandler` comment says `handleSuccess/handleStreaming/handleNonStreaming` are dead code. Those methods do not exist in the file. The comment is stale.

## Flow (data in -> key calls -> data out)
In: `(url, init)`. `init.body` is an OpenAI-style JSON body. Headers `x-kiro-session` (fallback `x-opencode-session-id`), `x-kiro-agent`, `x-kiro-kind` form the tag.
1. `handleKiroRequest()` parses the body. Model comes from the URL (`models/<id>`), then `body.model`, then `claude-sonnet-4-5`. `think` and `budget` come from thinkingConfig.
2. Loop:
   - `retryStrategy.shouldContinue()`.
   - If `allAccountsPermanentlyUnhealthy()`, call `triggerReauth()`.
   - `accountSelector.selectHealthyAccount(notify)`. If null, back off `min(1000 * 2^n, 10000)` ms.
   - `tokenRefresher.refreshIfNeeded()`. If refreshed, sleep 500 ms and continue.
   - `toAuthDetails(acc)` (read after refresh), then `refreshContextWindowSizes(auth)`.
   - `prepareSdkRequest()` -> `transformToSdkRequest(body, model, auth, think, budget, notify, effort/autoEffort, capOverride, max_history_entries)`.
   - `createSdkClient(auth, region, effort, isOpenAI)`, then `client.send(GenerateAssistantResponseCommand)`.
3. Success: `handleSuccessfulRequest()` clears fail state (non-permanent), `usageTracker.syncUsage()`, then `responseHandler.handleSdkSuccess()`.
4. Failure with HTTP status:
   - 403 with bearer-invalid text, first time: `forceRefresh`, then continue.
   - Otherwise `errorHandler.handle(e, mockResponse, ...)`. Retry, or fall through.
   - `input is too long`: reactive history trim once (`capOverride = max(10, 0.6 * len)`), else a 400 JSON `context_length_exceeded` Response.
   - Other: throw `Kiro Error: <status> - <msg>`.
5. No status: `errorHandler.handleNetworkError()`, retry on `ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed`, else rethrow.

Out: `Response`. Streaming is `text/event-stream` with `data: <chunk>` lines from `transformSdkStream()`, ending in `data: [DONE]`. Non-streaming is one `chat.completion` JSON. Tool calls are accumulated by `toolUseId` and names restored via `restoreToolName()`. Metering appends `\n\n_Credits Used: X.XX_` on the final step of a turn only, showing the turn's total credits (tool-call steps add to the running total, see `plugin/credits-footer.ts`). Token usage falls back to `estimateTokens()` plus `getContextWindowSize()` when Kiro sends no `tokenUsage`.

## Integration (consumers and dependencies)
Consumers:
- `src/adapters/v2.ts` calls `handleForced()`.
- The plugin fetch interceptor calls `handle()`. I did not verify this call site in this pass.

Dependencies:
- `../account/account-selector` (`AccountSelector`), `../account/usage-tracker` (`UsageTracker`), `../auth/token-refresher` (`TokenRefresher`).
- `../../plugin/accounts` (`AccountManager`: `getAccounts`, `markUnhealthy`, `markRateLimited`, `toAuthDetails`, `addAccount`, `getAccountCount`).
- `../../infrastructure/database/account-repository` (`AccountRepository`: `save`, `batchSave`, `findAll`, `invalidateCache`).
- `../../plugin/request` (`transformToSdkRequest`), `../../plugin/sdk-client` (`createSdkClient`), `../../plugin/streaming/sdk-stream-transformer` (`transformSdkStream`), `../../infrastructure/transformers/tool-transformer` (`restoreToolName`).
- `../../plugin/health` (`isPermanentError`), `../../plugin/models` (`refreshContextWindowSizes`, `getContextWindowSize`), `../../plugin/response` (`estimateTokens`), `../../plugin/sync/kiro-cli` (`syncFromKiroCli`), `../../plugin/logger`, `../../plugin/effort`.
- `../../host/port` (`HostPort`: `notify`, `reauthorize`).

Shape note: the 403 bearer-invalid retry exists in both `request-handler.ts` (before `errorHandler`) and `error-handler.ts`. The request-handler check runs first, so the error-handler branch is only reached for the `bearerRetried` flag path.
