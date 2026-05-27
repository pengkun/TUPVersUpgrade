const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || '127.0.0.1';
const BRIDGE_NAME = 'TUP Upgrade Bridge';
const BRIDGE_VERSION = '0.1.0-mac';
const ROOT = __dirname;
const ALLOWED_FIRMWARE_HOSTS = new Set(['cdn.xhsmartpiano.com']);
const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:8080',
  'http://127.0.0.1:18080',
  'http://localhost:8080',
  'http://localhost:18080',
  'https://upgrade.xhsmartpiano.com',
];
const ALLOWED_ORIGINS = new Set(
  (process.env.BRIDGE_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const BUILD_DIR = path.join(ROOT, '.build');
const BRIDGE_SRC = path.join(ROOT, 'native_midi_bridge.swift');
const BRIDGE_BIN = path.join(BUILD_DIR, 'native_midi_bridge');
const USB_PROBE_SRC = path.join(ROOT, 'native_usb_probe.c');
const USB_PROBE_BIN = path.join(BUILD_DIR, 'native_usb_probe');
const MODULE_CACHE_DIR = path.join(BUILD_DIR, 'module-cache');
const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024;

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

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGINS.has('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGINS.has('*');
}

function rejectDisallowedOrigin(req, res) {
  if (isAllowedOrigin(req)) return false;
  sendJson(res, 403, { code: 403, message: 'origin not allowed' });
  return true;
}

function bridgeStatus() {
  return {
    type: 'bridge-status',
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    platform: process.platform,
    arch: process.arch,
    host: HOST,
    port: PORT,
    nativeUsb: process.platform === 'darwin',
  };
}

function bridgeHomeHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>TUP升级助手</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 48px; color: #17202a; }
    code { background: #f1f3f5; padding: 2px 6px; border-radius: 4px; }
    .ok { color: #0f7b3f; font-weight: 700; }
  </style>
</head>
<body>
  <h1>TUP升级助手</h1>
  <p class="ok">本地升级服务已启动。</p>
  <p>请回到云端升级网页继续操作。这个本地服务只负责连接 Mac 上的 USB 设备并执行固件升级。</p>
  <p>状态接口：<code>/api/bridge/status</code></p>
  <p>设备检测：<code>/api/device/probe</code></p>
</body>
</html>`;
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function readRequestBody(req, limit = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function ensureNativeBridgeBuilt() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(MODULE_CACHE_DIR, { recursive: true });

  const needsBuild =
    !fs.existsSync(BRIDGE_BIN) ||
    fs.statSync(BRIDGE_BIN).mtimeMs < fs.statSync(BRIDGE_SRC).mtimeMs;

  if (!needsBuild) return;

  const result = spawnSync('swiftc', [BRIDGE_SRC, '-o', BRIDGE_BIN], {
    cwd: ROOT,
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: MODULE_CACHE_DIR },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`native bridge build failed: ${result.stderr || result.stdout || result.status}`);
  }
}

function ensureNativeUsbProbeBuilt() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const needsBuild =
    !fs.existsSync(USB_PROBE_BIN) ||
    fs.statSync(USB_PROBE_BIN).mtimeMs < fs.statSync(USB_PROBE_SRC).mtimeMs;

  if (!needsBuild) return;

  const result = spawnSync('clang', [
    USB_PROBE_SRC,
    '-framework', 'IOKit',
    '-framework', 'CoreFoundation',
    '-o', USB_PROBE_BIN,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`native USB probe build failed: ${result.stderr || result.stdout || result.status}`);
  }
}

function runBridge(args, options = {}) {
  ensureNativeBridgeBuilt();
  return spawn(BRIDGE_BIN, args, {
    cwd: ROOT,
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: MODULE_CACHE_DIR },
    ...options,
  });
}

function runUsbProbe(args = [], options = {}) {
  ensureNativeUsbProbeBuilt();
  return spawn(USB_PROBE_BIN, args,
  {
    cwd: ROOT,
    env: { ...process.env },
    ...options,
  });
}

async function handleNativeMidiStatus(req, res) {
  try {
    const child = runBridge(['status']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      if (code !== 0) {
        return sendJson(res, 500, { code: 500, message: stderr || stdout || `bridge exited ${code}` });
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) return sendJson(res, 500, { code: 500, message: 'native bridge returned empty status' });
      try {
        return sendJson(res, 200, JSON.parse(line));
      } catch (e) {
        return sendJson(res, 500, { code: 500, message: `invalid bridge status: ${e.message}` });
      }
    });
  } catch (e) {
    return sendJson(res, 500, { code: 500, message: e.message });
  }
}

async function handleNativeMidiUpgrade(req, res) {
  let tempFile = '';
  let child = null;

  try {
    const payload = await readJsonBody(req);
    const lines = Array.isArray(payload.lines) ? payload.lines : null;
    if (!lines || !lines.length) {
      return sendJson(res, 400, { code: 400, message: 'missing firmware lines' });
    }

    fs.mkdirSync(BUILD_DIR, { recursive: true });
    tempFile = path.join(BUILD_DIR, `firmware-${Date.now()}-${Math.random().toString(16).slice(2)}.upg`);
    fs.writeFileSync(tempFile, lines.map((line) => String(line).trim()).filter(Boolean).join('\n'), 'utf8');

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });

    child = runBridge(['upgrade', tempFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bridgeReportedError = false;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('"type":"error"') || text.includes('"type": "error"')) {
        bridgeReportedError = true;
      }
      res.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) res.write(`${JSON.stringify({ type: 'log', message })}\n`);
    });
    child.on('close', (code) => {
      if (code !== 0 && !bridgeReportedError) {
        res.write(`${JSON.stringify({ type: 'error', message: `native bridge exited ${code}` })}\n`);
      }
      if (tempFile) fs.rm(tempFile, { force: true }, () => {});
      res.end();
    });
    res.on('close', () => {
      if (!res.writableEnded && child) child.kill('SIGTERM');
    });
  } catch (e) {
    if (tempFile) fs.rm(tempFile, { force: true }, () => {});
    if (!res.headersSent) return sendJson(res, 500, { code: 500, message: e.message });
    res.write(`${JSON.stringify({ type: 'error', message: e.message })}\n`);
    res.end();
  }
}

async function handleNativeUsbProbe(req, res) {
  try {
    const child = runUsbProbe(['probe']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      if (code !== 0) {
        return sendJson(res, 500, { code: 500, message: stderr || stdout || `native USB probe exited ${code}` });
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) return sendJson(res, 500, { code: 500, message: 'native USB probe returned empty status' });
      try {
        return sendJson(res, 200, JSON.parse(line));
      } catch (e) {
        return sendJson(res, 500, { code: 500, message: `invalid native USB probe status: ${e.message}` });
      }
    });
  } catch (e) {
    return sendJson(res, 500, { code: 500, message: e.message });
  }
}

async function handleNativeUsbUpgrade(req, res) {
  let tempFile = '';
  let child = null;

  try {
    const payload = await readJsonBody(req);
    const lines = Array.isArray(payload.lines) ? payload.lines : null;
    if (!lines || !lines.length) {
      return sendJson(res, 400, { code: 400, message: 'missing firmware lines' });
    }

    fs.mkdirSync(BUILD_DIR, { recursive: true });
    tempFile = path.join(BUILD_DIR, `firmware-usb-${Date.now()}-${Math.random().toString(16).slice(2)}.upg`);
    fs.writeFileSync(tempFile, lines.map((line) => String(line).trim()).filter(Boolean).join('\n'), 'utf8');

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });

    child = runUsbProbe(['upgrade', tempFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bridgeReportedError = false;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('"type":"error"') || text.includes('"type": "error"')) {
        bridgeReportedError = true;
      }
      res.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) res.write(`${JSON.stringify({ type: 'log', message })}\n`);
    });
    child.on('close', (code) => {
      if (code !== 0 && !bridgeReportedError) {
        res.write(`${JSON.stringify({ type: 'error', message: `native USB bridge exited ${code}` })}\n`);
      }
      if (tempFile) fs.rm(tempFile, { force: true }, () => {});
      res.end();
    });
    res.on('close', () => {
      if (!res.writableEnded && child) child.kill('SIGTERM');
    });
  } catch (e) {
    if (tempFile) fs.rm(tempFile, { force: true }, () => {});
    if (!res.headersSent) return sendJson(res, 500, { code: 500, message: e.message });
    res.write(`${JSON.stringify({ type: 'error', message: e.message })}\n`);
    res.end();
  }
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
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(isAllowedOrigin(req) ? 204 : 403);
    res.end();
    return;
  }

  if (requestUrl.pathname.startsWith('/api/') && rejectDisallowedOrigin(req, res)) {
    return;
  }

  if ((requestUrl.pathname === '/api/bridge/status' || requestUrl.pathname === '/api/bridge/version') && req.method === 'GET') {
    sendJson(res, 200, bridgeStatus());
    return;
  }

  if (requestUrl.pathname === '/' && req.method === 'GET') {
    sendHtml(res, 200, bridgeHomeHtml());
    return;
  }

  if (requestUrl.pathname === '/api/firmware/proxy' && req.method === 'GET') {
    await handleFirmwareProxy(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === '/api/native-midi/status' && req.method === 'GET') {
    await handleNativeMidiStatus(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/native-midi/upgrade' && req.method === 'POST') {
    await handleNativeMidiUpgrade(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/native-usb/probe' && req.method === 'GET') {
    await handleNativeUsbProbe(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/device/probe' && req.method === 'GET') {
    await handleNativeUsbProbe(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/native-usb/upgrade' && req.method === 'POST') {
    await handleNativeUsbUpgrade(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/firmware/upgrade' && req.method === 'POST') {
    await handleNativeUsbUpgrade(req, res);
    return;
  }

  serveStatic(req, res, requestUrl);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
