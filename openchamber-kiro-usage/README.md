# openchamber-kiro-usage

OpenChamber extension that shows Kiro credit usage in a rail panel.

Shows per-account usage with progress bars and overall summary. Updates every 5 minutes or on refresh click. Sets a badge on the rail icon when usage exceeds 80%.

This extension shells out to the sibling repo's `scripts/kiro-usage.mjs --json`, so it only works when co-located with opencode-kiro-auth (i.e. this same repo checkout).

## Development Setup

### Building

The panel (`panel/main.js`) is a bundled IIFE (not ES modules). After any changes to `panel/panel-src/main.js`, run:

```bash
npm run build
```

This regenerates the bundled `panel/main.js` using esbuild.

### Dependencies

Install dependencies first:

```bash
npm install
```

### Loading in OpenChamber

For local development, see OpenChamber SDK docs for loading local extensions in dev mode. After building, you must quit and relaunch OpenChamber to pick up the new bundle.