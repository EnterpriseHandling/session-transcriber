// Runs the Whisper speech model off the main thread so the page stays responsive.
// Everything here happens on the device. Model files come only from this app's own folder.

import * as tf from './vendor/transformers.min.js';
import { loadDiarizer, diarize, assign } from './diarize.js';

const { pipeline, env } = tf;

const SR = 16000;
const base = new URL('./', self.location.href);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('models/', base).pathname; // a path, not a full address: the library only treats paths as local
env.useBrowserCache = false; // the service worker keeps the offline copy
env.useWasmCache = false;

const wasm = env.backends.onnx.wasm;
wasm.wasmPaths = {
  mjs: new URL('vendor/ort-wasm-simd-threaded.asyncify.mjs', base).href,
  wasm: new URL('vendor/ort-wasm-simd-threaded.asyncify.wasm', base).href,
};
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
wasm.numThreads = threads;

let asr = null;
let loaded = null; // model description currently in memory
let queue = Promise.resolve();
let cancelled = false;
let voices = null; // speaker-labelling models, loaded the first time they are needed

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type === 'load') queue = queue.then(() => load(msg.model)).catch(report('load'));
  if (msg.type === 'run') queue = queue.then(() => run(msg.audio, msg.people || 1)).catch(report('run'));
};

function report(where) {
  return (err) => self.postMessage({ type: 'error', where, message: String(err?.message || err) });
}

async function load(model) {
  if (loaded?.id === model.id) { self.postMessage({ type: 'loaded', id: model.id, threads }); return; }
  if (asr) { try { await asr.dispose(); } catch (_) {} asr = null; loaded = null; }
  const files = new Map();
  asr = await pipeline('automatic-speech-recognition', model.id, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let done = 0;
      let total = 0;
      for (const [l, t] of files.values()) { done += l; total += t; }
      self.postMessage({ type: 'load-progress', id: model.id, loaded: done, total });
    },
  });
  loaded = model;
  self.postMessage({ type: 'loaded', id: model.id, threads });
}

// Split the recording into pieces of at most 28 seconds, cutting at the quietest
// moment so words are not chopped in half. Whisper listens to 30 seconds at a time.
function planBlocks(audio) {
  const hop = Math.round(SR * 0.02);
  const n = Math.floor(audio.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const o = i * hop;
    for (let j = 0; j < hop; j++) { const v = audio[o + j]; sum += v * v; }
    rms[i] = Math.sqrt(sum / hop);
  }
  const W = 15; // 0.3 s smoothing
  const smooth = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += rms[i];
    if (i >= W) acc -= rms[i - W];
    smooth[i] = acc / Math.min(i + 1, W);
  }
  const sorted = Float32Array.from(rms).sort();
  const p95 = n ? sorted[Math.floor(n * 0.95)] : 0;
  const quiet = Math.max(1e-4, 0.02 * p95);

  const MAXF = 28 * 50;
  const MINF = 15 * 50;
  const blocks = [];
  let f = 0;
  while (n - f > MAXF) {
    let best = f + MAXF;
    let bestV = Infinity;
    for (let i = f + MINF; i <= f + MAXF; i++) {
      if (smooth[i] < bestV) { bestV = smooth[i]; best = i; }
    }
    const cut = Math.max(f + 1, best - Math.floor(W / 2));
    blocks.push([f, cut]);
    f = cut;
  }
  blocks.push([f, n]);

  return blocks.map(([a, b], idx) => {
    let peak = 0;
    for (let i = a; i < b; i++) if (rms[i] > peak) peak = rms[i];
    const start = a * hop;
    const end = idx === blocks.length - 1 ? audio.length : b * hop;
    return { start, end, silent: peak < quiet || end - start < SR * 0.2 };
  });
}

const NOISE = /^[\s\[(*]*(blank[_ ]audio|silence|no audio)[\s\])*.]*$/i;

// Work out who is speaking when. Returns null if labels are not wanted or cannot be made;
// the transcript is still produced either way.
async function findVoices(audio, people) {
  if (people < 2) return null;
  try {
    if (!voices) {
      self.postMessage({ type: 'voices', stage: 'loading' });
      voices = await loadDiarizer(tf, { device: 'wasm' });
    }
    self.postMessage({ type: 'voices', stage: 'listening', progress: 0 });
    const who = await diarize(tf, voices, audio, people, (progress) => {
      if (cancelled) throw new Error('cancelled');
      self.postMessage({ type: 'voices', stage: 'listening', progress });
    });
    self.postMessage({ type: 'voices', stage: 'done', found: who.found });
    return who.found >= 2 ? who : null;
  } catch (err) {
    if (!cancelled) self.postMessage({ type: 'voices', stage: 'failed', message: String(err?.message || err) });
    return null;
  }
}

async function run(audio, people) {
  cancelled = false;
  if (!asr) throw new Error('The speech engine is not loaded yet.');
  const who = await findVoices(audio, people);
  const blocks = planBlocks(audio);
  self.postMessage({ type: 'plan', blocks: blocks.length, duration: audio.length / SR });

  const options = { return_timestamps: true };
  if (!loaded.english) { options.language = 'en'; options.task = 'transcribe'; }

  let previous = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (cancelled) break;
    const { start, end, silent } = blocks[i];
    const offset = start / SR;
    const blockEnd = end / SR;
    const segments = [];
    if (!silent) {
      const out = await asr(audio.subarray(start, end), options);
      const chunks = Array.isArray(out?.chunks) && out.chunks.length ? out.chunks : [{ timestamp: [0, null], text: out?.text || '' }];
      for (let c = 0; c < chunks.length; c++) {
        const text = (chunks[c].text || '').trim();
        if (!text || NOISE.test(text)) continue;
        const [a, b] = chunks[c].timestamp || [];
        const t = offset + (Number.isFinite(a) ? a : 0);
        const next = chunks[c + 1]?.timestamp?.[0];
        let stop = Number.isFinite(b) ? offset + b : Number.isFinite(next) ? offset + next : blockEnd;
        stop = Math.min(blockEnd, Math.max(stop, t + 0.2));
        const line = { start: t, end: stop, text };
        const pieces = who ? assign(who, line, previous) : [{ ...line, speaker: 0, check: false }];
        for (const p of pieces) {
          segments.push({ t: p.start, end: p.end, text: p.text, speaker: p.speaker, check: p.check });
          previous = p.speaker;
        }
      }
    }
    self.postMessage({ type: 'block', index: i, of: blocks.length, start: offset, end: blockEnd, segments });
  }
  self.postMessage({ type: 'done', cancelled });
}
