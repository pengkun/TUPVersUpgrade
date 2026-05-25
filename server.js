const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const ALLOWED_FIRMWARE_HOSTS = new Set(['cdn.xhsmartpiano.com']);

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleFirmwareProxy(req, res, requestUrl) {
  const url = requestUrl.searchParams.get('url');
  if (!url) return sendJson(res, 400, { code: 400, message: 'missing url query param' });

  let target;
  try {
    target = new URL(url);
  } catch {
    return sendJson(res, 400, { code: 400, message: 'invalid url' });
  }

  if (target.protocol !== 'https:') {
    return sendJson(res, 400, { code: 400, message: 'only https is allowed' });
  }
  if (!ALLOWED_FIRMWARE_HOSTS.has(target.hostname)) {
    return sendJson(res, 403, { code: 403, message: 'host not allowed' });
  }

  try {
    const upstream = await fetch(target.toString(), { method: 'GET' });
    if (!upstream.ok) {
      return sendJson(res, 502, { code: 502, message: `upstream status ${upstream.status}` });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
      'X-Proxy-By': 'TUPVersUpgrade',
    });
    res.end(buffer);
  } catch (e) {
    return sendJson(res, 502, { code: 502, message: `proxy fetch failed: ${e.message}` });
  }
}

function serveStatic(req, res, requestUrl) {
  let pathname = requestUrl.pathname;
  if (pathname === '/') pathname = '/index.html';

  const safePath = path.normalize(pathname).replace(/^\/+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === '/api/firmware/proxy' && req.method === 'GET') {
    await handleFirmwareProxy(req, res, requestUrl);
    return;
  }

  serveStatic(req, res, requestUrl);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
