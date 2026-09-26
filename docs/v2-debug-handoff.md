# Handoff: OpenCode v2 support debugging session

*Update (2026-09-25): This plugin is now confirmed working live in OpenChamber/OpenCode v2 — the user verified end-to-end chat successfully. See "Known remaining issues" resolution below.*

Date: 2026-09-25
Host under test: OpenChamber 2.0.1 with bundled OpenCode 2.0.16
Terminal host: OpenCode 1.18.30 (v1, still works)

## Outcome

Kiro models now list **and** chat successfully in OpenChamber 2.0.1 / OpenCode
2.0.16. Confirmed working by the user in the GUI. Terminal v1 still lists all 30
Kiro models.

## Root causes (three separate problems)

### 1. Plugin not discovered by v2

OpenChamber's bundled OpenCode 2.0.16 resolved the repo's dual-export entry
(`{ id, server, setup }`) as an unidentified local plugin — `opencode plugin
list --builtin` showed its ID as `-` — and never called `setup`.

### 2. Model schema rejection

v2 requires `variants` on every `Model.Info`. It was conditionally omitted for
models without variants, producing:

```
InvalidRequestError: Missing key at ["data"][8]["variants"]
```

### 3. The actual chat blocker — not this repo's code

`@cortexkit/opencode-magic-context@0.42.6` hangs every v2 primary-session
prompt: the user message is accepted, no assistant response ever arrives, and no
error is surfaced to OpenChamber.

This is upstream [cortexkit/magic-context#493](https://github.com/cortexkit/magic-context/issues/493),
fixed in **0.43.1**.

Version timeline:

| Version | Status                                       |
| ------- | -------------------------------------------- |
| 0.42.6  | V2 prompts hang (#493)                       |
| 0.43.0  | Fails every turn, "Schema validation failed" |
| 0.43.1  | Fixes both                                   |

## Repo changes

All changes are in the working tree; nothing was git-committed.

- **`src/v2.ts`** (new): setup-only default export `{ id: 'kiro', setup }`.
- **`v2-plugin/`** (new): `package.json` + `index.js` re-exporting
  `../dist/v2.js`. Required because v2 accepts a _directory_ with a resolvable
  entry; a bare file path is rejected with `configured plugin path must be a
directory`, and the repo root resolved to a shape v2 rejected.
- **`src/adapters/v2.ts`**: rewritten. Removed `ctx.aisdk.hook('sdk', ...)`
  entirely — v2 has **no fetch-injection point** for openai-compatible
  providers; it makes real HTTP calls to `settings.baseURL`. Now starts a
  **loopback HTTP server** fronting `RequestHandler` and points
  `settings.baseURL` at it. `variants` is always present. No per-model
  `package` field.
- **`src/core/request/request-handler.ts`**: added `handleForced()`, which
  bypasses the `KIRO_API_PATTERN` guard. Every request arriving at our own
  loopback proxy is definitionally a Kiro request, but its URL is
  `127.0.0.1`, which the pattern (written for `q.<region>.amazonaws.com`) does
  not match.
- **`src/core/request/response-handler.ts`**: added the `data: [DONE]` SSE
  terminator.
- **Tests**: replaced the aisdk-hook test with one asserting the local server
  starts and `settings.baseURL` matches `http://127.0.0.1:<port>`; updated the
  per-model `package` assertion to expect `undefined`; removed `aisdk` from the
  v2-conformance fixture.

### Verification status

- `bun test`: 318 pass, 0 fail
- `npm run build`: clean
- `prettier --check` on changed files: clean
- `npm run typecheck`: 20 **pre-existing, unrelated** errors in
  `cleanup.test.ts`, `event-stream-parser.test.ts`, `kiro-docs-sync.test.ts`

## User config changes

File: `~/.config/opencode/opencode.json`
Backup: `~/.config/opencode/opencode.json.bak-20260925-135118`

```json
"plugin": [
  "@cortexkit/opencode-magic-context@0.43.1",
  "/Users/uqlmiski/Kiro/opencode-kiro-auth",
  "@cortexkit/aft-opencode@latest",
  "oh-my-opencode-slim@latest",
  "/Users/uqlmiski/Kiro/ponytail"
],
"plugins": [
  "/Users/uqlmiski/Kiro/opencode-kiro-auth/v2-plugin"
]
```

Two things happened here:

1. Pinned magic-context to `0.43.1` rather than `@latest`. OpenCode bug #30631
   permanently pins an `@latest` specifier to whatever version was current at
   install time, which is why `plugin check` reported an available update but
   the host kept loading 0.42.6.
2. De-duplicated the plugin lists. **v2 reads both `plugin` and `plugins`**, so
   any package listed in both loads twice — issue #493 notes repeated loads as a
   symptom. Only `kiro` needs to appear in both keys, because v1 and v2 require
   different entry paths.

Note that new package versions install in the background and only load on the
**next** server start.

## Critical gotchas for the next agent

- ~~`provider.kiro.npm` in the user config is load-bearing on v2.~~ **Resolved (commit
  `a829432`):** The plugin now declares `package: '@opencode/ai/providers/openai-compatible'`
  which v2 resolves correctly without any user config workaround.
- **`opencode run` is an unreliable test harness.** It reports
  `outcome: interrupted` with no assistant message even for providers that
  demonstrably work. Reproduced with both `rapid-mlx` and OpenCode's own
  `opencode/big-pickle`. Verify in the OpenChamber GUI instead.
- **Session token counts are NOT proof of success.** They come from this repo's
  own `usageTracker.syncUsage()`, which fires right after the raw Kiro API call
  and is independent of whether OpenCode ever consumed the SSE response. A lot
  of time was wasted treating this as a success signal.
- **Reliable success signal**: a `type: "assistant"` message with `content` and
  `finish: "stop"` from `GET /api/session/<id>/message`. A working session shows
  `outcome: succeeded`; the broken signature is a `type: "idle"` message with
  `outcome: "interrupted"` and no assistant row at all.
- **The diagnostic that actually worked**: A/B bisect using an isolated
  `XDG_CONFIG_HOME` plus `OPENCODE_DB`, starting from a minimal config and
  adding plugins back one at a time. This should have been the second move, not
  the last.
- **Do not reverse-engineer the bundled binary.** Significant time went into
  extracting strings from
  `/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`.
  Everything actually needed came from the installed `@opencode/*` type
  definitions, the public docs, and GitHub issues.
- After any `src/` change: run `npm run build` (OpenCode loads `dist/`, not
  `src/`), then **fully quit and relaunch OpenChamber**. A new chat window does
  not reload the plugin.

## Useful commands

```bash
# Which plugins actually loaded, and at what version
"/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode" plugin list --builtin

# Isolated server for A/B bisecting config
XDG_CONFIG_HOME=/tmp/test-config OPENCODE_DB=/tmp/test-db.sqlite \
  OPENCODE_SERVER_PASSWORD=pw \
  "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode" \
  serve --hostname 127.0.0.1 --port 49131

# Inspect a session's real result
curl -sS -u opencode:pw "http://127.0.0.1:49131/api/session/<id>/message"

# Plugin log
tail -f ~/.config/opencode/kiro-logs/plugin.log
```

## Known remaining issues

### Resolved (2026-09-25)

- **Plugin-declared `package`**: Fixed in commit `a829432`. The package specifier was
  corrected to `@opencode/ai/providers/openai-compatible`, which v2 resolves correctly.
  User config workaround (`provider.kiro.npm`) is no longer required.
- **Route narrowing**: Fixed in commit `58557ee`. The loopback server now accepts both
  `/chat/completions` and `/v1/chat/completions` — the earlier `/v1`-only guard was
  blocking every chat request.

### Still open

- v2 `reauthorize()` is still a stub — IdC re-auth is unimplemented in the v2
  adapter (deliberately deferred; CLI credential sync covers normal use).
- Stale `dist/` artifacts persist after a source file is deleted, because `tsc`
  does not clean the output directory. Remove them manually.
- OpenChamber [#3936](https://github.com/openchamber/openchamber/issues/3936)
  describes a cold-catalog race where the first prompt after startup can fail
  with `provider.no-route` and a retry succeeds. Not confirmed as affecting this
  setup, but worth knowing if first-message failures reappear.
