// PinVideoBoard — тест парсера ссылок (js/videos.js).
// Запуск: node tools/test-parse.mjs
// Файл браузерный (IIFE на window), поэтому эмулируем window и подключаем исходник.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = {};
const src = readFileSync(path.join(__dirname, '..', 'js', 'videos.js'), 'utf8');
// файл рассчитан на браузер: выполняем его в текущем контексте
(0, eval)(src);
const V = globalThis.window.__PVB_VIDEOS;

let failed = 0;
function check(name, url, expected) {
  const got = V.parse(url);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`FAIL ${name}\n  url:  ${url}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// YouTube
check('yt watch', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
check('yt watch + params', 'https://www.youtube.com/watch?t=120&v=aqz-KE-bpKQ&list=PL1',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/watch?t=120&v=aqz-KE-bpKQ&list=PL1' });
check('yt youtu.be', 'https://youtu.be/aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://youtu.be/aqz-KE-bpKQ' });
check('yt shorts', 'https://www.youtube.com/shorts/aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/shorts/aqz-KE-bpKQ' });
check('yt embed', 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ' });
check('yt live', 'https://www.youtube.com/live/aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/live/aqz-KE-bpKQ' });
check('yt без схемы', 'www.youtube.com/watch?v=aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
check('yt m.', 'https://m.youtube.com/watch?v=aqz-KE-bpKQ',
  { provider: 'youtube', vid: 'aqz-KE-bpKQ', url: 'https://m.youtube.com/watch?v=aqz-KE-bpKQ' });

// Vimeo
check('vimeo', 'https://vimeo.com/76979871',
  { provider: 'vimeo', vid: '76979871', url: 'https://vimeo.com/76979871' });
check('vimeo channels', 'https://vimeo.com/channels/staffpicks/76979871',
  { provider: 'vimeo', vid: '76979871', url: 'https://vimeo.com/channels/staffpicks/76979871' });

// Rutube (hash = 32 hex)
const RUT = '0e8dacc1f4b0af7b3b3d3e6a6b1b1b1b';
check('rutube', `https://rutube.ru/video/${RUT}/`,
  { provider: 'rutube', vid: RUT, url: `https://rutube.ru/video/${RUT}/` });
check('rutube embed', `https://rutube.ru/play/embed/${RUT}`,
  { provider: 'rutube', vid: RUT, url: `https://rutube.ru/play/embed/${RUT}` });

// VK
check('vk group video', 'https://vk.com/video-12345_456239022',
  { provider: 'vk', vk: { oid: '-12345', id: '456239022' }, url: 'https://vk.com/video-12345_456239022' });
check('vkvideo', 'https://vkvideo.ru/video12345_456239022',
  { provider: 'vk', vk: { oid: '12345', id: '456239022' }, url: 'https://vkvideo.ru/video12345_456239022' });

// прямой файл
check('direct mp4', 'https://example.org/movie.mp4',
  { provider: 'direct', vid: null, url: 'https://example.org/movie.mp4' });
check('direct webm + query', 'https://example.org/clip.webm?dl=1',
  { provider: 'direct', vid: null, url: 'https://example.org/clip.webm?dl=1' });

// прочее
check('other', 'https://example.org/some/page', { provider: 'other', vid: null, url: 'https://example.org/some/page' });
check('dzen -> other', 'https://dzen.ru/video/watch/abc123', { provider: 'other', vid: null, url: 'https://dzen.ru/video/watch/abc123' });

// embedUrl
const emb = V.embedUrl({ provider: 'youtube', vid: 'aqz-KE-bpKQ' });
if (emb !== 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1&rel=0&modestbranding=1') { failed++; console.log('FAIL embedUrl youtube:', emb); }
else console.log('ok   embedUrl youtube');

// fmtDuration
if (V.fmtDuration(0) !== '') { failed++; console.log('FAIL fmtDuration 0'); }
else if (V.fmtDuration(65) !== '1:05') { failed++; console.log('FAIL fmtDuration 65'); }
else if (V.fmtDuration(4821) !== '1:20:21') { failed++; console.log('FAIL fmtDuration 4821'); }
else console.log('ok   fmtDuration');

// parseDuration
if (V.parseDuration('12:34') !== 754) { failed++; console.log('FAIL parseDuration 12:34'); }
else if (V.parseDuration('1:20:21') !== 4821) { failed++; console.log('FAIL parseDuration 1:20:21'); }
else if (V.parseDuration('4821') !== 4821) { failed++; console.log('FAIL parseDuration 4821'); }
else if (V.parseDuration('PT1H20M21S') !== 4821) { failed++; console.log('FAIL parseDuration PT1H20M21S'); }
else if (V.parseDuration('') !== 0) { failed++; console.log('FAIL parseDuration empty'); }
else console.log('ok   parseDuration');

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nвсе проверки пройдены');
