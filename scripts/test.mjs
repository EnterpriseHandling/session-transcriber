// End-to-end check in a real (headless) Chrome, run before every release.
// Uses only a public-domain speech sample (JFK, 1961). Never real recordings.
//
// It proves four things:
//   1. a WAV and a longer MP3 are transcribed correctly
//   2. the app made no request to any other website while doing it
//   3. attempts to send data elsewhere are blocked by the browser
//   4. it still works with the network switched off
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const PREFIX = '/session-transcriber/'; // mimic GitHub Pages serving from a sub-folder
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.onnx': 'application/octet-stream', '.txt': 'text/plain',
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(PREFIX)) { res.writeHead(404).end(); return; }
  let rel = normalize(path.slice(PREFIX.length));
  if (rel === '.' || rel === '') rel = 'index.html';
  if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(dist, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' }).end(body);
  } catch (_) { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = origin + PREFIX;

const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'].find(existsSync);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: [
  '--no-sandbox',
  '--use-fake-ui-for-media-stream', // auto-allow the microphone
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${join(root, 'tests/jfk.wav')}`, // the 'microphone' plays the JFK clip on a loop
] });
const page = await browser.newPage();
const foreign = [];
const failed = [];
const logs = [];
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u); });
page.on('requestfailed', (r) => failed.push(`${r.url()} (${r.failure()?.errorText})`));
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('dialog', (d) => d.accept());

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
// Strip times and punctuation, join lines: models differ on small words ("ask"/"asked") and line breaks.
const plain = (s) => s.replace(/^\[[\d:]+\] /gm, ' ').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ');
const KEY = 'what your country can do for you';
// Live microphone audio is lower quality, so the small test model can mishear a word or two.
const heard = (s) => /can do for (you|your country)/.test(plain(s));

async function ready() {
  await page.waitForFunction(() => !document.getElementById('step-file').hidden, { timeout: 180000 });
}
async function pickModel() {
  if (!process.env.TEST_MODEL) return;
  await page.click(`input[name="model"][value="${process.env.TEST_MODEL}"]`);
}
async function transcribeLoaded() {
  const t0 = Date.now();
  await page.click('#start');
  await page.waitForFunction(() => {
    const s = document.getElementById('status').textContent;
    return s.startsWith('Finished') || !document.getElementById('error').hidden;
  }, { timeout: 900000 });
  const error = await page.$eval('#error', (e) => (e.hidden ? '' : e.textContent));
  if (error) throw new Error(`App showed an error: ${error}`);
  return { text: await page.$eval('#out', (t) => t.value), seconds: (Date.now() - t0) / 1000 };
}
async function transcribe(file) {
  const input = await page.$('#file');
  await input.uploadFile(join(root, 'tests', file));
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  const t0 = Date.now();
  await page.click('#start');
  await page.waitForFunction(() => {
    const s = document.getElementById('status').textContent;
    const e = document.getElementById('error');
    return s.startsWith('Finished') || !e.hidden;
  }, { timeout: 900000 });
  const error = await page.$eval('#error', (e) => (e.hidden ? '' : e.textContent));
  if (error) throw new Error(`App showed an error: ${error}`);
  return { text: await page.$eval('#out', (t) => t.value), seconds: (Date.now() - t0) / 1000 };
}

let exit = 1;
try {
  await page.goto(url, { waitUntil: 'load' });
  await ready();
  await pickModel();
  const info = await page.evaluate(() => ({ isolated: self.crossOriginIsolated, controlled: !!navigator.serviceWorker.controller, cores: navigator.hardwareConcurrency }));
  check('service worker in control', info.controlled);
  check('multi-core mode available (cross-origin isolated)', info.isolated, `${info.cores} cores`);

  const short = await transcribe('jfk.wav');
  console.log('--- jfk.wav ---\n' + short.text);
  check('WAV transcribed correctly', plain(short.text).includes(KEY), `${short.seconds.toFixed(1)} s for 11 s of audio`);
  check('lines start with a time', /^\[\d\d:\d\d\] /.test(short.text));

  const long = await transcribe('long.mp3');
  console.log('--- long.mp3 ---\n' + long.text);
  const hits = plain(long.text).split(KEY).length - 1;
  const stamps = [...long.text.matchAll(/^\[(\d\d):(\d\d)\]/gm)].map((m) => +m[1] * 60 + +m[2]);
  check('88-second stereo MP3 transcribed across several sections', hits >= 7, `${hits}/8 repeats found, ${long.seconds.toFixed(1)} s for 88 s of audio`);
  check('times increase and reach the end of the recording', stamps.every((v, i) => i === 0 || v >= stamps[i - 1]) && Math.max(...stamps) >= 70, `last line at ${Math.max(...stamps)} s`);

  const blocked = await page.evaluate(async () => {
    const out = {};
    try { await fetch('https://example.com/?leak=1', { mode: 'no-cors' }); out.fetch = 'SENT'; } catch (_) { out.fetch = 'blocked'; }
    out.beacon = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('SENT'); i.onerror = () => resolve('blocked'); i.src = 'https://example.com/pixel.png?leak=1'; });
    try {
      const w = new Worker(URL.createObjectURL(new Blob(["fetch('https://example.com/?leak=2',{mode:'no-cors'}).then(()=>postMessage('SENT'),()=>postMessage('blocked'))"], { type: 'text/javascript' })));
      out.worker = await new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); w.onerror = () => resolve('blocked'); });
    } catch (_) { out.worker = 'blocked'; }
    out.storage = { local: localStorage.length, idb: (await indexedDB.databases?.())?.length ?? 0 };
    return out;
  });
  check('sending data to another website is blocked (fetch, image, worker)', blocked.fetch === 'blocked' && blocked.beacon === 'blocked' && blocked.worker === 'blocked', JSON.stringify(blocked));
  check('nothing written to browser storage', blocked.storage.local === 0 && blocked.storage.idb === 0);
  const leaked = foreign.filter((u) => !u.startsWith('https://example.com/'));
  check('app itself contacted no other website', leaked.length === 0, leaked.join(', '));


  // ---- built-in recorder (fake microphone plays the JFK clip on a loop) ----
  const keptCount = () => page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    if (!dbs.includes('st-recorder')) return { sessions: 0, chunks: 0 };
    const db = await new Promise((r) => { const q = indexedDB.open('st-recorder'); q.onsuccess = () => r(q.result); });
    const count = (s) => new Promise((r) => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); });
    const out = { sessions: await count('sessions'), chunks: await count('chunks') };
    const first = await new Promise((r) => { const q = db.transaction('chunks').objectStore('chunks').openCursor(); q.onsuccess = () => r(q.result?.value); });
    if (first) {
      const head = new Uint8Array(first.data.slice(0, 4));
      out.plainAudioHeader = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3; // WebM signature
    }
    db.close();
    return out;
  });
  async function recordFor(seconds) {
    await page.click('#rec-open');
    await page.waitForFunction(() => !document.getElementById('rec-start').disabled, { timeout: 15000 });
    await page.click('#rec-start');
    await page.waitForFunction(() => !document.getElementById('rec-stop').hidden, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  await page.$eval('#clear', (b) => b.click());

  // 1. Crash part-way: leave the page while recording, come back, recover it.
  await recordFor(14);
  const midway = await keptCount();
  check('recording is saved to the device while it records', midway.sessions === 1 && midway.chunks >= 2, JSON.stringify(midway));
  check('saved recording pieces are encrypted', midway.plainAudioHeader === false);
  const awake = await page.evaluate(async () => { const l = await navigator.wakeLock.request('screen'); const ok = !l.released; await l.release(); return ok; }).catch(() => 'unsupported');
  check('screen wake lock available', awake === true || awake === 'unsupported', String(awake));
  await page.goto(url, { waitUntil: 'load' });
  await ready();
  await pickModel();
  const kept = await page.$$eval('#kept-list li', (lis) => lis.length);
  check('after a crash the recording is offered back', kept === 1);
  await page.click('#kept-list li button'); // Open
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  const recovered = await transcribeLoaded();
  check('recovered recording transcribes', heard(recovered.text), recovered.text.split('\n')[0]);
  await page.click('#rec-delete');
  await page.waitForFunction(() => document.getElementById('kept').hidden);

  // 2. Normal recording with a pause, then stop and transcribe.
  await recordFor(12);
  await page.click('#rec-pause');
  await new Promise((r) => setTimeout(r, 3000));
  await page.click('#rec-pause');
  await new Promise((r) => setTimeout(r, 12000));
  await page.click('#rec-stop');
  await page.waitForFunction(() => !document.getElementById('rec-actions').hidden, { timeout: 30000 });
  const recInfo = await page.$eval('#file-info', (e) => e.textContent);
  const secs = (recInfo.match(/\((\d\d):(\d\d)\)/) || []).slice(1).map(Number);
  const length = secs.length ? secs[0] * 60 + secs[1] : -1;
  check('timer excludes the pause', length >= 22 && length <= 27, recInfo);
  const recorded = await transcribeLoaded();
  check('recording made in the app transcribes', heard(recorded.text), `${recorded.seconds.toFixed(1)} s`);
  await page.click('#rec-delete');
  await page.waitForFunction(() => document.getElementById('kept').hidden);
  const after = await keptCount();
  check('deleting leaves nothing stored', after.sessions === 0 && after.chunks === 0, JSON.stringify(after));

  await page.setOfflineMode(true);
  await page.goto(url, { waitUntil: 'load' }); // fresh visit with no network
  await ready();
  await pickModel();
  const offline = await transcribe('jfk.wav');
  check('works with the network switched off', plain(offline.text).includes(KEY), `${offline.seconds.toFixed(1)} s`);

  exit = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.log('FAIL  test run stopped:', err.message);
  console.log(logs.slice(-25).join('\n'));
  console.log('failed requests:', failed.slice(-10).join('\n'));
} finally {
  await browser.close();
  server.close();
}
console.log(exit === 0 ? '\nAll checks passed.' : '\nSome checks FAILED.');
process.exit(exit);
