// In-app recorder for Session Transcriber.
//
// Safety design:
//  - Audio is saved to this device every 5 seconds while recording, so a crash,
//    closed tab or flat battery loses at most a few seconds.
//  - Every saved piece is encrypted (AES-GCM, 256-bit). The key is created by the
//    browser as "non-extractable": it can be used by this app on this device but can
//    never be read out, copied or exported. The stored pieces are unreadable elsewhere.
//  - Nothing is ever deleted silently. Recordings stay until Frances deletes them.

const DB_NAME = 'st-recorder';
const SLICE_MS = 5000;
const BITRATE = 64000; // about 14 MB per 30 minutes

let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage was interrupted'));
  });
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('keys');
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: ['session', 'seq'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function getKey() {
  const db = await openDb();
  const existing = await promisify(db.transaction('keys').objectStore('keys').get('main'));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(key, 'main');
  await done(tx);
  return key;
}

function chunkRange(id) {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

/** Recordings kept on this device, newest first. Does not create storage if none exists. */
export async function listKept() {
  try {
    if (indexedDB.databases) {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(DB_NAME)) return [];
    }
    const db = await openDb();
    const sessions = await promisify(db.transaction('sessions').objectStore('sessions').getAll());
    return sessions.sort((a, b) => b.started - a.started);
  } catch (_) {
    return [];
  }
}

/** Decrypts and joins a kept recording into one audio file. */
export async function loadKept(session) {
  const key = await getKey();
  const db = await openDb();
  const chunks = await promisify(db.transaction('chunks').objectStore('chunks').getAll(chunkRange(session.id)));
  if (!chunks.length) throw new Error('That recording has no audio in it.');
  const parts = [];
  for (const c of chunks) parts.push(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.iv }, key, c.data));
  return new File(parts, fileName(session), { type: session.mime });
}

export async function deleteKept(id) {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
  tx.objectStore('chunks').delete(chunkRange(id));
  tx.objectStore('sessions').delete(id);
  await done(tx);
}

export function fileName(session) {
  const d = new Date(session.started);
  const pad = (v) => String(v).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}.webm`;
}

export async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
}

export class Recorder {
  constructor({ onLevel, onTick, onError } = {}) {
    this.onLevel = onLevel || (() => {});
    this.onTick = onTick || (() => {});
    this.onError = onError || (() => {});
    this.state = 'idle';
    this.saving = Promise.resolve();
    this.saveFailed = null;
  }

  get elapsed() {
    const running = this.state === 'recording' ? performance.now() - this.resumedAt : 0;
    return (this.banked + running) / 1000;
  }

  async start(deviceId) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false, // these clean-ups are meant for calls and can swallow quiet speech in a room
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.media = new MediaRecorder(this.stream, { mimeType: mime || undefined, audioBitsPerSecond: BITRATE });

    this.key = await getKey();
    this.session = { id: crypto.randomUUID(), started: Date.now(), mime: this.media.mimeType || 'audio/webm', duration: 0 };
    this.seq = 0;
    this.banked = 0;
    this.resumedAt = performance.now();
    await this.writeSession();

    this.media.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const seq = this.seq++;
      const duration = Math.round(this.elapsed);
      this.saving = this.saving.then(() => this.saveChunk(seq, e.data, duration)).catch((err) => {
        if (!this.saveFailed) { this.saveFailed = err; this.onError(new Error('Saving the recording on this Chromebook failed. The storage may be full.')); }
      });
    };
    for (const track of this.stream.getAudioTracks()) {
      track.onended = () => { if (this.state !== 'idle' && this.state !== 'stopping') this.onError(new Error('The microphone stopped (unplugged or switched off). Everything up to that point is kept.'), true); };
    }

    this.startMeter();
    this.media.start(SLICE_MS);
    this.state = 'recording';
    this.ticker = setInterval(() => this.onTick(this.elapsed), 250);
    return this.session;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.media.pause();
    this.banked += performance.now() - this.resumedAt;
    this.state = 'paused';
    this.onTick(this.elapsed);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.media.resume();
    this.resumedAt = performance.now();
    this.state = 'recording';
  }

  /** Stops, waits for the last piece to be saved, and returns the finished recording. */
  async stop() {
    if (this.state === 'idle') return null;
    const wasRecording = this.state === 'recording';
    this.state = 'stopping';
    if (wasRecording) this.banked += performance.now() - this.resumedAt;
    if (this.media.state !== 'inactive') {
      await new Promise((resolve) => { this.media.addEventListener('stop', resolve, { once: true }); this.media.stop(); });
    }
    await this.saving;
    this.session.duration = Math.round(this.banked / 1000);
    await this.writeSession();
    this.cleanUp();
    this.state = 'idle';
    return { session: this.session, file: await loadKept(this.session) };
  }

  cleanUp() {
    clearInterval(this.ticker);
    cancelAnimationFrame(this.raf);
    try { this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); }); } catch (_) {}
    try { this.ctx?.close(); } catch (_) {}
  }

  async writeSession() {
    const db = await openDb();
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(this.session);
    await done(tx);
  }

  async saveChunk(seq, blob, duration) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, await blob.arrayBuffer());
    this.session.duration = duration;
    const db = await openDb();
    const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
    tx.objectStore('chunks').put({ session: this.session.id, seq, iv, data });
    tx.objectStore('sessions').put(this.session);
    await done(tx);
  }

  startMeter() {
    try {
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const draw = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(rms || 1e-8);
        this.onLevel(this.state === 'recording' ? Math.min(1, Math.max(0, (db + 60) / 50)) : 0);
        this.raf = requestAnimationFrame(draw);
      };
      draw();
    } catch (_) { /* the meter is a nicety; recording carries on without it */ }
  }
}
