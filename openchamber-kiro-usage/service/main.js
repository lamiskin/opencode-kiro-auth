const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getPairedRecords, getUsageSeries, getAgentIndex } = require('./lib');
const PORT = process.env.OPENCHAMBER_SERVICE_PORT || 0;
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';

if (!PORT || !TOKEN) {
  console.error('Missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/kiro-usage.mjs');

// Replicate logger.ts directory logic for cross-platform log path
const getLogDir = () => {
  const platform = process.platform;
  const base =
    platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  return path.join(base, 'kiro-logs');
};

// Parse URL query params into object
const parseQuery = (url) => {
  const query = {};
  const idx = url.indexOf('?');
  if (idx === -1) return query;
  new URL(url, 'http://localhost').searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return query;
};

// Load and parse a log file safely
const loadLogFile = (filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/usage') {
    execFile('node', [SCRIPT_PATH, '--json'], (error, stdout, stderr) => {
      if (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: stderr || error.message }));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (parseError) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Invalid JSON response' }));
      }
    });
    return;
  }

  // GET /usage/series?range=6h|24h|7d|30d&from=ISO&to=ISO&bucket=hour|day|auto&split=model|agent
  if (req.method === 'GET' && req.url.startsWith('/usage/series')) {
    const logDir = getLogDir();
    const query = parseQuery(req.url);
    const dbPath = process.env.OPENCODE_DB_PATH || path.join(process.env.XDG_DATA_HOME || path.join(require('os').homedir(), '.local', 'share'), 'opencode', 'opencode.db');

    const result = getUsageSeries(logDir, {
      range: query.range || '24h',
      from: query.from,
      to: query.to,
      bucket: query.bucket || 'auto',
      split: query.split || 'model',
      dbPath
    });

    if (result.code) {
      res.writeHead(result.code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /requests/detail?id=... - returns full single record (must be checked before the /requests prefix below)
  if (req.method === 'GET' && req.url.startsWith('/requests/detail')) {
    const logDir = getLogDir();

    if (!fs.existsSync(logDir)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ record: null, logDirMissing: true }));
      return;
    }

    const query = parseQuery(req.url);
    const id = query.id;

    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id parameter' }));
      return;
    }

    // id is the bare timestamp string (error_ prefix already stripped by getPairedRecords).
    // Try the plain-success filenames first, then fall back to the error_-prefixed filenames.
    const timestampStr = id;
    let isError = false;
    let requestData = loadLogFile(path.join(logDir, `${timestampStr}_request.json`));
    let responseData = loadLogFile(path.join(logDir, `${timestampStr}_response.json`));
    if (!requestData) {
      isError = true;
      requestData = loadLogFile(path.join(logDir, `error_${timestampStr}_request.json`));
      responseData = loadLogFile(path.join(logDir, `error_${timestampStr}_response.json`));
    }

    if (!requestData) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Record not found' }));
      return;
    }

    const timestamp = parseLogTimestamp(timestampStr);

    const record = {
      id,
      timestamp: timestamp.toISOString(),
      isError: isError || (responseData && responseData.error),
      email: requestData.email || null,
      model: requestData.model || responseData?.model || null,
      conversationId: requestData.conversationId || responseData?.conversationId || null,
      status: responseData?.status || null,
      statusText: responseData?.statusText || null,
      credits: responseData?.usage?.credits,
      rate: responseData?.usage?.rate,
      request: requestData,
      response: responseData
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ record }));
    return;
  }

  // GET /requests - returns paired request/response logs
  if (req.method === 'GET' && req.url.startsWith('/requests')) {
    const logDir = getLogDir();

    // Check if log dir exists
    if (!fs.existsSync(logDir)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records: [], total: 0, logDirMissing: true }));
      return;
    }

    let records;
    try {
      records = getPairedRecords(logDir);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records: [], total: 0, logDirMissing: true }));
      return;
    }

    // Parse query params
    const query = parseQuery(req.url);
    const account = query.account;
    const status = query.status; // 'ok' or 'error'
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const q = query.q;
    const agent = query.agent;
    const model = query.model;
    const limit = Math.min(parseInt(query.limit) || 100, 500);
    const offset = parseInt(query.offset) || 0;

    const opts = { account, status, from, to, q, agent, model, limit, offset };
    const result = getPairedRecords(logDir, opts);
    const { records: paginated, total } = result;

    // Return summary-only records (no request/response payload)
    const summary = paginated.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      isError: r.isError,
      email: r.email,
      model: r.model,
      conversationId: r.conversationId,
      status: r.status,
      statusText: r.statusText,
      credits: r.credits,
      rate: r.rate,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      agent: r.agent
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ records: summary, total }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kiro usage service listening on http://127.0.0.1:${PORT}`);
});
