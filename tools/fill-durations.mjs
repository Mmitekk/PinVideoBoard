// PinVideoBoard — заполнение длительностей YouTube-плиток из страниц видео.
// Usage: node tools/fill-durations.mjs [--dry] [--commit] [--force]
// По умолчанию обрабатываются плитки youtube без duration (0/нет).
// Длительность достаётся из "lengthSeconds" в HTML страницы watch — без API-ключей.
// YouTube на некоторых сетях троттлится (~12 с на запрос), поэтому curl + пул воркеров.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CURL_TIMEOUT = 40; // секунд на запрос

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const commit = argv.includes('--commit');
const force = argv.includes('--force');
const wIdx = argv.indexOf('--workers');
const WORKERS_N = wIdx > -1 ? Math.max(1, Number(argv[wIdx + 1]) || 6) : 6;
const dIdx = argv.indexOf('--delay');
const DELAY_MS = dIdx > -1 ? Math.max(0, Number(argv[dIdx + 1]) || 300) : 300;

const dataFile = path.join(ROOT, 'data', 'db.js');
const src = fs.readFileSync(dataFile, 'utf8');
const db = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));

// очередь: youtube-плитки без длительности
const queue = [];
for (const b of db.boards || []) {
  for (const t of b.tiles || []) {
    if (t.provider === 'youtube' && t.vid && (force || !t.duration)) queue.push(t);
  }
}
console.log(`плиток youtube без длительности: ${queue.length}`);
if (!queue.length) { console.log('заполнять нечего'); process.exit(0); }

function fetchPage(vid) {
  return new Promise((resolve) => {
    const url = 'https://www.youtube.com/watch?v=' + vid;
    execFile('curl', ['-s', '--max-time', String(CURL_TIMEOUT), '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9', url],
      { timeout: (CURL_TIMEOUT + 5) * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout).match(/"lengthSeconds":"(\d+)"/);
        resolve(m ? Number(m[1]) : null);
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let done = 0, filled = 0, failed = 0;
  const failures = [];
  let idx = 0;

  async function worker(id) {
    while (true) {
      const i = idx++;
      if (i >= queue.length) return;
      const t = queue[i];
      let sec = await fetchPage(t.vid);
      if (!sec) { // один повтор (страница согласия/обрыв)
        await sleep(1500);
        sec = await fetchPage(t.vid);
      }
      if (sec) {
        t.duration = sec;
        filled++;
        done++;
        console.log(`  [w${id}] ${done}/${queue.length} ${fmt(sec)} — ${(t.title || '').slice(0, 46)}`);
      } else {
        failed++;
        done++;
        failures.push(t.vid);
        console.log(`  [w${id}] ${done}/${queue.length} НЕ УДАЛОСЬ ${t.vid}`);
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: WORKERS_N }, (_, i) => worker(i + 1)));
  console.log(`итого: заполнено ${filled}, не удалось ${failed}`);
  if (failures.length) console.log('  vid с ошибками: ' + failures.join(', '));
  if (dry) { console.log('--dry: data/db.js не изменён'); process.exit(0); }
  if (!filled) { console.log('изменений нет'); process.exit(0); }

  // перед записью перечитываем файл и вливаем длительности по id:
  // за долгий прогон пользователь мог сохранить правки с сайта/локально
  const durations = new Map(queue.filter((t) => t.duration).map((t) => [t.id, t.duration]));
  const fresh = JSON.parse(fs.readFileSync(dataFile, 'utf8').slice(fs.readFileSync(dataFile, 'utf8').indexOf('=') + 1).trim().replace(/;\s*$/, ''));
  let applied = 0;
  for (const b of fresh.boards || []) {
    for (const t of b.tiles || []) {
      if (durations.has(t.id) && !t.duration) { t.duration = durations.get(t.id); applied++; }
    }
  }
  fresh.updatedAt = new Date().toISOString();
  fs.writeFileSync(dataFile, 'window.__PVB_DATA = ' + JSON.stringify(fresh, null, 2) + ';\n');
  console.log(`data/db.js записан (применено ${applied} из ${durations.size})`);

  if (commit) {
    try {
      const { execSync } = await import('node:child_process');
      execSync('git add data', { cwd: ROOT });
      execSync(`git commit -m "PinVideoBoard: заполнены длительности YouTube (${filled} плиток)"`, { cwd: ROOT });
      console.log('закоммичено локально (push — за вами)');
    } catch (e) { console.log('коммит не сделан: ' + (e.message || e)); }
  }
}

function fmt(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => (n < 10 ? '0' : '') + n;
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

main();
