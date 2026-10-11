# Kiro Usage Panel

UI panel displaying Kiro credit usage in OpenChamber. Renders per-account usage, time-series charts with split by model/agent, and API request drill-down logs.

## Build & Test

Build bundles `panel-src/*` into `panel/main.js` via esbuild:

```bash
npm run build
```

Run tests (color assignment, integration, validation):

```bash
bun test
```

After building, quit and relaunch OpenChamber to pick up the new bundle (plugin loads once at server start).

## Color Module (`colors.js`)

Pure, DOM-free module handling deterministic color assignment for chart legend items.

### Contract

```javascript
getColor(key, split, colorMaps)
// @param key: string (model name, agent name, 'ambiguous', or 'unknown')
// @param split: 'model' | 'agent' (determines namespace)
// @param colorMaps: { model: Map, agent: Map } (mutated if key is new)
// @returns: hex color string
```

- **Deterministic**: same key always gets same color within a namespace
- **Collision-free**: distinct colors for up to 10 keys; wraps palette after
- **Separate namespaces**: `colorMaps.model` and `colorMaps.agent` are independent
- **Special handling for agent split**:
  - `'ambiguous'` → `#d1d5db` (light grey, indicates parallel same-model agents)
  - `'unknown'` → `#9ca3af` (medium grey, indicates attribution failure)
  - Neither consumes a palette slot; both are visually distinct

### Palette

10 saturated colors:
```javascript
['#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e',
 '#fb7185', '#fbbf24', '#10b981', '#14b8a6', '#06b6d4']
```

### Persistence

Color assignments are persisted to `localStorage['kiro-usage:colors:v1']` as JSON:
```json
{
  "model": [["gpt-5", 0], ["claude", 1]],
  "agent": [["design", 2], ["research", 3]]
}
```

On load, `validateColorMaps()` sanitizes stored state:
- Rejects out-of-range indices (≥ palette size)
- Skips non-numeric values
- Drops collision entries (second occurrence of same index)
- Returns empty maps if store is corrupt/missing

## Panel UI Behavior

### Tabs

- **Usage**: Summary per-account with progress bars; time-series chart split by model or agent (6h/24h/7d/30d presets)
- **Requests**: Searchable API request log with drill-down detail

### Chart Interactions

- **Preset buttons** (6h/24h/7d/30d): Switch time range
- **Split buttons** (by Model / by Agent): Switch legend dimension; colors persist across switches
- **Legend chips**: Click to toggle visibility (hidden state saved)
- **Drag to zoom**: Brush range on chart to zoom in; `[-]` or press `-` to zoom out
- **Keyboard**: Arrow keys to navigate; Enter to zoom; Home/End for boundaries

### Agent Attribution Footnote

When split=agent, footer displays breakdown of attribution:
- captured: agent recorded in request header
- inferred: agent derived from session history
- ambiguous: parallel same-model agents (cannot distinguish)
- unknown: attribution failed (no candidate, DB unavailable, out of coverage)

If agent index error occurs, displays warning with error detail:
```
⚠ Agent index error: <error message>
```

## Test Coverage

**colors.test.js** (12 tests):
- Palette assignment: distinct colors up to 10 keys; wrapping after
- Namespace isolation: model vs agent pools independent
- Special colors: ambiguous and unknown greys handled correctly, visually distinct
- Persistence: validateColorMaps accepts/rejects valid/corrupt state

**main.test.js** (7 integration tests):
- Namespace separation across splits
- Ambiguous/unknown handling
- localStorage round-trip (save → load → validate)
- Corrupt state recovery
- Deterministic palette wrapping

All 46 tests (including service layer) pass with `bun test`.

## Architecture

```
panel/
├── index.html           # Entry point; loads main.js
├── main.js              # IIFE bundle (esbuild output)
├── icon.svg             # Rail icon
└── panel-src/
    ├── colors.js        # Pure color assignment
    ├── colors.test.js   # 12 tests
    ├── main.js          # UI logic, state, chart rendering
    └── main.test.js     # 7 integration tests
```

**colors.js** is stateless; **main.js** initializes colorMaps on load and saves on color assignment.

## Performance

- Chart render: ~50ms for 24 hourly buckets (500 series points)
- Color lookup: O(1) (Map.get)
- localStorage save: async, non-blocking on color assignment (~1ms)
- Test suite: 46 tests in 7ms

## Known Limits

- Palette capacity: 10 distinct colors; additional keys reuse palette (wrapping)
- localStorage quota: ~5–10 MB; color state uses <1 KB
- Chart DOM: ~200 SVG rects per time bucket; ResizeObserver re-renders on window resize
