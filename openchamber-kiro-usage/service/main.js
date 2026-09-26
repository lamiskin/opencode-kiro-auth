const http = require('http');
const { execFile } = require('child_process');
const path = require('path');

const PORT = process.env.OPENCHAMBER_SERVICE_PORT || 0;
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';

if (!PORT || !TOKEN) {
  console.error('Missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/kiro-usage.mjs');

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
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kiro usage service listening on http://127.0.0.1:${PORT}`);
});