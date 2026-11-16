import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { db, pruneHistory, pruneUploadCache } from './db.js';
import { handleApi } from './api.js';
import { accountCounts, importProfile, listProfiles } from './accounts.js';
import { authRequired } from './session.js';
import { ensureBootstrapKey } from './keys.js';
import { startAutomation } from './scheduler.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest']);
const cache = new Map();

function log(level, message, extra) {
  if (level === 'debug' && config.logLevel !== 'debug') return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) res.setHeader('access-control-allow-origin', origin === 'null' ? '*' : origin);
  else res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,prefer,x-requested-with');
  res.setHeader('access-control-expose-headers', 'x-job-id,retry-after');
  res.setHeader('access-control-max-age', '86400');
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(fallback)) return serveStatic(req, res, '/index.html');
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  const headers = {
    'content-type': MIME[extension] || 'application/octet-stream',
    etag,
    'cache-control': 'no-cache'
  };
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip && COMPRESSIBLE.has(extension)) {
    const key = `${filePath}:${stat.mtimeMs}`;
    let cached = cache.get(key);
    if (!cached) {
      const source = fs.readFileSync(filePath);
      cached = zlib.gzipSync(source, { level: 6 });
      if (cache.size > 30) cache.clear();
      cache.set(key, cached);
    }
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = cached.length;
    headers.vary = 'accept-encoding';
    res.writeHead(200, headers);
    res.end(cached);
    return;
  }
  headers['content-length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(fs.readFileSync(filePath));
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');
  if (isApi) cors(req, res);

  if (req.method === 'OPTIONS' && (isApi || url.pathname === '/healthz')) {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.pathname === '/healthz' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
      const handled = await handleApi(req, res, url);
      if (handled !== false) return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    log('error', `${req.method} ${url.pathname} failed: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'server_error', message: 'Internal server error.' } }));
    } else {
      res.end();
    }
  }
});

pruneHistory();
pruneUploadCache();

setInterval(() => {
  try {
    pruneHistory();
    pruneUploadCache();
  } catch (error) {
    log('error', `Retention cleanup failed: ${error.message}`);
  }
}, 6 * 3600000).unref();

async function bootstrap() {
  try {
    const bootstrapKey = ensureBootstrapKey();
    if (bootstrapKey?.created) log('info', 'Environment API key registered (API_KEY).');
  } catch (error) {
    log('error', `Could not register bootstrap API key: ${error.message}`);
  }
  if (config.cookieFile) {
    try {
      if (!fs.existsSync(config.cookieFile)) {
        log('warn', `COOKIE_FILE not found: ${config.cookieFile}`);
      } else if (listProfiles().length) {
        log('info', 'COOKIE_FILE ignored: a cookie profile already exists.');
      } else {
        const content = fs.readFileSync(config.cookieFile, 'utf8');
        const profile = await importProfile({ name: config.cookieName, content });
        log('info', `Cookie file imported automatically (${profile.name}, ${profile.cookieCount} cookies).`);
      }
    } catch (error) {
      log('error', `Automatic cookie import failed: ${error.message}`);
    }
  }
  startAutomation();
}

server.listen(config.port, config.host, () => {
  const counts = accountCounts();
  log('info', `image-studio ${config.port} listening on ${config.host}`);
  log('info', `data directory: ${config.dataDir}`);
  log('info', `accounts: ${counts.usable}/${counts.accounts} usable across ${counts.profiles} profile(s)`);
  if (!authRequired()) log('warn', 'ADMIN_PASSWORD is not set; the dashboard is open to anyone who can reach it.');
  if (!config.bootstrapApiKey && counts.usable === 0) log('warn', 'No API key and no usable accounts yet. Open the dashboard to import a cookie file.');
  bootstrap().catch(error => log('error', `Bootstrap failed: ${error.message}`));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', `received ${signal}, shutting down`);
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
