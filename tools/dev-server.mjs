// PinVideoBoard — локальный dev-сервер.
// Раздаёт репозиторий на http://127.0.0.1:8940 и принимает сохранения
// data/db.js без GitHub-токена (DEV_MODE в js/config.js).
// Запуск: node tools/dev-server.mjs  [порт можно переопределить: PVB_PORT=9000]
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'db.js');
const PORT = Number(process.env.PVB_PORT || 8940);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function isLocalOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || '');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (origin && !isLocalOrigin(origin)) {
    res.writeHead(403).end('forbidden origin');
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  // ---------- API ----------
  if (url.pathname === '/api/ping' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, v: 1, app: 'pinvideoboard-dev' }));
    return;
  }

  if (url.pathname === '/api/dev-save' && req.method === 'POST') {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      try {
        const json = JSON.parse(body);
        const content = typeof json.content === 'string' ? json.content : null;
        if (!content || !content.startsWith('window.__PVB_DATA')) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'content должен быть сериализованным window.__PVB_DATA' }));
          return;
        }
        await writeFile(DATA_FILE, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(content) }));
        console.log(`[dev-save] ${new Date().toLocaleTimeString()} — data/db.js записан (${Buffer.byteLength(content)} B)`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    });
    return;
  }

  // ---------- статика ----------
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404: ' + pathname);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PinVideoBoard dev-сервер: http://${HOST}:${PORT}/`);
  console.log(`Корень: ${ROOT}`);
  console.log('Сохранение без токена: POST /api/dev-save (DEV_MODE в js/config.js)');
});
