const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

// Reverse getTimestamp()'s transform: "2026-09-06T23-42-34-917Z" -> "2026-09-06T23:42:34.917Z"
const parseLogTimestamp = (timestampStr) => {
  const m = timestampStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return new Date(NaN);
  const [, datePart, hh, mm, ss, ms] = m;
  return new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`);
};

// Build the paired records from request/response files
const getPairedRecords = (logDir) => {
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('.json'));
  const records = [];
  const paired = new Set();

  for (const file of files) {
    if (paired.has(file)) continue;

    const isError = file.startsWith('error_');
    const timestampStr = file.replace(/^error_/, '').replace(/_(request|response)\.json$/, '');
    const timestamp = parseLogTimestamp(timestampStr);
    if (isNaN(timestamp.getTime())) {
      paired.add(file);
      continue;
    }

    // Find matching pair
    const type = file.includes('_request.') ? 'request' : 'response';
    const otherType = type === 'request' ? 'response' : 'request';
    const otherFileName = (isError ? 'error_' : '') + timestampStr + '_' + otherType + '.json';
    const otherFile = files.find(f => f === otherFileName);

    let requestData = null;
    let responseData = null;

    if (type === 'request') {
      requestData = loadLogFile(path.join(logDir, file));
      if (otherFile) {
        responseData = loadLogFile(path.join(logDir, otherFile));
        paired.add(file);
        paired.add(otherFile);
      }
    } else {
      // response without request - skip
      paired.add(file);
      continue;
    }

    if (!requestData) {
      paired.add(file);
      continue;
    }

    records.push({
      id: timestampStr,
      timestamp: timestamp.toISOString(),
      isError: isError || (responseData && responseData.error),
      email: requestData.email || null,
      model: requestData.model || responseData?.model || null,
      conversationId: requestData.conversationId || responseData?.conversationId || null,
      status: responseData?.status || (isError ? null : null),
      statusText: responseData?.statusText || null,
      credits: responseData?.usage?.credits,
      rate: responseData?.usage?.rate,
      inputTokens: responseData?.usage?.inputTokens,
      outputTokens: responseData?.usage?.outputTokens,
      request: requestData,
      response: responseData
    });
  }

  return records;
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
    const account = query.account?.toLowerCase();
    const status = query.status; // 'ok' or 'error'
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const q = query.q?.toLowerCase();
    const limit = Math.min(parseInt(query.limit) || 100, 500);
    const offset = parseInt(query.offset) || 0;

    // Filter records
    let filtered = records;

    if (account) {
      filtered = filtered.filter(r => r.email && r.email.toLowerCase().includes(account));
    }

    if (status === 'ok') {
      filtered = filtered.filter(r => !r.isError);
    } else if (status === 'error') {
      filtered = filtered.filter(r => r.isError);
    }

    if (from) {
      filtered = filtered.filter(r => new Date(r.timestamp) >= from);
    }

    if (to) {
      filtered = filtered.filter(r => new Date(r.timestamp) <= to);
    }

    if (q) {
      filtered = filtered.filter(r => {
        const model = (r.model || '').toLowerCase();
        const convId = (r.conversationId || '').toLowerCase();
        const url = (r.request?.url || '').toLowerCase();
        const errorMsg = (r.response?.error || r.request?.body?.error || '').toLowerCase();
        return model.includes(q) || convId.includes(q) || url.includes(q) || errorMsg.includes(q);
      });
    }

    // Sort newest first
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

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
      outputTokens: r.outputTokens
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
