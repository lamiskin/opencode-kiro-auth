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

## Agent Attribution Behavior

In `split=agent` mode, requests are classified from the captured log header or, when absent, from the local OpenCode session index:

- **captured**: the request log contains an agent name.
- **inferred**: a unique session/model/time candidate identifies the agent.
- **ambiguous**: multiple candidates overlap, so the service does not guess.
- **unknown**: no candidate, the request is outside index coverage, or the index is unavailable.

The response includes `meta.agentAttribution` with counts for `captured`, `inferred`, `ambiguous`, and the `unknown` reason counts (`no_candidate`, `db_unavailable`, and `out_of_coverage`). When the database/index cannot be opened or queried, `meta.agentIndexError` is also included. Logs and the OpenCode database are read-only; inference is best effort and cannot recover authoritative ownership for overlapping sessions or historical requests without captured headers.

The panel persists chart state under `kiro-usage:chart:v1` and color assignments under `kiro-usage:colors:v1`. Model and agent color namespaces are separate, ambiguous and unknown use distinct agent-only neutral colors, and invalid persisted color entries are discarded/repaired.

## Service API

The service exposes `/usage/series` (replacing legacy `/usage/hourly`):

### `GET /usage/series`

Returns credit usage time series with configurable bucket size and split dimension.

**Query Parameters:**
- `range`: `6h` | `24h` | `7d` | `30d` (default: `24h`)
- `from`/`to`: ISO 8601 timestamps (override range; `to` defaults to now)
- `bucket`: `hour` | `day` | `auto` (default: `auto`; uses `hour` for ≤7d, `day` for >7d)
- `split`: `model` | `agent` (default: `model`)

**Response:**
```json
{
  "from": "2026-10-08T04:47:17.472Z",
  "to": "2026-10-09T04:47:17.472Z",
  "bucket": "hour",
  "split": "model",
  "buckets": [
    {
      "start": "2026-10-08T04:00:00.000Z",
      "end": "2026-10-08T05:00:00.000Z",
      "total": 25.886,
      "count": 97,
      "series": {
        "gpt-5.6-luna": 22.297,
        "claude-haiku-4.5": 3.590
      }
    }
  ],
  "keys": [
    {
      "key": "gpt-5.6-luna",
      "total": 179.936,
      "count": 296,
      "rate": "0.6x"
    }
  ],
  "totals": {
    "credits": 513.816,
    "requests": 2220,
    "skipped": 14,
    "unreadable": 0
  },
  "now": "2026-10-09T04:47:17.472Z"
}
```

### `GET /requests`

Returns paired request/response records (unchanged contract + `agent` field).

**New optional parameters:**
- `agent`: exact string match on agent field
- `model`: exact string match on model field

**Example:** `/requests?limit=100` returns 100 newest records sorted by timestamp.

All records now include `agent` field (value: `'unknown'` for requests logged before agent tracking was enabled).

## Implementation Notes

**service/lib.js** implements:
- `getPairedRecords(logDir, opts)` with cache Map<filename, {mtimeMs, size, kind, summary}> storing SUMMARIES only (capped bodyError, no body fields)
- `getUsageSeries(logDir, opts)` with local-time bucketing (hour/day, DST-aware)
- Preset ranges (6h, 24h, 7d, 30d) return exactly N full buckets ending at bucket boundary
- Sync fs operations (deterministic, single-threaded loop); ponytail: move to fs.promises + concurrent if cold latency becomes user-facing bottleneck
- Prefilter by timestamp before stat/read for windowed queries; avoid stat of files outside [from,to)
- Cache validation: mtime+size check; files removed if no longer in directory listing
- List records (getPairedRecords) contain summary fields only; request/response full bodies returned only by /requests/detail
