# Agent instructions for opencode-kiro-auth

This plugin is loaded by OpenCode directly from this repo path (see the
user's `opencode.json` plugin list), and OpenCode loads the compiled
`dist/index.js` (per `package.json` `main`), not `src/` directly.

**After any change under `src/`, run `npm run build` before considering the
change complete.** Source edits alone have no effect until `dist/` is
rebuilt. The user launches OpenCode through a GUI app (OpenChamber), so a
stale `dist/` silently keeps running old behavior with no error.

After building, remind the user that OpenChamber/OpenCode must be fully
quit and relaunched (not just a new chat window) to pick up the new `dist/`,
since the plugin only loads once at server process start.

Run `bun test` after any `src/` change too, and confirm no regressions
before calling the work done.
