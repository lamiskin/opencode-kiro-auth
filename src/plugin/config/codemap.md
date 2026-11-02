# src/plugin/config/

## Responsibility

Loads and validates the plugin's runtime configuration (`kiro.json`), layers environment overrides on top, and exposes a single typed `KiroConfig` object to the rest of the plugin. It owns the config schema, defaults, and file locations. It does not read or write auth tokens.

Files:
- `schema.ts`: zod schemas, inferred types, `DEFAULT_CONFIG`
- `loader.ts`: path resolution, template creation, file parsing, merge, env overrides, `loadConfig`
- `index.ts`: barrel re-exporting the public surface

## Design

- Schema-first. `KiroConfigSchema` is a zod object with `.default()` on every field, so `z.infer` gives `KiroConfig`. `DEFAULT_CONFIG` is a hand-maintained literal that must stay in sync with the schema defaults. Nothing enforces that sync.
- Enums are shared zod schemas (`AccountSelectionStrategySchema`, `EffortSchema`, `RegionSchema`). `types.ts` reuses them, so the same enum values are used across config and runtime.
- Partial parsing for files. `loadConfigFile` runs `KiroConfigSchema.partial().safeParse`. A file with any invalid field is rejected as a whole (logged via `logger.warn`, returns `null`). It is not field-by-field.
- Layered precedence, applied in order:
  1. `DEFAULT_CONFIG`
  2. user file (`getUserConfigPath()`)
  3. project file (`getProjectConfigPath(directory)`)
  4. env vars (`applyEnvOverrides`)
  Merge is a shallow spread (`mergeConfigs`). Nested objects do not exist, so this is safe.
- Env parsing is split by type. `parseBooleanEnv` accepts `1|true|0|false` and otherwise falls back. `parseNumberEnv` uses `Number()` and falls back on NaN. Enum env vars use `.catch(default)` on the zod enum.
- Error policy is soft. Missing or invalid files never throw. They log and fall through to the lower layer.
- Platform-aware paths. `getConfigDir()` uses `%APPDATA%\opencode` on win32, else `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`.

## Flow

Input: `directory` (project root string) and `process.env`.

`loadConfig(directory)`:
1. `ensureUserConfigTemplate()`: if `kiro.json` is missing, mkdir -p and write `DEFAULT_CONFIG` as pretty JSON. Failures are logged, not thrown.
2. `loadConfigFile(userPath)` then `mergeConfigs`.
3. `loadConfigFile(projectPath)` then `mergeConfigs`.
4. `applyEnvOverrides(config)`: one ternary or `parseXEnv` per supported `KIRO_*` variable.
5. Output: a fully populated `KiroConfig`.

Env variables covered: `KIRO_ACCOUNT_SELECTION_STRATEGY`, `KIRO_DEFAULT_REGION`, `KIRO_RATE_LIMIT_RETRY_DELAY_MS`, `KIRO_RATE_LIMIT_MAX_RETRIES`, `KIRO_MAX_REQUEST_ITERATIONS`, `KIRO_REQUEST_TIMEOUT_MS`, `KIRO_TOKEN_EXPIRY_BUFFER_MS`, `KIRO_USAGE_SYNC_MAX_RETRIES`, `KIRO_AUTH_SERVER_PORT_START`, `KIRO_AUTH_SERVER_PORT_RANGE`, `KIRO_USAGE_TRACKING_ENABLED`, `KIRO_ENABLE_LOG_API_REQUEST`, `KIRO_LOG_RETENTION_DAYS`, `KIRO_LOG_REDACT_CONTENT`, `KIRO_LOG_SHAPE`, `KIRO_MAX_HISTORY_ENTRIES`, `KIRO_HISTORY_TRIM_ON_OVERFLOW`.

Not overridable by env: `idc_*`, `effort`, `auto_effort_mapping`, `web_search_enabled`, `auto_sync_kiro_cli`, `$schema`.

Known gap: env numbers are not range-checked. The zod min/max bounds apply only to file values. An env value like `KIRO_REQUEST_TIMEOUT_MS=1` passes through unchecked.

## Integration

Consumers:
- `src/runtime.ts:31` calls `loadConfig(directory)` at startup.
- `src/adapters/v1.ts:51` calls `loadConfig(directory)`.
- `src/plugin/types.ts` imports `AccountSelectionStrategySchema`, `EffortSchema`, `RegionSchema`.
- `src/plugin/effort.ts` imports the `Effort` type.
- `src/codemap.md` documents the `directory -> loadConfig -> config` flow.

Dependencies:
- `zod` for schemas and validation.
- `node:fs`, `node:os`, `node:path` for file I/O and path resolution.
- `../logger` (`log`, `warn`) for diagnostics.

Public surface (via `index.ts`): `loadConfig`, `getUserConfigPath`, `getProjectConfigPath`, `DEFAULT_CONFIG`, `KiroConfigSchema`, type `KiroConfig`.
