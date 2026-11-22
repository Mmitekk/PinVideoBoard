// PinVideoBoard — импорт СЕКЦИЙ Pinterest-доски в отдельные доски data/db.js.
// Usage: node tools/import-pinterest-sections.mjs [--dry] [--commit]
// Секции «буду-смотреть» превращаются в доски сайта с дефолтными колонками;
// дедуп глобальный по URL (и по стабильному id t-pin<pinId>).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// undici без этого падает в ConnectTimeout на pinterest (IPv6-маршрут)
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PIN_USER = 'mmitekk';
const PAGE_SIZE = 25;
const DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// { boardSlug, sectionSlug, boardName } — имя доски на сайте (как просил пользователь)
const SECTIONS = [
  { boardSlug: 'буду-смотреть', sectionSlug: 'questions-time', boardName: 'Questions Time' },
  { boardSlug: 'буду-смотреть', sectionSlug: 'niagara', boardName: 'Niagara' },
  { boardSlug: 'буду-смотреть', sectionSlug: 'gamedev-video', boardName: 'GameDev Video' },
  { boardSlug: 'буду-смотреть', sectionSlug: 'xyz', boardName: 'XYZ' },
  { boardSlug: 'буду-смотреть', sectionSlug: 'unreal-engine', boardName: 'Unreal Engine' },
];
const DEFAULT_COLUMNS = [
  { name: 'Смотреть позже', color: '#4a9eff' },
  { name: 'Смотрю', color: '#d29922' },
  { name: 'Просмотрено', color: '#3fb950' },
];

// ---------- js/videos.js ----------
globalThis.window = {};
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'videos.js'), 'utf8'));
const V = globalThis.window.__PVB_VIDEOS;

// ---------- pinterest ----------
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

async function apiGet(jar, appVersion, resource, dataObj, sourceUrl, handler) {
  const url = 'https://www.pinterest.com/resource/' + resource + '/get/?source_url=' + encodeURIComponent(encodeURI(sourceUrl)) +
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
          'x-csrf-token': jar.get('csrftoken'),
          'x-pinterest-appstate': 'active',
          'x-pinterest-pws-handler': handler,
          'x-pinterest-source-url': encodeURI(sourceUrl),
          'x-requested-with': 'XMLHttpRequest',
          referer: 'https://ru.pinterest.com' + encodeURI(sourceUrl),
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
      await sleep(2500);
    }
  }
  if (!ok) throw new Error(resource + ' недоступен после ретраев');
  return json;
}

async function scrapeSectionPins(jar, appVersion, boardId, sectionId, boardUrl, sectionSlug) {
  const sectionUrl = boardUrl + sectionSlug + '/';
  const pins = new Map();
  let bookmarks = [];
  let pages = 0;
  while (true) {
    const dataObj = { options: { board_id: boardId, section_id: sectionId, page_size: PAGE_SIZE, bookmarks }, context: {} };
    const json = await apiGet(jar, appVersion, 'BoardSectionPinsResource', dataObj, sectionUrl, 'www/board/[username]/[slug]/[section_slug].js');
    const arr = json?.resource_response?.data || [];
    for (const raw of arr) {
      if (raw && raw.type === 'pin' && raw.id && !pins.has(String(raw.id))) {
        pins.set(String(raw.id), {
          id: String(raw.id),
          title: raw.grid_title || raw.title || '',
          description: raw.description || '',
          link: raw.link || null,
          domain: raw.domain || null,
          created: raw.created_at || null,
          img: raw.images?.['474x']?.url || raw.images?.orig?.url || raw.images?.['236x']?.url || null,
        });
      }
    }
    pages++;
    const next = json?.resource?.options?.bookmarks || [];
    const end = !next.length || next[0] === '-end-';
    if (end || arr.length === 0) break;
    bookmarks = next;
    await sleep(DELAY_MS);
  }
  console.log(`  секция «${sectionSlug}»: ${pages} стр., ${pins.size} пинов`);
  return [...pins.values()];
}

// ---------- метаданные ----------
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
  try {
    const r = await fetchJSON('https://noembed.com/embed?url=' + encodeURIComponent(url));
    if (r && r.title) return { title: r.title, thumb: r.thumbnail_url || null, duration: 0 };
  } catch { /* следующий источник */ }
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

const dataFile = path.join(ROOT, 'data', 'db.js');
const src = fs.readFileSync(dataFile, 'utf8');
const db = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));

// глобальный дедуп: URL по всем доскам
const globalUrls = new Set();
for (const b of db.boards || []) for (const t of b.tiles || []) globalUrls.add(t.url);

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let createdBoards = 0;
let totalAdded = 0;
const totalSkipped = [];

// 1) контекст родительской доски (appVersion, csrf, board_id)
const parentSlug = SECTIONS[0].boardSlug;
const boardUrl = `/${PIN_USER}/${parentSlug}/`;
console.log(`контекст доски pinterest.com/${PIN_USER}/${parentSlug} ...`);
const jar = makeJar();
let pageRes = null;
for (let attempt = 0; attempt < 5 && !pageRes; attempt++) {
  try {
    pageRes = await fetch('https://ru.pinterest.com' + encodeURI(boardUrl), { headers: { 'user-agent': UA, accept: 'text/html' } });
  } catch (e) {
    console.log(`  страница: ${e.cause?.code || e.message}, retry ${3 * (attempt + 1)}s`);
    await sleep(3000 * (attempt + 1));
  }
}
if (!pageRes) throw new Error('страница доски недоступна после ретраев');
jar.absorb(pageRes);
const html = await pageRes.text();
const pws = extractScript(html, '__PWS_DATA__') || {};
const appVersion = pws.appVersion || '';

const d1 = { options: { slug: parentSlug, username: PIN_USER }, context: {} };
const j1 = await apiGet(jar, appVersion, 'BoardResource', d1, boardUrl, 'www/board/[username]/[slug].js');
const board = j1?.resource_response?.data;
if (!board || !board.id) throw new Error('BoardResource не вернул id доски «' + parentSlug + '»');
console.log(`доска: id=${board.id}, «${board.name}», пинов на доске: ${board.pin_count}`);

const d2 = { options: { board_id: board.id, board_url: boardUrl, page_size: 25, bookmarks: [] }, context: {} };
const j2 = await apiGet(jar, appVersion, 'BoardSectionsResource', d2, boardUrl, 'www/board/[username]/[slug].js');
const sections = j2?.resource_response?.data || [];
const sectionById = new Map(sections.map((s) => [s.slug, String(s.id)]));
console.log('секции:', sections.map((s) => s.slug).join(', ') || '-');

// 2) скрейп + импорт по секциям
for (const item of SECTIONS) {
  const sectionId = sectionById.get(item.sectionSlug);
  if (!sectionId) {
    console.log(`! секция «${item.sectionSlug}» не найдена — пропуск`);
    totalSkipped.push({ section: item.sectionSlug, reason: 'секция не найдена' });
    continue;
  }
  const pins = await scrapeSectionPins(jar, appVersion, board.id, sectionId, boardUrl, item.sectionSlug);

  // своя доска на сайте
  let target = (db.boards || []).find((b) => b.name === item.boardName);
  if (!target) {
    target = {
      id: uid('b'),
      name: item.boardName,
      createdAt: new Date().toISOString(),
      columns: DEFAULT_COLUMNS.map((c) => ({ id: uid('c'), name: c.name, color: c.color })),
      tiles: [],
    };
    db.boards = (db.boards || []).concat([target]);
    createdBoards++;
    console.log(`  + новая доска «${item.boardName}»`);
  }
  const col = (target.columns || [])[0];
  if (!col) { console.log(`! у доски «${item.boardName}» нет колонок — пропуск`); continue; }

  const existingIds = new Set((target.tiles || []).map((t) => t.id));
  let added = 0;
  for (const p of pins) {
    const tileId = 't-pin' + p.id;
    const info = p.link ? V.parse(p.link) : null;
    if (!info || info.provider === 'other') {
      totalSkipped.push({ section: item.sectionSlug, pin: p.id, reason: p.link ? 'ссылка не видео' : 'без ссылки' });
      continue;
    }
    if (existingIds.has(tileId)) continue;
    const canonical = V.canonicalUrl(info);
    if (globalUrls.has(canonical) || globalUrls.has(p.link)) {
      totalSkipped.push({ section: item.sectionSlug, pin: p.id, reason: 'дубль URL уже на сайте' });
      continue;
    }

    let title = '', thumb = null, duration = 0;
    const meta = await resolveTitle(canonical, info.provider, info.vid);
    if (meta) { title = meta.title; thumb = meta.thumb; duration = meta.duration; }
    if (info.provider === 'youtube' && info.vid && !thumb) thumb = 'https://i.ytimg.com/vi/' + info.vid + '/maxresdefault.jpg';
    if (!thumb && p.img) thumb = p.img;
    if (!title) title = (p.title || p.description || '').trim() || 'Без названия';

    target.tiles = (target.tiles || []).concat([{
      id: tileId,
      columnId: col.id,
      url: canonical,
      provider: info.provider,
      vid: info.vid || null,
      vk: info.vk || null,
      title,
      thumb,
      duration: duration || 0,
      tags: ['pinterest'],
      note: (p.description || '').trim(),
      addedAt: p.created || new Date().toISOString(),
    }]);
    globalUrls.add(canonical);
    existingIds.add(tileId);
    added++;
    totalAdded++;
    console.log(`  + «${item.boardName}»: ${info.provider} «${title.slice(0, 55)}»`);
  }
  console.log(`  доска «${item.boardName}»: +${added} плиток`);
  await sleep(DELAY_MS);
}

console.log(`итого: +${totalAdded} плиток, новых досок ${createdBoards}, пропусков ${totalSkipped.length}`);
if (dry) { console.log('--dry: data/db.js не изменён'); process.exit(0); }
if (!totalAdded && !createdBoards) { console.log('изменений нет'); process.exit(0); }

db.updatedAt = new Date().toISOString();
fs.writeFileSync(dataFile, 'window.__PVB_DATA = ' + JSON.stringify(db, null, 2) + ';\n');
console.log('data/db.js записан');

if (commit) {
  try {
    execSync('git add data', { cwd: ROOT });
    execSync(`git commit -m "PinVideoBoard: импорт секций буду-смотреть -> доски ${SECTIONS.map((s) => s.boardName).join(', ')}"`, { cwd: ROOT });
    console.log('закоммичено локально (push — за вами)');
  } catch (e) { console.log('коммит не сделан: ' + (e.message || e)); }
}
