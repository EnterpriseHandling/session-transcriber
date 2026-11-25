// The transcript on screen: a list of "turns", each with a start time, who spoke
// (when speaker labels are on) and editable text.
//
// Editing: type in any line. Enter splits a line in two at the cursor (handy when two
// people ended up on one line). Backspace at the very start joins it to the line above.
// Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes.

const JOIN_GAP = 1.5; // seconds of silence that starts a new paragraph
const MAX_TURN = 20; // seconds before a long stretch by one person gets a new paragraph
const HISTORY = 200; // undo steps kept
const TYPING_PAUSE = 1200; // ms: a pause in typing starts a new undo step

let nextId = 1;

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export class Transcript {
  constructor({ root, whoRoot, onChange = () => {}, onPlay = () => {}, onHistory = () => {} }) {
    this.root = root;
    this.whoRoot = whoRoot;
    this.onChange = onChange;
    this.onPlay = onPlay;
    this.turns = [];
    this.names = ['Speaker'];
    this.labelled = false;
    this.note = '';
    this.onHistory = onHistory;
    this.past = [];
    this.future = [];
    this.typing = null;
    root.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); this.redo(); }
    });
  }

  // ---------- undo / redo ----------

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  snapshot() {
    return this.turns.map(({ id, t, end, person, text, check }) => ({ id, t, end, person, text, check }));
  }

  /** Call before any change, so it can be undone. */
  record() {
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY) this.past.shift();
    this.future = [];
    this.onHistory();
  }

  endTyping() { clearTimeout(this.typing?.timer); this.typing = null; }

  clearHistory() { this.past = []; this.future = []; this.endTyping(); this.onHistory(); }

  restore(snap, focusId) {
    this.turns = snap.map((t) => ({ ...t }));
    this.root.textContent = '';
    for (const turn of this.turns) this.root.append(this.buildRow(turn));
    this.renderWho();
    const target = this.turns.find((t) => t.id === focusId);
    if (target) this.placeCaret(target.textEl, target.text.length);
    this.onChange();
    this.onHistory();
  }

  focusedId() { return this.turns.find((t) => t.textEl === document.activeElement)?.id; }

  undo() {
    if (!this.past.length) return;
    this.endTyping();
    const id = this.focusedId();
    this.future.push(this.snapshot());
    this.restore(this.past.pop(), id);
  }

  redo() {
    if (!this.future.length) return;
    this.endTyping();
    const id = this.focusedId();
    this.past.push(this.snapshot());
    this.restore(this.future.pop(), id);
  }

  get empty() { return !this.turns.some((t) => t.text.trim()); }

  reset({ names, labelled }) {
    this.turns = [];
    this.names = names.length ? names.slice() : ['Speaker'];
    this.labelled = labelled && this.names.length >= 2;
    this.note = '';
    this.root.textContent = '';
    this.clearHistory();
    this.renderWho();
  }

  /** Rename people; every label on screen follows. */
  setNames(names) {
    if (names.length !== this.names.length) return;
    this.names = names.slice();
    for (const turn of this.turns) this.fillSelect(turn);
    this.renderWho();
  }

  setNote(text) { this.note = text; this.renderWho(); }

  showTimes(on) { this.root.classList.toggle('no-times', !on); }

  /** Add newly transcribed pieces. Consecutive pieces by the same person join into one paragraph. */
  append(segments) {
    for (const seg of segments) {
      const last = this.turns[this.turns.length - 1];
      const person = Math.min(seg.speaker || 0, this.names.length - 1);
      const canJoin = this.labelled && last && last.person === person && !seg.check && !last.check
        && seg.t - last.end < JOIN_GAP && seg.end - last.t < MAX_TURN
        && document.activeElement !== last.textEl;
      if (canJoin) {
        last.text = `${last.text} ${seg.text}`;
        last.end = seg.end;
        last.textEl.textContent = last.text;
        last.row.dataset.end = last.end.toFixed(2);
      } else {
        const turn = { id: nextId++, t: seg.t, end: seg.end, person, text: seg.text, check: !!seg.check };
        this.turns.push(turn);
        this.root.append(this.buildRow(turn));
      }
    }
    if (segments.length) { this.renderWho(); if (this.past.length || this.future.length) this.clearHistory(); }
  }

  // ---------- rows ----------

  buildRow(turn) {
    const row = document.createElement('div');
    row.className = 'turn';
    row.dataset.t = turn.t.toFixed(2);
    row.dataset.end = turn.end.toFixed(2);
    turn.row = row;

    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'turn-time';
    time.textContent = clock(turn.t);
    time.title = 'Play the recording from here';
    time.setAttribute('aria-label', `Play from ${clock(turn.t)}`);
    time.addEventListener('click', () => this.onPlay(turn.t));
    turn.timeEl = time;
    row.append(time);

    if (this.labelled) {
      const who = document.createElement('select');
      who.className = 'turn-who';
      who.setAttribute('aria-label', 'Who is speaking');
      who.addEventListener('change', () => {
        this.endTyping();
        const before = this.snapshot();
        before.find((x) => x.id === turn.id).person = turn.person;
        this.past.push(before);
        this.future = [];
        this.onHistory();
        turn.person = Number(who.value);
        this.setCheck(turn, false);
        this.paint(turn);
        this.renderWho();
        this.onChange();
      });
      turn.whoEl = who;
      this.fillSelect(turn);
      row.append(who);
    }

    const text = document.createElement('div');
    text.className = 'turn-text';
    text.contentEditable = 'plaintext-only';
    if (text.contentEditable !== 'plaintext-only') text.contentEditable = 'true';
    text.setAttribute('role', 'textbox');
    text.setAttribute('aria-multiline', 'true');
    text.setAttribute('aria-label', `Transcript text at ${clock(turn.t)}`);
    text.spellcheck = true;
    text.textContent = turn.text;
    text.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); return; }
      if (this.typing?.id !== turn.id) { this.endTyping(); this.record(); this.typing = { id: turn.id }; }
      clearTimeout(this.typing.timer);
      this.typing.timer = setTimeout(() => this.endTyping(), TYPING_PAUSE);
    });
    text.addEventListener('input', () => { turn.text = text.textContent.replace(/\n+/g, ' '); this.onChange(); });
    text.addEventListener('blur', () => this.endTyping());
    text.addEventListener('keydown', (e) => this.onKey(e, turn));
    turn.textEl = text;
    row.append(text);

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'turn-check';
    check.textContent = 'Check';
    check.title = 'Two voices were heard close together here. Check who said what, then click to clear this.';
    check.addEventListener('click', () => { this.endTyping(); this.record(); this.setCheck(turn, false); });
    turn.checkEl = check;
    row.append(check);

    this.setCheck(turn, turn.check);
    this.paint(turn);
    return row;
  }

  fillSelect(turn) {
    if (!turn.whoEl) return;
    turn.whoEl.textContent = '';
    this.names.forEach((name, i) => turn.whoEl.append(new Option(name, String(i))));
    turn.whoEl.value = String(turn.person);
  }

  paint(turn) {
    turn.row.className = `turn${this.labelled ? ` sp-${turn.person}` : ''}`;
    if (turn.whoEl) turn.whoEl.value = String(turn.person);
  }

  setCheck(turn, on) {
    turn.check = on;
    turn.checkEl.hidden = !on;
  }

  caretOffset(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    const before = range.cloneRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    return { offset: before.toString().length, collapsed: range.collapsed };
  }

  placeCaret(el, offset) {
    el.focus();
    const node = el.firstChild;
    if (!node) return;
    const range = document.createRange();
    range.setStart(node, Math.min(offset, node.textContent.length));
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  onKey(e, turn) {
    if (e.isComposing) return;
    const caret = this.caretOffset(turn.textEl);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (caret) this.split(turn, caret.offset);
    } else if (e.key === 'Backspace' && caret && caret.collapsed && caret.offset === 0) {
      const i = this.turns.indexOf(turn);
      if (i > 0) { e.preventDefault(); this.join(this.turns[i - 1], turn); }
    }
  }

  /** Split one line into two at a character position. The second half goes to the next person. */
  split(turn, offset) {
    const full = turn.textEl.textContent;
    const left = full.slice(0, offset).trimEnd();
    const right = full.slice(offset).trimStart();
    if (!left || !right) return;
    this.endTyping();
    this.record();
    const at = turn.t + (turn.end - turn.t) * (offset / Math.max(1, full.length));
    const i = this.turns.indexOf(turn);
    const second = {
      id: nextId++, t: at, end: turn.end, text: right, check: false,
      person: this.labelled ? (turn.person + 1) % this.names.length : turn.person,
    };
    turn.text = left;
    turn.end = at;
    turn.textEl.textContent = left;
    turn.row.dataset.end = at.toFixed(2);
    this.setCheck(turn, false);
    this.turns.splice(i + 1, 0, second);
    turn.row.after(this.buildRow(second));
    this.placeCaret(second.textEl, 0);
    this.renderWho();
    this.onChange();
  }

  join(first, second) {
    this.endTyping();
    this.record();
    const at = first.textEl.textContent.length + 1;
    first.text = `${first.textEl.textContent.trimEnd()} ${second.textEl.textContent.trimStart()}`;
    first.end = second.end;
    first.textEl.textContent = first.text;
    first.row.dataset.end = first.end.toFixed(2);
    this.turns.splice(this.turns.indexOf(second), 1);
    second.row.remove();
    this.placeCaret(first.textEl, at);
    this.renderWho();
    this.onChange();
  }

  // ---------- who is who ----------

  /** Swap two people everywhere (the app cannot know which voice has which name). */
  swap(a, b) {
    if (a === b) return;
    this.endTyping();
    this.record();
    for (const turn of this.turns) {
      if (turn.person === a) turn.person = b;
      else if (turn.person === b) turn.person = a;
      this.paint(turn);
    }
    this.renderWho();
    this.onChange();
  }

  renderWho() {
    const root = this.whoRoot;
    root.textContent = '';
    const present = [...new Set(this.turns.map((t) => t.person))].sort();
    root.hidden = !this.labelled || this.turns.length === 0;
    if (root.hidden) return;

    const title = document.createElement('p');
    title.className = 'who-title';
    title.textContent = 'Check who is who';
    root.append(title);

    if (this.note) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = this.note;
      root.append(note);
    }
    if (present.length < 2 && !this.note) return;

    for (const person of present) {
      const sample = this.turns.find((t) => t.person === person && t.text.split(/\s+/).length >= 4)
        || this.turns.find((t) => t.person === person);
      const line = document.createElement('div');
      line.className = `who-line sp-${person}`;

      const select = document.createElement('select');
      select.setAttribute('aria-label', 'This voice is');
      this.names.forEach((name, i) => select.append(new Option(name, String(i))));
      select.value = String(person);
      select.addEventListener('change', () => this.swap(person, Number(select.value)));

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'who-play';
      play.textContent = '▶';
      play.title = 'Play this line';
      play.setAttribute('aria-label', `Play a line by ${this.names[person]}`);
      play.addEventListener('click', () => this.onPlay(sample.t));

      const quote = document.createElement('span');
      quote.className = 'who-quote';
      const words = sample.text.split(/\s+/);
      quote.textContent = `“${words.slice(0, 12).join(' ')}${words.length > 12 ? '…' : ''}”`;

      line.append(select, play, quote);
      root.append(line);
    }
    if (present.length >= 2) {
      const tip = document.createElement('p');
      tip.className = 'hint';
      tip.textContent = 'If the names are the wrong way round, change one here and the whole transcript follows.';
      root.append(tip);
    }
  }

  // ---------- export ----------

  /** Turns ready for saving: [{ time, name, person, text }] */
  lines() {
    return this.turns
      .map((t) => ({ time: t.t, person: t.person, name: this.labelled ? this.names[t.person] : '', text: t.text.replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.text);
  }

  text({ times = true } = {}) {
    const lines = this.lines();
    if (this.labelled) {
      return lines.map((l) => `${times ? `[${clock(l.time)}] ` : ''}${l.name}: ${l.text}`).join('\n\n');
    }
    return times ? lines.map((l) => `[${clock(l.time)}] ${l.text}`).join('\n') : lines.map((l) => l.text).join(' ');
  }
}
