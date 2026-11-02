# src/host/

## Responsibility

Holds the `HostPort` interface in `port.ts`, the seam between the Kiro plugin core and the host runtime (OpenCode v1, OpenCode v2, tests). Core code calls `HostPort` for user-facing toasts and re-authorization. It never touches host-specific APIs. The folder contains one file and no runtime logic.

## Design (patterns, abstractions, interfaces)

- Port/adapter pattern. `HostPort` is the port. Host adapters in `src/adapters/` (`v1.ts`, `v2.ts`) are the implementations.
- Interface only, no classes. `port.ts` exports `interface HostPort` with two members:
  - `notify(message: string, variant: 'info' | 'success' | 'warning' | 'error'): void`. Fire-and-forget toast.
  - `reauthorize(): Promise<void>`. Triggers the OAuth re-auth flow. The adapter owns all OAuth client calls behind this method, so the core passes no tokens or client handles.
- Typed as `import type` in core modules, so there is no runtime import cost.
- The variant union is a closed set. Hosts must map it to their own toast styles.

## Flow (data in -> key calls -> data out)

- Core to host, toast: core code (e.g. request handling) calls `hostPort.notify(msg, variant)`. The adapter renders the toast. Returns void.
- Core to host, re-auth: auth code calls `hostPort.reauthorize()`. The adapter runs the OAuth flow and resolves once it completes or fails. The core receives only the resolved or rejected promise.
- No data flows back from host to core except the promise outcome.

## Integration (consumers and dependencies)

Consumers that import `HostPort` (verified by grep):
- `src/core/request/request-handler.ts` (`import type`): uses `notify` for request-path messages.
- `src/core/auth/auth-handler.ts` (`import type`): uses `reauthorize` and `notify` on auth flow.
- `src/adapters/v1.ts` and `src/adapters/v2.ts`: implement the port for each OpenCode version.
- `src/runtime.ts`: imports the type to wire the host into the runtime.

Dependencies: none. `port.ts` imports nothing, so it has no build or runtime coupling. Changing the interface affects all five files above. Adding a required member would break both adapters at compile time.

Not verified: the exact method bodies in the adapters and in `runtime.ts`. Only the import lines were checked.
