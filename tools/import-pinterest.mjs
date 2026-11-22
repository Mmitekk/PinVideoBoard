// PinVideoBoard — импорт видео-пинов из Pinterest-доски в data/db.js.
// Usage: node tools/import-pinterest.mjs [--board <slug>] [--column <colId>] [--commit] [--dry]
// По умолчанию: доска mmitekk «смотреть-позже» -> доска «Смотреть позже», первая колонка.
// Механика соскрейпена с tools/sync.mjs из PinRefBoard (анонимно, с ретраями на 429).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PIN_USER = 'mmitekk';
const DEFAULT_BOARD = 'смотреть-позже';
const PAGE_SIZE = 25;
const DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- js/videos.js (браузерный файл, эмулируем window) ----------
globalThis.window = {};
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'videos.js'), 'utf8'));
const V = globalThis.window.__PVB_VIDEOS;

// ---------- cookie jar (как в PinRefBoard sync.mjs) ----------
function makeJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(k) { return jar.get(k) || ''; },
  };
}

function extractScript(html, id) {
  const marker = `<script id="${id}" type="application/json">`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const end = html.indexOf('</script>', from);
  if (end === -1) return null;
  try { return JSON.parse(html.slice(from, end)); } catch { return null; }
}

// ---------- скрейпинг ----------
async function scrapeBoard(slug) {
  const boardUrl = `/${PIN_USER}/${slug}/`;
  const jar = makeJar();
  const pageRes = await fetch('https://ru.pinterest.com' + boardUrl, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
  });
  jar.absorb(pageRes);
  const html = await pageRes.text();
  const pws = extractScript(html, '__PWS_DATA__') || {};
  const appVersion = pws.appVersion || '';
  const csrf = jar.get('csrftoken');

  // id доски ищем в __PWS_DATA__ (t :: "board") иначе — только по board_url
  let boardId = '';
  const props = pws?.props?.initialReduxState?.ui?.boards || {};
  for (const key of Object.keys(props)) {
    if (props[key]?.id && (props[key]?.url || '').includes(slug)) { boardId = String(props[key].id); break; }
  }
  if (!boardId) {
    const m = html.match(/board_id[^0-9]{0,6}(\d{6,})/) || html.match(/board_id=(\d{6,})/) || html.match(/board\/(\d{6,})/);
    boardId = m ? m[1] : '';
  }

  const pins = [];
  let bookmarks = [];
  let pages = 0;
  while (true) {
    const dataObj = { options: { board_id: boardId, board_url: boardUrl, page_size: PAGE_SIZE, bookmarks }, context: {} };
    const url = 'https://www.pinterest.com/resource/BoardFeedResource/get/?source_url=' + encodeURIComponent(boardUrl) +
      '&data=' + encodeURIComponent(JSON.stringify(dataObj));
    let json = null;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            accept: 'application/json, text/javascript, */*, q=0.01',
            cookie: jar.header(),
            'user-agent': UA,
            'x-app-version': appVersion,
            'x-csrf-token': csrf,
            'x-pinterest-appstate': 'active',
            'x-pinterest-pws-handler': 'www/board/[username]/[slug].js',
            'x-pinterest-source-url': encodeURI(boardUrl),
            'x-requested-with': 'XMLHttpRequest',
            referer: 'https://ru.pinterest.com' + encodeURI(boardUrl),
          },
        });
        jar.absorb(res);
        if (res.status === 429 || res.status === 403 || res.status === 401) {
          console.log(`  http ${res.status}, retry ${3 * (attempt + 1)}s`);
          await sleep(3000 * (attempt + 1));
          continue;
        }
        json = await res.json();
        ok = true;
      } catch (e) {
        console.log(`  fetch error: ${e.message}, retry`);
        await sleep(2000);
      }
    }
    if (!ok) throw new Error('BoardFeedResource недоступен после ретраев');

    const arr = json?.resource_response?.data || [];
    for (const raw of arr) {
      if (raw && raw.type === 'pin' && raw.id) {
        pins.push({
          id: String(raw.id),
          title: raw.grid_title || raw.title || '',
          description: raw.description || '',
          link: raw.link || null,
          domain: raw.domain || null,
          created: raw.created_at || null,
          isVideo: !!raw.videos || !!(raw.video_list && Object.keys(raw.video_list || {}).length),
          img: raw.images?.['474x']?.url || raw.images?.orig?.url || raw.images?.['236x']?.url || null,
        });
      }
    }
    pages++;
    const next = json?.resource?.options?.bookmarks || [];
    const end = !next.length || next[0] === '-end-';
    console.log(`  страница ${pages}: пинов ${pins.length}`);
    if (end || arr.length === 0) break;
    bookmarks = next;
    await sleep(DELAY_MS);
  }
  return { pins, boardId };
}

// ---------- метаданные видео (node: CORS не мешает) ----------
async function fetchJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function resolveTitle(url, provider, vid) {
  // 1) noembed
  try {
    const r = await fetchJSON('https://noembed.com/embed?url=' + encodeURIComponent(url));
    if (r && r.title) return { title: r.title, thumb: r.thumbnail_url || null, duration: 0 };
  } catch { /* следующий источник */ }
  // 2) vimeo oembed
  if (provider === 'vimeo' && vid) {
    try {
      const r = await fetchJSON('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent('https://vimeo.com/' + vid));
      if (r && r.title) return { title: r.title, thumb: r.thumbnail_url || null, duration: r.duration || 0 };
    } catch { /* дальше */ }
  }
  return null;
}

// ---------- main ----------
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const commit = argv.includes('--commit');
const boardSlugIdx = argv.indexOf('--board');
const colIdx = argv.indexOf('--column');
const BOARD_SLUG = boardSlugIdx > -1 ? argv[boardSlugIdx + 1] : DEFAULT_BOARD;
const TARGET_COLUMN_ID = colIdx > -1 ? argv[colIdx + 1] : null;
const TARGET_BOARD_NAME = 'Смотреть позже';

const dataFile = path.join(ROOT, 'data', 'db.js');
const src = fs.readFileSync(dataFile, 'utf8');
const db = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));

console.log(`скрейп pinterest.com/${PIN_USER}/${BOARD_SLUG} ...`);
const { pins, boardId } = await scrapeBoard(BOARD_SLUG);
console.log(`всего пинов: ${pins.length} (board_id=${boardId || '?'})`);

// видео-пины: есть исходящая ссылка, которую парсер распознал как видео
const videoPins = [];
const skipped = [];
for (const p of pins) {
  const info = p.link ? V.parse(p.link) : null;
  const isVideoLink = info && info.provider !== 'other';
  if (isVideoLink) videoPins.push({ ...p, info });
  else skipped.push(p);
}
console.log(`видео-ссылки: ${videoPins.length}, пропущено (не видео / без ссылки): ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.id} ${s.domain || 'без ссылки'} «${(s.title || '').slice(0, 40)}»`);

// цель: доска по имени (или единственная), колонка по id или первая
const targetBoard = db.boards.find((b) => b.name === TARGET_BOARD_NAME) || db.boards[0];
if (!targetBoard) throw new Error('в data/db.js нет досок');
const col = TARGET_COLUMN_ID
  ? (targetBoard.columns || []).find((c) => c.id === TARGET_COLUMN_ID)
  : (targetBoard.columns || [])[0];
if (!col) throw new Error('колонка не найдена: ' + (TARGET_COLUMN_ID || 'первая'));
console.log(`цель: доска «${targetBoard.name}», колонка «${col.name}» (${col.id})`);

const existingUrls = new Set((targetBoard.tiles || []).map((t) => t.url));
const existingIds = new Set((targetBoard.tiles || []).map((t) => t.id));

const tiles = [];
for (const p of videoPins) {
  if (existingIds.has('t-pin' + p.id)) { console.log(`  уже есть: pin ${p.id}`); continue; }
  const canonical = V.canonicalUrl(p.info);
  if (existingUrls.has(canonical) || existingUrls.has(p.link)) { console.log(`  дубликат URL: pin ${p.id}`); continue; }

  let title = '';
  let thumb = null;
  let duration = 0;
  const meta = await resolveTitle(canonical, p.info.provider, p.info.vid);
  if (meta) { title = meta.title; thumb = meta.thumb; duration = meta.duration; }
  if (p.info.provider === 'youtube' && p.info.vid && !thumb) {
    thumb = 'https://i.ytimg.com/vi/' + p.info.vid + '/maxresdefault.jpg';
  }
  if (!thumb && p.img) thumb = p.img;
  if (!title) title = (p.title || p.description || '').trim() || 'Без названия';

  const tile = {
    id: 't-pin' + p.id, // стабильный id из пина — повторный импорт не дублирует
    columnId: col.id,
    url: canonical,
    provider: p.info.provider,
    vid: p.info.vid || null,
    vk: p.info.vk || null,
    title,
    thumb,
    duration: duration || 0,
    tags: ['pinterest'],
    note: (p.description || '').trim(),
    addedAt: p.created || new Date().toISOString(),
  };
  tiles.push(tile);
  console.log(`  + ${p.info.provider} «${title.slice(0, 60)}»`);
}

if (!tiles.length) {
  console.log('новых плиток нет — data/db.js не менялся');
  process.exit(0);
}
if (dry) {
  console.log(`--dry: не записано ${tiles.length} плиток`);
  process.exit(0);
}

targetBoard.tiles = (targetBoard.tiles || []).concat(tiles);
db.updatedAt = new Date().toISOString();
const text = 'window.__PVB_DATA = ' + JSON.stringify(db, null, 2) + ';\n';
fs.writeFileSync(dataFile, text);
console.log(`записано: ${tiles.length} плиток -> data/db.js`);

if (commit) {
  try {
    execSync('git add data', { cwd: ROOT });
    execSync(`git commit -m "PinVideoBoard: доска «${targetBoard.name}»: импорт ${tiles.length} видео из pinterest.com/${PIN_USER}/${BOARD_SLUG}"`, { cwd: ROOT });
    console.log('закоммичено локально (push — за вами)');
  } catch (e) { console.log('коммит не сделан: ' + (e.message || e)); }
}
