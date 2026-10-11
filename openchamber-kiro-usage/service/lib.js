const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { buildIndex, resolve: resolveAgent } = require('./agent-index');

// File cache: Map<filename, {mtimeMs, size, kind, summary}> per FILE SUMMARY only
// kind = 'request' or 'response'; summary is already capped
const fileCache = new Map();
const filenameInfoCache = new Map(); // Map<filename, {ts, isError, kind, timestampStr}>

// Agent index cache: {key, index, builtAt}
let agentIndexCache = null;
let agentIndexError = null;

// Export error state for testing/diagnostics
const getAgentIndexError = () => agentIndexError;

// Index lifecycle: cache key = mtime+size of opencode.db AND opencode.db-wal; rebuild every 30s
const getIndexCacheKey = (dbPath, now = () => new Date()) => {
  const walPath = dbPath + '-wal';
  try {
    const dbStat = fs.statSync(dbPath);
    const walStat = fs.existsSync(walPath) ? fs.statSync(walPath) : { mtimeMs: 0, size: 0 };
    return `${dbStat.mtimeMs}:${dbStat.size}:${walStat.mtimeMs}:${walStat.size}`;
  } catch {
    return null;
  }
};

// Load agent index from DB with caching and error handling
const getAgentIndex = (dbPath, injectedOpenDb, injectedNow) => {
  const now = injectedNow || (() => new Date());
  const openDb = injectedOpenDb || ((p) => new DatabaseSync(p, { readOnly: true }));

  // Check if DB file exists
  const cacheKey = getIndexCacheKey(dbPath, now);
  if (cacheKey === null) {
    // DB file missing or cannot be stat-ed
    agentIndexError = `db_not_found: ${dbPath}`;
    return buildIndex([]);
  }

  // Check if cache is still valid (same key) and not stale (< 30s)
  if (agentIndexCache && agentIndexCache.key === cacheKey) {
    if (now().getTime() - agentIndexCache.builtAt < 30000) {
      agentIndexError = null; // clear on valid cache hit
      return agentIndexCache.index;
    }
  }

  // Try to rebuild
  try {
    const db = openDb(dbPath);
    db.exec('PRAGMA busy_timeout=2000');

    const rows = [];
    let sessionMessageError = null;

    // Query session_message (current): extract both model.id and agent from JSON
    try {
      const stmt = db.prepare(
        `SELECT json_extract(data, '$.model.id') model_id,
                json_extract(data, '$.agent') agent,
                json_extract(data, '$.time.created') time_created,
                json_extract(data, '$.time.completed') time_completed,
                session_id
         FROM session_message
         WHERE type = 'assistant'
           AND json_extract(data, '$.model.providerID') = 'kiro'`
      );
      const rows1 = stmt.all();
      for (const r of rows1) {
        if (r.model_id && r.agent && r.time_created) {
          rows.push({
            model_id: r.model_id,
            agent: r.agent,
            time_created: r.time_created,
            time_completed: r.time_completed || null,
            session_id: r.session_id
          });
        }
      }
    } catch (e) {
      // session_message query is required; record error
      sessionMessageError = e.message;
    }

    // Query legacy message table if it exists (soft fail if table missing)
    try {
      const stmt = db.prepare(
        `SELECT json_extract(data, '$.model.id') model_id,
                json_extract(data, '$.agent') agent,
                json_extract(data, '$.time.created') time_created,
                json_extract(data, '$.time.completed') time_completed,
                session_id
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'
           AND json_extract(data, '$.model.providerID') = 'kiro'`
      );
      const rows2 = stmt.all();
      for (const r of rows2) {
        if (r.model_id && r.agent && r.time_created) {
          rows.push({
            model_id: r.model_id,
            agent: r.agent,
            time_created: r.time_created,
            time_completed: r.time_completed || null,
            session_id: r.session_id
          });
        }
      }
    } catch (e) {
      // legacy message table missing is OK; other errors are not
      if (!e.message.includes('no such table')) {
        sessionMessageError = sessionMessageError || e.message;
      }
    }

    db.close();

    // If session_message query failed, surface it
    if (sessionMessageError) {
      agentIndexError = `query_error: ${sessionMessageError}`;
      return buildIndex([]);
    }

    // If no rows loaded, report db_empty
    if (rows.length === 0) {
      agentIndexError = 'db_empty';
    }

    const index = buildIndex(rows);
    agentIndexCache = {
      key: cacheKey,
      index,
      builtAt: now().getTime(),
      coverage: rows.length > 0 ? {
        from: Math.min(...rows.map(r => r.time_created)),
        to: Math.max(...rows.map(r => r.time_created))
      } : null
    };

    if (!sessionMessageError) {
      agentIndexError = null; // clear on successful load
    }

    return index;
  } catch (error) {
    // On outer DB error, keep previous index if any
    agentIndexError = error.message;
    if (agentIndexCache) {
      return agentIndexCache.index;
    }
    // No previous index, return empty
    return buildIndex([]);
  }
};

// Parse timestamp from filename: "2026-09-06T23-42-34-917Z" -> Date
const parseLogTimestamp = (timestampStr) => {
  const m = timestampStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return new Date(NaN);
  const [, datePart, hh, mm, ss, ms] = m;
  return new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`);
};

// Extract filename info (ts, isError, kind) - cached
const getFileInfo = (filename) => {
  if (filenameInfoCache.has(filename)) {
    return filenameInfoCache.get(filename);
  }

  const isError = filename.startsWith('error_');
  const match = filename.match(/^(error_)?(.+?)_(request|response)\.json$/);
  if (!match) return null;

  const [, , timestampStr, kind] = match;
  const ts = parseLogTimestamp(timestampStr);
  if (isNaN(ts.getTime())) return null;

  const info = { ts, isError, kind, timestampStr };
  filenameInfoCache.set(filename, info);
  return info;
};

// Summarize response JSON (capped, no body)
const summarizeResponse = (json) => {
  return {
    status: json.status,
    statusText: json.statusText,
    error: json.error || null,
    model: json.model || null,
    conversationId: json.conversationId || null,
    agent: json.agent || null,
    credits: json.usage?.credits,
    rate: json.usage?.rate || null
  };
};

// Summarize request JSON (capped, no body)
const summarizeRequest = (json) => {
  return {
    sessionID: json.sessionID,
    model: json.model || null,
    conversationId: json.conversationId || null
  };
};

// Load and cache response/request summaries
const loadLogFile = (filePath, filename, kind, fsWrapper = fs) => {
  // Check file cache
  try {
    const stat = fsWrapper.statSync(filePath);
    const cacheKey = `${filename}:${stat.mtimeMs}:${stat.size}`;

    if (fileCache.has(cacheKey)) {
      return fileCache.get(cacheKey);
    }

    // Load file
    let content;
    try {
      content = fsWrapper.readFileSync(filePath, 'utf-8');
    } catch {
      return null; // unreadable
    }

    let json;
    try {
      json = JSON.parse(content);
    } catch {
      return null; // unparseable
    }

    const summary = kind === 'response' ? summarizeResponse(json) : summarizeRequest(json);
    fileCache.set(cacheKey, summary);
    return summary;
  } catch {
    return null;
  }
};

// Get log directory
const getLogDir = () => {
  return path.join(process.env.HOME || os.homedir(), '.config', 'opencode', 'kiro-logs');
};

// Build all paired records from a range
// Contract: [from, to) inclusive on from, exclusive on to; retains zero-credit records; uses res filename timestamp
const getPairedRecords = (logDir, { from: fromISO, to: toISO, account, status, q, agent, model, limit, offset } = {}) => {
  const fromDate = fromISO ? new Date(fromISO) : new Date(0);
  const toDate = toISO ? new Date(toISO) : new Date();

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return { error: 'invalid date range', code: 400, records: [], total: 0 };
  }

  if (!fs.existsSync(logDir)) {
    return { records: [], total: 0, logDirMissing: true };
  }

  // Build request summaries
  const requests = new Map(); // conversationId -> { req, res, credits }
  // Prefilter by suffix before stat/read
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('_request.json') || f.endsWith('_response.json'));

  for (const file of files) {
    const info = getFileInfo(file);
    // Edge: [from, to) — inclusive from, exclusive to
    if (!info || info.ts < fromDate || info.ts >= toDate) continue;

    const filePath = path.join(logDir, file);
    const summary = loadLogFile(filePath, file, info.kind);
    if (!summary) continue;

    const convId = summary.conversationId;
    if (!convId) continue;

    if (!requests.has(convId)) {
      requests.set(convId, {});
    }

    const record = requests.get(convId);
    if (info.kind === 'request') {
      record.req = summary;
      record.reqTimestamp = info.ts;
    } else {
      record.res = summary;
      record.credits = summary.credits; // can be null/undefined; contract: retain zero-credit records
      record.resTimestamp = info.ts;
    }
  }

  // Filter complete pairs and apply search/filter criteria
  let pairs = Array.from(requests.values())
    .filter(r => r.req && r.res)
    .map(r => ({
      id: r.req.conversationId,
      timestamp: (r.resTimestamp || r.reqTimestamp || new Date(0)).toISOString(),
      isError: r.res.error || (r.res.status && r.res.status >= 400) || false,
      email: r.req.email || null,
      sessionID: r.req.sessionID,
      model: r.req.model || r.res.model,
      conversationId: r.req.conversationId,
      status: r.res.status,
      statusText: r.res.statusText || null,
      credits: r.credits, // contract: retain zero-credit records (null/undefined passed through)
      agent: r.res.agent || null
    }));

  // Apply filters
  if (status === 'error') {
    pairs = pairs.filter(r => r.isError);
  } else if (status === 'ok') {
    pairs = pairs.filter(r => !r.isError);
  }

  if (model) {
    pairs = pairs.filter(r => r.model === model);
  }

  if (agent) {
    pairs = pairs.filter(r => r.agent === agent);
  }

  if (q) {
    const lowerQ = q.toLowerCase();
    pairs = pairs.filter(r => {
      return (r.email && r.email.toLowerCase().includes(lowerQ)) ||
             (r.model && r.model.toLowerCase().includes(lowerQ)) ||
             (r.sessionID && r.sessionID.toLowerCase().includes(lowerQ));
    });
  }

  const total = pairs.length;
  const offsetNum = offset || 0;
  const limitNum = Math.min(limit || 100, 500);
  const paginated = pairs.slice(offsetNum, offsetNum + limitNum);

  return { records: paginated, total };
};


// Bucket and split by model or agent
// Helper: align date to local clock boundary (start of hour or day)
const alignToLocalBoundary = (date, bucketMs) => { // exported for test
  const d = new Date(date);
  if (bucketMs === 3600000) { // hour
    d.setMinutes(0, 0, 0);
  } else if (bucketMs === 86400000) { // day
    d.setHours(0, 0, 0, 0);
  }
  return d;
};

// Helper: step date by calendar increment (not fixed ms)
const stepDateByBucket = (date, bucketMs) => {
  const d = new Date(date);
  if (bucketMs === 3600000) { // hour
    d.setHours(d.getHours() + 1);
  } else if (bucketMs === 86400000) { // day
    d.setDate(d.getDate() + 1);
  }
  return d;
};

// Helper: step date back by calendar increment (days follow local midnight across DST)
const stepDateBackByBucket = (date, bucketMs) => {
  const d = new Date(date);
  if (bucketMs === 86400000) d.setDate(d.getDate() - 1);
  else d.setTime(d.getTime() - bucketMs);
  return d;
};

const getUsageSeries = (logDir, { range = '24h', from, to, bucket = 'auto', split = 'model', now: injectedNow, dbPath, fsWrapper = fs } = {}) => {
  const now = injectedNow ? new Date(injectedNow) : new Date();

  // Parse date range
  let fromDate, toDate, isPreset = false, presetBucketMs = null, presetRange = null;
  if (from && to) {
    fromDate = new Date(from);
    toDate = new Date(to);
  } else {
    // Parse range
    const match = range.match(/^(\d+)([hdw])$/);
    if (!match) return { error: 'invalid range', code: 400 };

    const [, num, unit] = match;
    const ms = {
      h: 3600000,
      d: 86400000,
      w: 604800000
    }[unit] * parseInt(num, 10);

    toDate = new Date(now);
    fromDate = new Date(toDate.getTime() - ms);
    isPreset = true;
    presetRange = range;
    // Determine bucket from preset: 6h/24h/7d -> hour, 30d+ -> day
    if ((num === '6' && unit === 'h') || (num === '24' && unit === 'h') || (num === '7' && unit === 'd')) {
      presetBucketMs = 3600000; // hour
    } else if ((num === '30' && unit === 'd') || (num === '1' && unit === 'w')) {
      presetBucketMs = 86400000; // day
    } else {
      presetBucketMs = ms <= 86400000 ? 3600000 : 86400000; // fallback: span-based
    }
  }

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return { error: 'invalid date range', code: 400 };
  }

  if (!fsWrapper.existsSync(logDir)) {
    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      bucket: 'auto',
      split,
      buckets: [],
      keys: [],
      totals: { credits: 0, requests: 0, skipped: 0, unreadable: 0 },
      now: now.toISOString(),
      logDirMissing: true
    };
  }

  // Determine bucket size
  let bucketSizeMs;
  const rangeMs = toDate.getTime() - fromDate.getTime();
  if (bucket === 'auto') {
    if (isPreset && presetBucketMs !== null) {
      bucketSizeMs = presetBucketMs;
    } else {
      // Custom window: span-based auto
      bucketSizeMs = rangeMs <= 604800000 ? 3600000 : 86400000; // <=7d -> hour, else day
    }
  } else {
    bucketSizeMs = bucket === 'hour' ? 3600000 : 86400000;
  }

  // Create buckets with calendar alignment
  // Contract: presets generate EXACT bucket count including current partial bucket, aligned to boundary
  // For presets: align to, work backward; for custom windows: align from, work forward
  const buckets = [];
  let current, end;
   if (isPreset) {
      // For presets: generate exactly N buckets ending at the end of the current (partial) bucket
      let numBuckets;
      if (presetRange === '6h') numBuckets = 6;
      else if (presetRange === '24h') numBuckets = 24;
      else if (presetRange === '7d') numBuckets = 168;
      else if (presetRange === '30d') numBuckets = 30;
      else {
        // Fallback for other presets
        const spanMs = toDate.getTime() - fromDate.getTime();
        numBuckets = Math.round(spanMs / bucketSizeMs);
      }

      // End of current bucket is the boundary at or after now
      end = alignToLocalBoundary(toDate, bucketSizeMs);
      if (end.getTime() < toDate.getTime()) {
        end = stepDateByBucket(end, bucketSizeMs);
      }

      // Build buckets backwards from end, exactly numBuckets
      const bucketList = [];
      current = new Date(end.getTime());
      for (let i = 0; i < numBuckets; i++) {
        const bucketStart = stepDateBackByBucket(current, bucketSizeMs);
        bucketList.unshift({
          start: bucketStart.toISOString(),
          end: current.toISOString(),
          total: 0,
          count: 0,
          series: {}
        });
        current = bucketStart;
      }
      buckets.push(...bucketList);
   } else {
     // Custom window: align from, step forward while < to
     current = alignToLocalBoundary(fromDate, bucketSizeMs);
     while (current < toDate) {
       end = stepDateByBucket(current, bucketSizeMs);
       buckets.push({
         start: current.toISOString(),
         end: end.toISOString(),
         total: 0,
         count: 0,
         series: {}
       });
       current = end;
     }
   }

  const bucketName = bucketSizeMs === 3600000 ? 'hour' : 'day';

  // Read response files in window [from, to), resolve agent for split=agent
  // Contract: prefilter by suffix, sparse binary-search agent index
  const files = fsWrapper.readdirSync(logDir).filter(f => f.endsWith('_response.json'));
  const keyMap = new Map(); // key -> {total, count, rate}
  const agentIndex = split === 'agent' ? getAgentIndex(dbPath) : null;
  let totalCredits = 0;
  let totalRequests = 0;
  let skipped = 0;
  let unreadable = 0;

  for (const file of files) {
    const info = getFileInfo(file);
    if (!info || info.kind !== 'response') continue;

    const timestamp = info.ts;
    if (timestamp < fromDate || timestamp >= toDate) continue; // in-window filter [from, to)

    const filePath = path.join(logDir, file);
    const summary = loadLogFile(filePath, file, 'response', fsWrapper);

    if (!summary) {
      unreadable++;
      continue;
    }

    if (summary.credits === null || summary.credits === undefined) {
      skipped++;
      continue;
    }

    // Find bucket
    let bucket = null;
    for (const b of buckets) {
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      if (timestamp.getTime() >= bStart && timestamp.getTime() < bEnd) {
        bucket = b;
        break;
      }
    }
    if (!bucket) continue;

    let key, agentSource;
    if (split === 'model') {
      key = summary.model || 'unknown';
      agentSource = 'captured';
    } else {
      if (summary.agent) {
        key = summary.agent;
        agentSource = 'captured';
      } else if (agentIndex) {
        const resolved = resolveAgent(agentIndex, { t: timestamp.getTime(), model: summary.model });
        if (resolved.source === 'inferred') {
          key = resolved.agent;
          agentSource = 'inferred';
        } else if (resolved.source === 'ambiguous') {
          key = 'ambiguous';
          agentSource = 'ambiguous';
        } else {
          key = 'unknown';
          agentSource = resolved.reason || 'out_of_coverage';
        }
      } else {
        key = 'unknown';
        agentSource = 'db_unavailable';
      }
    }
    bucket.total += summary.credits;
    bucket.count += 1;
    bucket.series[key] = (bucket.series[key] || 0) + summary.credits;

    if (!keyMap.has(key)) {
      keyMap.set(key, { total: 0, count: 0, rate: null });
    }
    const km = keyMap.get(key);
    km.total += summary.credits;
    km.count += 1;
    if (summary.rate !== null && summary.rate !== undefined) {
      km.rate = summary.rate;
    }

    totalCredits += summary.credits;
    totalRequests += 1;
  }

  // Build keys array sorted by total desc
  const keys = Array.from(keyMap.entries())
    .filter(([, v]) => v.total > 0)
    .map(([k, v]) => ({
      key: k,
      total: v.total,
      count: v.count,
      rate: split === 'model' ? v.rate : null
    }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

  // If split=agent, build agentAttribution from key sources
  // Contract: deterministic fixed-window attribution recount
  let agentAttribution = split === 'agent' ? {
    captured: 0,
    inferred: 0,
    ambiguous: 0,
     unknown: { no_candidate: 0, db_unavailable: 0, out_of_coverage: 0 },
     dbCoverage: agentIndexCache?.coverage || null
  } : undefined;

  // Count agent attribution by walking through buckets and resolving sources (split=agent only)
  if (split === 'agent' && agentAttribution) {
    // Re-scan files to count attribution sources deterministically
    for (const file of files) {
      const info = getFileInfo(file);
      if (!info || info.kind !== 'response') continue;
      const timestamp = info.ts;
      if (timestamp < fromDate || timestamp >= toDate) continue;

      const filePath = path.join(logDir, file);
      const summary = loadLogFile(filePath, file, 'response', fsWrapper);
      if (!summary || summary.credits === null || summary.credits === undefined) continue;

      if (summary.agent) {
        agentAttribution.captured++;
      } else if (agentIndex) {
        const resolved = resolveAgent(agentIndex, { t: timestamp.getTime(), model: summary.model });
        if (resolved.source === 'inferred') agentAttribution.inferred++;
        else if (resolved.source === 'ambiguous') agentAttribution.ambiguous++;
        else {
          const reason = resolved.reason || 'out_of_coverage';
          if (agentAttribution.unknown[reason] !== undefined) agentAttribution.unknown[reason]++;
        }
      } else {
        agentAttribution.unknown.db_unavailable++;
      }
    }
  }

  const result = {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    bucket: bucketName,
    split,
    buckets,
    keys,
    totals: { credits: totalCredits, requests: totalRequests, skipped, unreadable },
    now: now.toISOString()
  };

  if (split === 'agent') {
    result.meta = {
      agentAttribution
    };
    if (agentIndexError) {
      result.meta.agentIndexError = agentIndexError;
    }
  }

  return result;
};

module.exports = { getPairedRecords, getUsageSeries, parseLogTimestamp, getAgentIndex, stepDateByBucket, alignToLocalBoundary, getAgentIndexError };
