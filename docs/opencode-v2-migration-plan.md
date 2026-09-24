# OpenCode v1 + v2 Dual-Support Migration Plan

Status: planning complete, implementation not started.
Author: oracle (ora-1), reconciled by orchestrator 2026-09-24.

## Background

OpenCode v2's plugin API is a hard break from v1 — v1 hook-object entrypoints do not
run under v2, and there is no automatic hook translation. This repo currently only
implements the v1 shape (`createKiroPlugin` in `src/plugin.ts`). Package.json pins
`@opencode-ai/plugin: ^1.15.11`; latest published OpenCode is 1.18.32 (v1 line) with
v2 shipping as a separate major.

Verified against the actual published `@opencode/plugin@2.0.16` + `@opencode/schema@2.0.16`
+ `@opencode/ai@2.0.16` tarballs (not just the migration docs), which corrected several
premises from the docs-only read.

## Corrections to initial assumptions

1. **`Plugin.define` is the identity function.** `promise/plugin.js` is literally
   `export function define(plugin) { return plugin }`. No runtime magic — a plain
   object literal `{ id, setup }` is a valid v2 plugin. **No `@opencode/plugin` runtime
   dependency is needed.**
2. **v1 and v2 module shapes are structurally disjoint on distinct keys**, so one
   default export satisfies both:
   - v1 `PluginModule` = `{ id?: string; server: Plugin; tui?: never }`
   - v2 `Plugin` = `{ id: string; setup: (ctx) => Promise<Cleanup|void> }`
   ```ts
   export default { id: 'kiro', server: KiroOAuthPlugin, setup: kiroSetup }
   ```
   No spread trick, no separate entry files needed — *if* v2's module extraction
   doesn't strictly reject the extra `server` key (see Unknown #1).
3. **`package.json` `opencode.hooks` is v1-only metadata; v2 ignores it.** v2
   discovery (`Host.resolve`) just resolves the bare package specifier
   (`<pkg>/server` then `<pkg>`). `main: "dist/index.js"` with no `exports` map
   works for both. No manifest changes needed.
4. **`ctx.integration.transform` is not a loader-equivalent.** No "OpenCode calls
   your loader, you return a fetch override" in v2. Auth is pull-based:
   `ctx.integration.connection.active(id)` → `ConnectionInfo`, then `.resolve()` →
   `Credential.Value`. The auth.json bootstrap placeholder trick becomes
   **unnecessary under v2** — `setup()` runs unconditionally at plugin load, so the
   Kiro CLI sync happens directly there. `bootstrapAuthIfNeeded` stays v1-only.
5. **Custom `fetch` injection point moves.** No `auth.loader` return value in v2.
   Replacement: `ctx.aisdk.hook('sdk', cb, { providerID: 'kiro' })`, mutating
   `event.sdk = createOpenAICompatible({ baseURL, apiKey: '', fetch: ... })`.
   `@ai-sdk/provider@3.0.8` is a direct dep of `@opencode/plugin`, so the
   `@ai-sdk/openai-compatible` strategy survives into v2.
6. **No toast/TUI notify channel in the v2 plugin `Context`.** `Toast` only exists
   in the separate TUI entrypoint's context. `ToastFunction` currently threads
   through `AuthHandler.initialize`, `RequestHandler.handle`, `performReauth` — a
   real functional gap for v2, not just a signature mismatch.
7. **`RequestHandler.performReauth` calls v1 client APIs directly**
   (`this.client.provider.oauth.authorize/callback`, `request-handler.ts:392-400`).
   v2 equivalent is `ctx.integration.oauth.connect/status/complete/cancel` — a
   different shape. Second piece of v1 coupling buried inside otherwise-shared code.

## 1. Package structure

New seam: a `HostPort` interface (~3 members), nothing more.

```
src/
  core/, infrastructure/, plugin/     ← unchanged business logic
  host/
    port.ts                           ← NEW: HostPort interface
  adapters/
    v1.ts                             ← today's createKiroPlugin, moved + port impl
    v2.ts                             ← new setup(ctx)
  runtime.ts                          ← NEW: shared construction, generation-agnostic
  tools.ts                            ← NEW: shape-neutral tool descriptors
  index.ts                            ← dual default export
```

```ts
export interface HostPort {
  notify(message: string, variant: 'info'|'success'|'warning'|'error'): void
  reauthorize(): Promise<void>   // v1: client.provider.oauth.*  v2: ctx.integration.oauth.*
}
```

- `ToastFunction` params across `AuthHandler`/`RequestHandler` collapse into
  `port.notify` (rename-level change).
- `RequestHandler` takes `port` instead of `client: any`; `performReauth` becomes
  `await this.port.reauthorize()` plus existing shared reconciliation logic.
- `buildTools` moves to `src/tools.ts`, returns neutral descriptors
  `{ name, description, input: ZodSchema, execute(args) }`. v1 wraps with `tool()`
  from `@opencode-ai/plugin`; v2 wraps with `editor.add({ name, description, input,
  execute })`. v2 `Tool.Info` uses `input` (not `args`); zod v4 satisfies
  `ValueSchema`'s `StandardSchemaV1` requirement, so schemas port unchanged.
- `runtime.ts` exports `createRuntime(directory, port)` returning
  `{ config, repository, authHandler, accountManager, requestHandler, baseURL, tools }`.
  Both adapters call it — zero logic duplication.

## 2. Entrypoint wiring

`src/index.ts`:
```ts
export default {
  id: 'kiro',
  server: KiroOAuthPlugin,   // v1: (input) => Promise<Hooks>
  setup: kiroSetup           // v2: (ctx) => Promise<Cleanup|void>
}
```
Keep existing named exports for tests. Use static imports (drop any top-level
`await import()`) — v2's loader re-imports with a cache-busting query param on file
change; top-level await in the entry module is a needless hazard there.

`package.json`: no change to `main`/`types`/`files`. Do not add an `exports` map —
`Host.resolve` swallows `ERR_PACKAGE_PATH_NOT_EXPORTED` and falls through to the bare
specifier.

README: document v1 `"plugin": ["pkg"]` → v2 `"plugins": ["pkg"]` (or
`{"package": "pkg", "options": {...}}`) config-key change.

## 3. Auth bridging under v2

| v1 concern | v2 home |
|---|---|
| bootstrap placeholder so loader fires | delete — `setup()` always runs |
| `authHandler.initialize()` (Kiro CLI sync) | call directly in `setup()` |
| `refreshRegistry()` after auth | await or fire-and-forget in `setup()`, then `ctx.model.reload()` |
| return `{ apiKey, baseURL, fetch }` | `ctx.aisdk.hook('sdk', ..., { providerID: 'kiro' })` |
| `auth.methods` (IdC OAuth) | `ctx.integration.transform(e => e.method.update({...}))` |

IdC method port is the fiddliest part: v1 `prompts: [{type, key, message, ...}]` →
`Form.Fields` (`@opencode/schema/form`, not yet read). v1 `authorize(inputs)` →
`authorize(answer: Form.Answer)` returning `{ url, instructions, expiresAt?, mode,
callback }` where for `mode:'auto'`, **callback is `Promise<Credential.OAuth>`, not
a function** — and `Credential.OAuth` requires a `methodID` v1 didn't have.

Pragmatic sequencing: ship v2 with the CLI-sync auth path only first (covers the
overwhelming majority of real usage); register IdC methods in a later phase.

## 4. Provider/model registration under v2

`ctx.provider.transform(editor => editor.add({ info, models }))`. Mapping from
`buildModelRegistry()` output to `Model.Info`:

| v1 field | v2 field |
|---|---|
| `name` | `name` |
| `limit:{context,output}` | `limit:{context,output}` (same) |
| `modalities:{input,output}` | `capabilities:{tools:true,input,output}` |
| `interleaved:{field:'reasoning_content'}` | `compatibility:{reasoningField:'reasoning_content'}` |
| `reasoning:true` | implied by `compatibility.reasoningField` — verify |
| `variants: Record<id,{...}>` | `variants: Array<{id, settings\|body}>` |
| (absent) | `id, modelID, providerID, package, time:{released:0}, cost:[], status:'active', enabled:true` |

`Model.Settings`/`Provider.Settings` are `StructWithRest` (`Record<string, Any>`), so
`thinkingConfig.thinkingBudget`/`reasoning.effort` pass through as arbitrary settings
keys. `Provider.Info` = `{ id, name, activation, package, settings?, headers?, body?,
integrationID? }` — `baseURL` goes in `settings`, `package: '@ai-sdk/openai-compatible'`
replaces v1's `npm` field. `activation: 'enabled'` replaces the bootstrap placeholder
as the "show up without credentials" mechanism.

Async catalog handling is actually *better* in v2: `initializeRegistry()` →
`provider.transform(add)` in `setup()` for the immediate bundled list, then
`refreshRegistry().then(() => ctx.model.reload())` re-runs transforms with fresh
rates in the same session (v1 only picks up fresh rates on next start). The
transform callback must read the registry at call time (not close over a snapshot),
since transforms re-invoke on reload.

v1's `provider.models` normalization hook (forcing `api.npm`/`api.url`) has **no v2
counterpart and isn't needed** — `editor.add` sets `package`/`settings.baseURL`
authoritatively. Drop it from the v2 path.

## 5. Dependency strategy

Do NOT add `@opencode/plugin` as a runtime dependency (`define` is identity; it also
drags `effect@4.0.0-rc.112`, `@opencode/{ai,client,protocol,schema,util}`, `zod@4.1.8`).

- `@opencode/plugin` as an **optional devDependency**, `import type` only — erased by
  `tsc`, so `dist/` has no v2 import and the package stays installable/runnable for
  `@opencode-ai/plugin ^1.15.11` consumers.
- If effect/zod version skew conflicts with existing `zod ^3.24.0`, fall back to
  hand-written structural types for the ~6 touched shapes (`Context` slice,
  `ProviderEditor`, `ModelEditor`, `ToolEditor`, `IntegrationEditor`, `AISDKHooks`)
  — ~60 lines, removes the dependency question entirely. Try devDependency first.
- Widen `@opencode-ai/plugin` to `^1.15.11` (unchanged through 1.18.32 — `PluginModule`,
  `AuthHook`, `Hooks` all stable).
- No runtime version detection or feature gating needed — whichever generation loads
  the module picks the key it understands.

## 6. Testing strategy

Unchanged, no fixture rewrite: `auth-bootstrap.test.ts`, `model-catalog.test.ts`,
`model-registry.test.ts`, `tool-compatibility.test.ts`, token-refresher/accounts/
streaming suites all test modules below the adapter seam.

Changes:
- `plugin-module.test.ts` extends to assert both `typeof server === 'function'` and
  `typeof setup === 'function'` — cheap dual-dispatch regression guard.
- Anything constructing `RequestHandler(..., client)` moves to a `HostPort` stub.
  Check `request-handler-refreshed-token.test.ts` and `bearer-retry.test.ts` for the
  4th positional arg.
- Net-new `adapters/v2.test.ts`: hand-rolled fake `ctx` (~40 lines — `transform` is
  `(cb) => Promise<Registration>`, editors are plain interfaces). Capture callback,
  invoke with recording editor, assert `editor.add` received `Provider.Info` with
  `package` + `settings.baseURL` and N models, assert tool editor got `kiro_usage`,
  assert `aisdk` `sdk` hook sets `event.sdk`.
- Net-new model-shape test: `buildModelRegistry()` → `Model.Info` mapping produces
  every required field (`id, modelID, providerID, capabilities, time, cost, status,
  enabled, limit`), and `-thinking` entries carry
  `compatibility.reasoningField === 'reasoning_content'`. **Single most likely silent
  breakage** — a missing required field means models vanish with no error.
- Net-new: `setup()` returns a cleanup; assert it disposes every `Registration` it
  collected.

## 7. Unknowns to close before implementation

**Unknowns #1 and #2 below are RESOLVED** (librarian, lib-1, verified against opencode
server source directly — see confirmation section after this list).

1. ~~How v2 core extracts the plugin from the loaded module.~~ **RESOLVED:**
   `readV1Plugin` (`packages/opencode/src/plugin/shared.ts:243-274`) does duck-typing,
   not strict schema validation. In `"detect"` mode it only checks for presence of
   `id`/`server`/`tui` keys, validates `server`/`tui` are functions if present, and
   rejects only if BOTH `server` and `tui` are set. Extra keys (like `setup`) are
   ignored by the v1 path and picked up by the v2 path. The single-object dual
   export `{ id, server, setup }` works — no `exports` map or separate entry files
   needed.
2. ~~Whether v2 core resolves `package: '@ai-sdk/openai-compatible'` to an npm
   import.~~ **RESOLVED:** Confirmed via `packages/core/src/session/runner/model.ts:131-155`
   — v2 explicitly resolves `@ai-sdk/openai-compatible` (and `@ai-sdk/openai`,
   `@ai-sdk/anthropic`) by package name at runtime, gated on
   `model.api.type === "aisdk" && model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined`.
   No native `ProviderPackage.Definition` needed — Phase 3 stays a normal adapter
   job. Residual detail to confirm during implementation: whether `ProviderEditor.add`
   expects the field literally named `package` (docs/migration guide say so; not yet
   confirmed by reading `ProviderEditor.add`'s actual signature) vs `npm`.
3. ~~`reasoning: true` equivalence.~~ **RESOLVED:** `packages/opencode/src/provider/transform.ts:257-297`
   checks `typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field`
   — no top-level `reasoning` boolean, `compatibility.requireReasoning` unused. Set
   `compatibility.reasoningField: 'reasoning_content'` on reasoning models; that alone
   drives detection.
4. ~~`Form.Fields`/`Form.Answer` shape~~ **RESOLVED (renamed):** these types don't exist
   — v2 uses `Integration.Prompt` (a `TextPrompt`/`SelectPrompt` union,
   `packages/schema/src/integration.ts:21-73`) inside `OAuthMethod.prompts: optional(Schema.Array(Prompt))`.
   Fields: `key`, `message`, `placeholder`, `options` (for select), `when` (conditional,
   replaces v1's `validate`). Map v1 `prompts: [{type:'text', key, message, placeholder, validate}]`
   directly onto this shape for Phase 5.
5. ~~Notification sink.~~ **RESOLVED (real gap, confirmed):** No `ctx.notify`/`ctx.toast`
   exists in the v2 server `PluginContext` (`packages/plugin/src/v2/effect/context.ts`,
   `packages/plugin/src/v2/promise/plugin.ts`). `client.tui.showToast` exists but requires
   a TUI client, not available to a server-only plugin. **Decision needed:** v2's
   `port.notify` degrades to `logger` only — startup usage summaries and re-auth
   toasts are silent under v2 unless a `./tui` entrypoint is added later. Accepted as
   a known v2 limitation for now (Phase 3 ships with logger-only notify); revisit if
   users report missing feedback.
6. ~~`activation: 'enabled'` with no `integrationID`.~~ **RESOLVED:** `ProviderV2.Info`
   has no `integrationID` field at all in v2 (`specs/v2/provider-model.md`) — visibility
   gates on an `enabled` union (`{via:'env',...}`, `{via:'account',...}`, `{via:'custom',...}`)
   rather than an integration link. A provider with `enabled: true` (or the `'custom'`
   variant with empty data) appears and is selectable without any credential backing.
   Confirms the bootstrap-placeholder replacement strategy in section 4.
7. ~~Does v2 read `auth.json`?~~ **RESOLVED:** Yes, same file, same path
   (`packages/opencode/src/auth/index.ts`, confirmed against `~/.local/share/opencode/auth.json`
   docs). `bootstrapAuthIfNeeded` writing to it under v2 is harmless but unnecessary —
   confirmed safe to skip in the v2 adapter (section 3 already reflects this).

## 8. Phased rollout

Phases 1→3→4 are strictly sequential. 5 and 6 are parallel-safe afterwards.

- **Phase 1 — extract, zero behavior change.** Add `host/port.ts`, `runtime.ts`,
  `tools.ts`; move `createKiroPlugin` to `adapters/v1.ts`, reimplement on
  `createRuntime` + a v1 `HostPort` (notify → `client.tui.showToast`, reauthorize →
  `client.provider.oauth.*`). Thread `port` through `AuthHandler`/`RequestHandler` in
  place of `ToastFunction`/`client`. Full suite green, `npm run build`, relaunch,
  manually confirm model list + a live request. **Ship and verify before touching
  v2** — only phase that can break current working behavior.
- **Phase 2 — close unknowns (parallel with 1, no code).** Resolve #1-4 above. If #2
  lands badly, stop and re-plan before Phase 3.
- **Phase 3 — v2 adapter.** `adapters/v2.ts`: `createRuntime` + provider/model
  registration + tool registration + `aisdk` sdk hook + cleanup aggregation. No IdC
  methods yet. Plus model-shape test and v2 adapter test.
- **Phase 4 — dual export.** Extend `index.ts` and `plugin-module.test.ts`. Verify
  under both generations.
- **Phase 5 — v2 IdC auth methods** via `integration.transform`. Independent of 3/4;
  deferrable indefinitely if CLI sync covers users.
- **Phase 6 — docs.** README `plugin` → `plugins`, v2 notification limitation,
  supported-version matrix.

## Related project memory

- Memory #102 (ARCHITECTURE): `Plugin.define` is identity; v1/v2 module shapes are
  disjoint so one default export satisfies both; v2 ignores `package.json`
  `opencode.hooks`.
