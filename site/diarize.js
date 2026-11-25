// Works out who is speaking when ("speaker diarisation"), entirely on this device.
//
// Two small models are used:
//   1. a segmentation model (pyannote segmentation 3.0) that listens to 10 seconds at a
//      time and marks when each voice in that stretch is talking;
//   2. a voice-print model (WeSpeaker CAM++) that turns a few seconds of one voice into
//      a list of numbers, so the same person can be recognised across the recording.
// The voice-prints are then grouped into the number of people in the room.
//
// `tf` is the Transformers.js library, passed in so the same code runs in the browser
// worker and in the Node test script.

const SR = 16000;
const WIN = 160000; // 10 s, what the segmentation model was trained on
const STEP = 80000; // windows overlap by half
const SHIFT = 270; // samples between the model's output frames (about 17 ms)
const FIELD_OFFSET = 360; // centres each frame on the audio it describes
const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];
const LOCAL = 3; // the segmentation model tracks up to 3 voices per window
const FRAME_SEC = SHIFT / SR;

const MIN_SPEECH = 0.25; // ignore voices heard for less than this in a window
const MIN_EMBED = 0.4; // shortest audio worth making a voice-print from
const STRONG = 1.0; // voice-prints from at least this much audio drive the grouping
const MAX_EMBED = 4.0; // seconds of audio per voice-print (more adds time, not accuracy)
const SAME_VOICE = 0.55; // groups more alike than this are treated as one person

export const SEGMENTATION_ID = 'speakers/segmentation';
export const EMBEDDING_ID = 'speakers/embedding';

export async function loadDiarizer(tf, options = {}) {
  const [seg, emb] = await Promise.all([
    tf.AutoModel.from_pretrained(SEGMENTATION_ID, { dtype: 'fp32', ...options }),
    tf.AutoModel.from_pretrained(EMBEDDING_ID, { dtype: 'fp32', ...options }),
  ]);
  const fbank = new tf.WeSpeakerFeatureExtractor({ sampling_rate: SR, num_mel_bins: 80, fbank_centering_span: null, min_num_frames: 40 });
  return { seg, emb, fbank };
}

function unit(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Runs of consecutive true values in a mask: [[start, end), ...]
function runs(mask) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push([start, i]); start = -1; }
  }
  return out;
}

// Pick up to MAX_EMBED seconds of one voice from a window: longest stretches first, kept in time order.
function gather(windowAudio, mask) {
  const stretches = runs(mask).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const budget = Math.round(MAX_EMBED / FRAME_SEC);
  const chosen = [];
  let used = 0;
  for (const [a, b] of stretches) {
    if (used >= budget) break;
    const take = Math.min(b - a, budget - used);
    chosen.push([a, a + take]);
    used += take;
  }
  chosen.sort((x, y) => x[0] - y[0]);
  const out = new Float32Array(used * SHIFT);
  let o = 0;
  for (const [a, b] of chosen) {
    const s = Math.min(windowAudio.length, a * SHIFT + FIELD_OFFSET);
    const e = Math.min(windowAudio.length, b * SHIFT + FIELD_OFFSET);
    out.set(windowAudio.subarray(s, e), o);
    o += e - s;
  }
  return out.subarray(0, o);
}

// Group voice-prints into `k` people. Merges the two most alike groups repeatedly, then
// picks the point where `k` sizeable groups remain, so a stray noise cannot claim a seat.
function cluster(items, k) {
  let strong = items.filter((it) => it.dur >= STRONG);
  if (strong.length < k) strong = items.slice();
  if (!strong.length) return null;

  let groups = strong.map((it) => ({ sum: Float32Array.from(it.emb, (v) => v * it.dur), dur: it.dur, n: 1 }));
  const total = strong.reduce((s, it) => s + it.dur, 0);
  const big = (g) => g.dur >= Math.max(0.04 * total, STRONG);
  let best = groups.filter(big).length >= k ? groups.map((g) => ({ ...g })) : null;
  let exact = groups.length === k ? groups.map((g) => ({ ...g })) : null;

  while (groups.length > 1) {
    const units = groups.map((g) => unit(g.sum));
    let bi = 0;
    let bj = 1;
    let bs = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const s = dot(units[i], units[j]);
        if (s > bs) { bs = s; bi = i; bj = j; }
      }
    }
    const a = groups[bi];
    const b = groups[bj];
    const sum = new Float32Array(a.sum.length);
    for (let i = 0; i < sum.length; i++) sum[i] = a.sum[i] + b.sum[i];
    groups = groups.filter((_, i) => i !== bi && i !== bj);
    groups.push({ sum, dur: a.dur + b.dur, n: a.n + b.n });
    if (groups.filter(big).length >= k) best = groups.map((g) => ({ ...g }));
    if (groups.length === k) exact = groups.map((g) => ({ ...g }));
  }

  const chosen = (best || exact || groups).slice().sort((x, y) => y.dur - x.dur).slice(0, k);
  let centres = chosen.map((g) => unit(g.sum));

  // Refine: every voice-print joins its nearest group; groups are re-averaged from the strong ones.
  for (let round = 0; round < 4; round++) {
    const sums = centres.map((c) => new Float32Array(c.length));
    const durs = centres.map(() => 0);
    for (const it of strong) {
      let b = 0;
      for (let c = 1; c < centres.length; c++) if (dot(it.emb, centres[c]) > dot(it.emb, centres[b])) b = c;
      for (let i = 0; i < it.emb.length; i++) sums[b][i] += it.emb[i] * it.dur;
      durs[b] += it.dur;
    }
    centres = centres.map((c, i) => (durs[i] > 0 ? unit(sums[i]) : c));
  }

  // If two groups sound like the same person, fold them together.
  let merged = true;
  while (merged && centres.length > 1) {
    merged = false;
    for (let i = 0; i < centres.length && !merged; i++) {
      for (let j = i + 1; j < centres.length && !merged; j++) {
        if (dot(centres[i], centres[j]) > SAME_VOICE) {
          const sum = new Float32Array(centres[i].length);
          for (let x = 0; x < sum.length; x++) sum[x] = centres[i][x] + centres[j][x];
          centres = centres.filter((_, x) => x !== i && x !== j);
          centres.push(unit(sum));
          merged = true;
        }
      }
    }
  }
  return centres;
}

/**
 * @returns {Promise<{found:number, frameSec:number, active:Uint8Array[], overlap:(a:number,b:number)=>number[]}>}
 *   `active[s][f]` is 1 when person `s` is talking in frame `f`. People are numbered in the
 *   order they first speak.
 */
export async function diarize(tf, models, audio, people, onProgress = () => {}) {
  const { seg, emb, fbank } = models;
  const nWindows = Math.max(1, Math.ceil((audio.length - WIN) / STEP) + 1);
  const windows = [];
  const items = [];

  for (let w = 0; w < nWindows; w++) {
    const offset = w * STEP;
    const chunk = new Float32Array(WIN);
    chunk.set(audio.subarray(offset, Math.min(audio.length, offset + WIN)));
    const valid = Math.min(WIN, audio.length - offset);

    const out = await seg({ x: new tf.Tensor('float32', chunk, [1, 1, WIN]) });
    const y = out.y ?? Object.values(out)[0];
    const [, frames, classes] = y.dims;
    const data = y.data;
    const usable = Math.min(frames, Math.max(0, Math.floor((valid - FIELD_OFFSET) / SHIFT)));

    const act = Array.from({ length: LOCAL }, () => new Uint8Array(frames));
    const solo = Array.from({ length: LOCAL }, () => new Uint8Array(frames));
    for (let f = 0; f < usable; f++) {
      let best = 0;
      for (let c = 1; c < classes; c++) if (data[f * classes + c] > data[f * classes + best]) best = c;
      const who = POWERSET[best];
      for (const s of who) act[s][f] = 1;
      if (who.length === 1) solo[who[0]][f] = 1;
    }

    const labels = new Int8Array(LOCAL).fill(-1);
    const heard = [];
    for (let s = 0; s < LOCAL; s++) {
      const activeSec = act[s].reduce((a, b) => a + b, 0) * FRAME_SEC;
      if (activeSec < MIN_SPEECH) continue;
      heard.push(s);
      let clip = gather(chunk, solo[s]);
      if (clip.length < MIN_EMBED * SR) clip = gather(chunk, act[s]);
      if (clip.length < MIN_EMBED * SR) continue;
      const { input_features } = await fbank(clip);
      const res = await emb({ feats: input_features });
      const vec = unit((res.embs ?? Object.values(res)[0]).data);
      items.push({ w, s, emb: vec, dur: clip.length / SR });
    }
    windows.push({ offset, frames, act, labels, heard });
    onProgress((w + 1) / nWindows);
  }

  const nFrames = Math.ceil(audio.length / SHIFT) + 1;
  const empty = () => ({ found: 0, frameSec: FRAME_SEC, active: [], overlap: () => [] });
  const centres = people >= 2 ? cluster(items, people) : null;
  if (!centres) return empty();
  const k = centres.length;

  const nearest = (vec) => {
    let b = 0;
    for (let c = 1; c < k; c++) if (dot(vec, centres[c]) > dot(vec, centres[b])) b = c;
    return b;
  };
  // Voices heard clearly in a window are matched by their voice-print.
  for (const it of items) if (it.dur >= STRONG) windows[it.w].labels[it.s] = nearest(it.emb);
  // A brief voice ("mm-hm", "right") gives a poor voice-print. If everyone else in that
  // window is accounted for and exactly one person is left over, it must be them.
  // Otherwise fall back to the voice-print, if there is one.
  const weak = new Map(items.filter((it) => it.dur < STRONG).map((it) => [`${it.w}:${it.s}`, it]));
  windows.forEach((win, w) => {
    const unknown = win.heard.filter((s) => win.labels[s] < 0);
    const taken = new Set(win.heard.filter((s) => win.labels[s] >= 0).map((s) => win.labels[s]));
    const free = [];
    for (let c = 0; c < k; c++) if (!taken.has(c)) free.push(c);
    if (unknown.length === 1 && free.length === 1 && taken.size >= 1) { win.labels[unknown[0]] = free[0]; return; }
    for (const s of unknown) {
      const it = weak.get(`${w}:${s}`);
      if (it) win.labels[s] = nearest(it.emb);
    }
  });

  // Blend the overlapping windows into one timeline, trusting the middle of each window most.
  const score = Array.from({ length: k }, () => new Float32Array(nFrames));
  const weight = new Float32Array(nFrames);
  for (const win of windows) {
    const base = Math.round(win.offset / SHIFT);
    for (let f = 0; f < win.frames; f++) {
      const g = base + f;
      if (g >= nFrames) break;
      const wgt = 0.05 + Math.sin((Math.PI * (f + 0.5)) / win.frames) ** 2;
      weight[g] += wgt;
      for (const s of win.heard) {
        const label = win.labels[s];
        if (label >= 0 && win.act[s][f]) score[label][g] += wgt;
      }
    }
  }
  let active = score.map((row) => {
    const out = new Uint8Array(nFrames);
    for (let g = 0; g < nFrames; g++) out[g] = weight[g] > 0 && row[g] / weight[g] >= 0.5 ? 1 : 0;
    return out;
  });

  // Number people in the order they first speak.
  const first = active.map((row) => { const i = row.indexOf(1); return i < 0 ? Infinity : i; });
  const order = active.map((_, i) => i).sort((a, b) => first[a] - first[b]).filter((i) => first[i] !== Infinity);
  active = order.map((i) => active[i]);

  const prefix = active.map((row) => {
    const p = new Uint32Array(nFrames + 1);
    for (let g = 0; g < nFrames; g++) p[g + 1] = p[g] + row[g];
    return p;
  });
  /** Seconds each person talks between times `a` and `b`. */
  const overlap = (a, b) => {
    const fa = Math.max(0, Math.min(nFrames, Math.round(a / FRAME_SEC)));
    const fb = Math.max(fa, Math.min(nFrames, Math.round(b / FRAME_SEC)));
    return prefix.map((p) => (p[fb] - p[fa]) * FRAME_SEC);
  };
  return { found: active.length, frameSec: FRAME_SEC, active, overlap };
}

/**
 * Decide who said one transcribed line. Returns one or more pieces: a line is split at
 * sentence ends when two people clearly speak within it.
 * @param {{overlap:Function, found:number}} who
 * @param {{start:number, end:number, text:string}} line
 * @param {number} previous speaker of the line before (used when nothing else is known)
 */
export function assign(who, line, previous = 0) {
  const pick = (a, b) => {
    let secs = who.overlap(a, b);
    if (!secs.some((v) => v > 0)) secs = who.overlap(a - 0.6, b + 0.6);
    let best = -1;
    let second = -1;
    for (let i = 0; i < secs.length; i++) {
      if (best < 0 || secs[i] > secs[best]) { second = best; best = i; }
      else if (second < 0 || secs[i] > secs[second]) second = i;
    }
    if (best < 0 || secs[best] <= 0) return { speaker: previous, top: 0, next: 0 };
    return { speaker: best, top: secs[best], next: second >= 0 ? secs[second] : 0 };
  };

  const whole = pick(line.start, line.end);
  const mixed = whole.next >= 0.3 && whole.next >= 0.08 * (whole.top + whole.next);
  if (!mixed) return [{ ...line, speaker: whole.speaker, check: false }];

  // Two voices in one line. Estimate when each sentence was said from its length, and
  // give each sentence to whoever was talking then. Marked for checking.
  const sentences = line.text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [line.text];
  const clear = whole.next >= 0.7 && whole.next >= 0.25 * (whole.top + whole.next); // a real exchange, not a brief "mm"
  if (sentences.length < 2) return [{ ...line, speaker: whole.speaker, check: clear }];
  const chars = sentences.reduce((s, t) => s + t.length, 0);
  const span = line.end - line.start;
  const pieces = [];
  let at = line.start;
  let last = previous;
  for (const sentence of sentences) {
    const len = (sentence.length / chars) * span;
    const p = pick(at, at + len);
    const speaker = p.top > 0 ? p.speaker : last;
    const prev = pieces[pieces.length - 1];
    if (prev && prev.speaker === speaker) { prev.text += sentence; prev.end = at + len; }
    else pieces.push({ start: at, end: at + len, text: sentence, speaker, check: true });
    at += len;
    last = speaker;
  }
  for (const p of pieces) p.text = p.text.trim();
  const out = pieces.filter((p) => p.text);
  if (out.length < 2) return [{ ...line, speaker: out[0]?.speaker ?? whole.speaker, check: clear }];
  return out;
}
