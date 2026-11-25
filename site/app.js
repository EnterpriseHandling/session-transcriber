// Session Transcriber: page logic.
// Privacy rule for this file: nothing about the recording or transcript is ever
// written to storage or sent over the network. It lives in memory until the tab closes.

const SR = 16000;
const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'), stepFile: $('step-file'), stepRun: $('step-run'), stepOut: $('step-out'),
  file: $('file'), fileInfo: $('file-info'), player: $('player'),
  models: $('models'), times: $('times'), start: $('start'), cancel: $('cancel'),
  wrap: $('progress-wrap'), bar: $('bar'), status: $('status'), error: $('error'),
  out: $('out'), save: $('save'), copy: $('copy'), clear: $('clear'), saved: $('saved'), build: $('build'),
};

const state = {
  models: [], model: null, loadedId: null, loadWaiters: [],
  file: null, url: null, running: false, dirty: false,
  startedAt: 0, duration: 0, wakeLock: null, slowMode: false,
};

let worker = null;

boot().catch((err) => {
  el.boot.textContent = `Could not start: ${err.message || err}. Check the internet connection and reload the page.`;
  el.boot.classList.add('bad');
});

async function boot() {
  if ('serviceWorker' in navigator) {
    el.boot.textContent = 'Getting ready… the first time takes a minute or two.';
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller || !self.crossOriginIsolated) {
      let tried = false;
      try { tried = sessionStorage.getItem('st-reloaded') === '1'; sessionStorage.setItem('st-reloaded', '1'); } catch (_) { tried = true; }
      if (!tried) { location.reload(); return; }
    }
  }
  state.slowMode = !self.crossOriginIsolated;
  try { await navigator.storage?.persist?.(); } catch (_) {}

  const manifest = await (await fetch('models/manifest.json')).json();
  state.models = manifest.models;
  el.build.textContent = `Version ${manifest.build}`;
  renderModels();

  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => showError(`The speech engine stopped: ${e.message || 'unknown error'}`);

  el.boot.hidden = true;
  el.stepFile.hidden = false;
  el.stepRun.hidden = false;
  selectModel(state.models.find((m) => m.default) || state.models[0]);
}

function renderModels() {
  el.models.textContent = '';
  for (const m of state.models) {
    const label = document.createElement('label');
    label.className = 'model';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'model';
    input.value = m.id;
    input.checked = !!m.default;
    input.addEventListener('change', () => selectModel(m));
    const text = document.createElement('span');
    text.textContent = m.label;
    const small = document.createElement('small');
    small.textContent = m.note;
    small.dataset.note = m.id;
    text.append(small);
    label.append(input, text);
    el.models.append(label);
  }
}

function selectModel(model) {
  state.model = model;
  if (state.loadedId !== model.id) worker.postMessage({ type: 'load', model });
}

function whenLoaded(id) {
  if (state.loadedId === id) return Promise.resolve();
  return new Promise((resolve, reject) => state.loadWaiters.push({ id, resolve, reject }));
}

function setNote(id, text) {
  const node = el.models.querySelector(`small[data-note="${CSS.escape(id)}"]`);
  const model = state.models.find((m) => m.id === id);
  if (node && model) node.textContent = text ? `${model.note} · ${text}` : model.note;
}

function onWorker(event) {
  const msg = event.data;
  if (msg.type === 'load-progress') {
    const pct = Math.round((msg.loaded / msg.total) * 100);
    setNote(msg.id, `loading ${pct}%`);
    if (state.running && !state.duration) { el.bar.value = msg.loaded / msg.total; el.status.textContent = `Loading the speech engine… ${pct}%`; }
  } else if (msg.type === 'loaded') {
    state.loadedId = msg.id;
    setNote(msg.id, 'ready');
    state.loadWaiters = state.loadWaiters.filter((w) => { if (w.id === msg.id) { w.resolve(); return false; } return true; });
  } else if (msg.type === 'plan') {
    state.duration = msg.duration;
    state.startedAt = performance.now();
    el.bar.value = 0;
  } else if (msg.type === 'block') {
    appendSegments(msg.segments);
    const frac = msg.end / state.duration;
    el.bar.value = frac;
    const elapsed = (performance.now() - state.startedAt) / 1000;
    const left = msg.index >= 1 && frac > 0 ? elapsed * (1 - frac) / frac : null;
    el.status.textContent = `Transcribed ${clock(msg.end)} of ${clock(state.duration)}` + (left !== null && frac < 1 ? ` · ${left < 50 ? 'under a minute' : 'about ' + roughly(left)} left` : '');
  } else if (msg.type === 'done') {
    finish(msg.cancelled ? 'Stopped. The part already transcribed is below.' : `Finished in ${roughly((performance.now() - state.startedAt) / 1000)}.`);
  } else if (msg.type === 'error') {
    state.loadWaiters.forEach((w) => w.reject(new Error(msg.message)));
    state.loadWaiters = [];
    showError(msg.where === 'load'
      ? `The speech engine could not be loaded (${msg.message}). If this is the first use, connect to the internet and reload.`
      : `Something went wrong while transcribing (${msg.message}).`);
    if (state.running) finish('');
  }
}

// ---------- choosing a file ----------

el.file.addEventListener('change', () => { if (el.file.files[0]) chooseFile(el.file.files[0]); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && !state.running) chooseFile(f);
});

function chooseFile(file) {
  state.file = file;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  el.player.src = state.url;
  el.player.hidden = false;
  el.fileInfo.textContent = `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
  el.start.disabled = false;
  el.error.hidden = true;
}

// ---------- transcribing ----------

el.start.addEventListener('click', start);
el.cancel.addEventListener('click', () => { worker.postMessage({ type: 'cancel' }); el.status.textContent = 'Stopping after this section…'; el.cancel.disabled = true; });

async function start() {
  if (!state.file || state.running) return;
  if (el.out.value.trim() && state.dirty && !window.confirm('This replaces the transcript below, which has not been saved. Continue?')) return;
  state.running = true;
  state.duration = 0;
  el.error.hidden = true;
  el.out.value = '';
  el.saved.textContent = '';
  state.dirty = false;
  setBusy(true);
  try {
    el.status.textContent = 'Reading the recording…';
    el.bar.removeAttribute('value');
    const audio = await decode(state.file);
    if (audio.length < SR / 2) throw new Error('That recording is empty or too short.');
    el.status.textContent = 'Loading the speech engine…';
    await whenLoaded(state.model.id);
    el.status.textContent = state.slowMode ? 'Transcribing (slower mode)…' : 'Transcribing…';
    el.stepOut.hidden = false;
    await holdAwake();
    worker.postMessage({ type: 'run', audio }, [audio.buffer]);
  } catch (err) {
    showError(friendly(err));
    finish('');
  }
}

// Turn the chosen file into what Whisper expects: one channel at 16,000 samples a second.
async function decode(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(bytes);
  const n = buf.length;
  const mono = new Float32Array(n);
  const channels = buf.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += data[i];
  }
  if (channels > 1) for (let i = 0; i < n; i++) mono[i] /= channels;
  return mono;
}

function friendly(err) {
  const m = String(err?.message || err);
  if (err?.name === 'EncodingError' || /decod/i.test(m)) return 'That file could not be read as audio. Use a WAV or MP3 file from the recorder.';
  if (/memory|allocation/i.test(m)) return 'The recording is too large for this device to open. Try recording in MP3 mode, or split the file.';
  return m;
}

function appendSegments(segments) {
  if (!segments.length) return;
  const text = el.times.checked
    ? segments.map((s) => `[${clock(s.t)}] ${s.text}`).join('\n')
    : segments.map((s) => s.text).join(' ');
  const atEnd = el.out.scrollTop + el.out.clientHeight >= el.out.scrollHeight - 30;
  el.out.value += (el.out.value ? '\n' : '') + text;
  if (atEnd) el.out.scrollTop = el.out.scrollHeight;
  state.dirty = true;
}

function finish(message) {
  state.running = false;
  setBusy(false);
  el.bar.value = message.startsWith('Finished') ? 1 : el.bar.value;
  el.status.textContent = message;
  try { state.wakeLock?.release(); } catch (_) {}
  state.wakeLock = null;
  if (el.out.value.trim()) el.stepOut.hidden = false;
}

function setBusy(busy) {
  el.start.disabled = busy || !state.file;
  el.cancel.hidden = !busy;
  el.cancel.disabled = false;
  el.wrap.hidden = false;
  el.file.disabled = busy;
  el.times.disabled = busy;
  el.clear.disabled = busy;
  el.models.querySelectorAll('input').forEach((i) => { i.disabled = busy; });
}

function showError(text) {
  el.error.textContent = text;
  el.error.hidden = false;
}

// ---------- saving ----------

el.out.addEventListener('input', () => { state.dirty = true; el.saved.textContent = ''; });

el.save.addEventListener('click', () => {
  const stem = (state.file?.name || 'recording').replace(/\.[^.]+$/, '');
  const blob = new Blob([el.out.value.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${stem} transcript.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  state.dirty = false;
  el.saved.textContent = 'Saved to this device. Keep it out of shared or online folders.';
});

el.copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el.out.value); el.saved.textContent = 'Copied.'; }
  catch (_) { el.out.select(); el.saved.textContent = 'Press Ctrl+C to copy.'; }
});

el.clear.addEventListener('click', () => {
  if (state.dirty && el.out.value.trim() && !window.confirm('Clear the recording and the unsaved transcript from this page?')) return;
  if (state.running) worker.postMessage({ type: 'cancel' });
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { file: null, url: null, dirty: false });
  el.player.removeAttribute('src');
  el.player.load();
  el.player.hidden = true;
  el.file.value = '';
  el.fileInfo.textContent = '';
  el.out.value = '';
  el.saved.textContent = '';
  el.status.textContent = '';
  el.wrap.hidden = true;
  el.stepOut.hidden = true;
  el.start.disabled = true;
});

window.addEventListener('beforeunload', (e) => {
  if (state.running || (state.dirty && el.out.value.trim())) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running && !state.wakeLock) await holdAwake();
});

// Stop the screen (and so the device) going to sleep part-way through a recording.
async function holdAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!lock) return;
    state.wakeLock = lock;
    lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
  } catch (_) {}
}

// ---------- small helpers ----------

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function roughly(seconds) {
  if (seconds < 50) return 'under a minute';
  const m = Math.round(seconds / 60);
  return m === 1 ? '1 minute' : `${m} minutes`;
}
