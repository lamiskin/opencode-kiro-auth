# src/infrastructure/

## Responsibility

Container folder for the infrastructure layer. It holds no TypeScript source files of its own. Its two subfolders hold the concrete adapters: `transformers/` converts provider streams and payloads into internal message and tool shapes, and `database/` persists account and cache state. Consumers import from the subfolders directly.

## Design (patterns, abstractions, interfaces)

- No module-level exports at this level, so there is no facade or barrel file. Each subfolder is its own unit with its own codemap.
- Separation by concern: transformation (pure data mapping) in `transformers/`, persistence (I/O and caching) in `database/`.
- Subfolder details are not repeated here. See the linked codemaps for patterns, interfaces, and named functions.

## Flow (data in -> key calls -> data out)

- Inbound: raw provider events or account records enter through the caller in the application layer.
- Transform path: `transformers/` modules map provider events and payloads into internal message and tool-call structures.
- Persist path: `database/` modules read and write account records and cache entries.
- Outbound: transformed messages and persisted account data return to the caller. This folder performs no orchestration of its own.

## Integration (consumers and dependencies)

- Consumers: application and plugin layers that call the transformers and the account repository and cache.
- Dependencies: the subfolders depend on shared types and, for `database/`, on the local persistence backend. This level adds no external dependency.
- Changes to subfolder interfaces affect the consumers above. This level has no independent contract to version.

## Subdirectories

| Path | Role | Codemap |
| --- | --- | --- |
| `transformers/` | Provider event and payload to internal message and tool shapes | [transformers/codemap.md](transformers/codemap.md) |
| `database/` | Account repository and account cache | [database/codemap.md](database/codemap.md) |
