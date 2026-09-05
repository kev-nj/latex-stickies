const COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'];
const SWATCH = {
  yellow: '#fdf3a8', blue: '#cfe6fb', green: '#d3f2c8',
  pink: '#fbd2e2', purple: '#e2d6fb', gray: '#e6e6e6',
};

const { openSearchPanel } = window.CM;

const host = document.getElementById('host');
const pin = document.getElementById('pin');

let note = null;
let view = null;

/* ---------- state ---------- */

// Trailing debounce, but with a ceiling. A debounce that resets on every
// keystroke never fires while you are typing, so the file could trail the
// screen by as long as the burst lasted -- and anything that then read the
// file got text seconds out of date. VS Code's autosave delay is 1s; this
// keeps the quick 250ms settle and caps the wait at 1s.
const SAVE_SETTLE_MS = 250;
const SAVE_MAX_MS = 1000;

let saveTimer = null;
let pendingSince = 0;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  pendingSince = 0;
  if (note) window.sticky.update({ body: note.body });
}

function scheduleSave() {
  if (!pendingSince) pendingSince = Date.now();
  if (Date.now() - pendingSince >= SAVE_MAX_MS) {
    saveNow();
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_SETTLE_MS);
}

// Losing focus is the moment to be certain: the file is what another editor,
// or a sync engine, is about to read. VS Code ships the same behaviour as
// files.autoSave onFocusChange.
window.addEventListener('blur', () => {
  if (saveTimer) saveNow();
});

// Typing is saved on a debounce, which Cmd+W would otherwise outrun: the window
// is closed from the main process, so the pending timer dies with the renderer
// and the last few words typed are lost. beforeunload is the last point the
// renderer can still be heard, and the flush is synchronous for that reason.
window.addEventListener('beforeunload', () => {
  if (!note) return;
  clearTimeout(saveTimer);
  if (view) note.body = view.state.doc.toString();
  window.sticky.flush(note.body);
});

function setColor(color) {
  note.color = color;
  document.body.dataset.color = color;
  document.querySelectorAll('#swatches span').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === color);
  });
  window.sticky.update({ color });
}

function setFontSize(size) {
  note.fontSize = Math.max(11, Math.min(30, size));
  document.documentElement.style.setProperty('--fs', `${note.fontSize}px`);
  window.sticky.update({ fontSize: note.fontSize });
}

function setPinned(on) {
  note.alwaysOnTop = on;
  pin.classList.toggle('on', on);
  window.sticky.update({ alwaysOnTop: on });
}

// Keeps the toolbar up whenever this note is the focused window. The title bar
// is a drag region and swallows mouse events, so CSS :hover alone would hide
// the controls just as the cursor reached them.
function setFocused(on) {
  document.body.classList.toggle('focused', on);
}
window.addEventListener('focus', () => setFocused(true));
window.addEventListener('blur', () => setFocused(false));
setFocused(document.hasFocus());

/* ---------- images ---------- */

/**
 * Screenshots the whole note to the clipboard.
 *
 * Snapshot mode renders every element as a reader would see it, including the
 * one the caret happens to sit in -- a picture of a note should not show its
 * markdown. The toolbar is hidden for the same reason, and the content height
 * is measured so a scrolled note is not captured half-missing.
 */
async function copyNoteAsImage() {
  // The picture is taken in a separate offscreen window, so this one is left
  // exactly as it was -- no resize, no flicker, no toolbar to hide.
  await window.sticky.copyNote({ width: window.innerWidth });
}

window.sticky.on('copy-note-image', copyNoteAsImage);
window.sticky.on('find-in-note', () => view && openSearchPanel(view));

/**
 * Describe some maths in words, get LaTeX.
 *
 * Takes the selection when there is one -- select "integral of x squared",
 * press the shortcut, and it becomes the maths. Otherwise it asks.
 */
window.sticky.on('describe-latex', async () => {
  if (!view) return;
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to).trim();
  const description = selected || window.prompt('Describe the maths:');
  if (!description) return;

  const { latex, error } = await window.sticky.ai.toLatex({ text: description });
  if (error || !latex) {
    window.alert(error === 'ollama-unreachable'
      ? 'Ollama is not running. Start it, or turn on Note > Autocomplete for setup help.'
      : 'No LaTeX came back. Try describing it differently.');
    return;
  }

  // Multi-line maths belongs on its own line; a short expression sits inline.
  const display = latex.includes('\n') || latex.includes('\\begin');
  const wrapped = display ? `$$\n${latex}\n$$` : `$${latex}$`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: wrapped },
    selection: { anchor: sel.from + wrapped.length },
  });
});

// The file changed underneath us -- another editor, Dropbox, a git checkout.
// Replace the text but keep the caret where it was, so a sync landing while
// you are typing does not throw you back to the top of the note.
/**
 * Applies an edit that happened outside this window.
 *
 * As a splice of the part that actually differs, not a replacement of the
 * whole document. Replacing everything maps every position to the end of the
 * insertion, so the caret jumps, the selection is lost and the undo history
 * becomes one opaque blob -- CodeMirror maps positions through a change set
 * for you, but only if the change describes what really changed.
 *
 * Common prefix and suffix is enough here: an outside edit is nearly always
 * one contiguous region, and it costs no dependency.
 */
function applyExternal(body) {
  const doc = view.state.doc.toString();
  if (body === doc) return;

  let start = 0;
  const max = Math.min(doc.length, body.length);
  while (start < max && doc[start] === body[start]) start += 1;

  let end = 0;
  while (
    end < max - start
    && doc[doc.length - 1 - end] === body[body.length - 1 - end]
  ) end += 1;

  note.body = body;
  view.dispatch({
    changes: { from: start, to: doc.length - end, insert: body.slice(start, body.length - end) },
  });
}

window.sticky.on('note-changed', (body) => {
  if (!view) return;
  applyExternal(body);
});

/**
 * The file changed while this note had edits that were not saved yet.
 *
 * Nothing is overwritten: the two versions are offered as a choice, because
 * only the person typing knows which one they want. Silently reloading over
 * unsaved input is the one thing every editor of this kind refuses to do.
 */
window.sticky.on('note-conflict', (body) => {
  if (!view) return;
  showConflict(body);
});

const conflict = document.getElementById('conflict');

function showConflict(body) {
  conflict.hidden = false;
  conflict.querySelector('.reload').onclick = () => {
    applyExternal(body);
    saveNow();
    conflict.hidden = true;
  };
  conflict.querySelector('.mine').onclick = () => {
    // Writing our copy over theirs is what makes this stick: the next save
    // carries it, and the file stops disagreeing.
    note.body = view.state.doc.toString();
    saveNow();
    conflict.hidden = true;
  };
}

// Right-click a rendered equation to copy it as an image or as LaTeX.
host.addEventListener('contextmenu', async (e) => {
  const slot = e.target.closest('[data-tex]');
  e.preventDefault();

  if (!slot) {
    window.sticky.mathMenu({}); // still offers the whole-note capture
    return;
  }

  // The note's paper colour has no business in an image headed for Slack, so
  // the equation gets a plain card for the moment of capture. Two frames,
  // because the rectangle has to be measured after the padding lands.
  slot.classList.add('capturing');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const box = slot.getBoundingClientRect();
  try {
    await window.sticky.mathMenu({
      tex: slot.dataset.tex,
      rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    });
  } finally {
    slot.classList.remove('capturing');
  }
});

// Links open in the real browser rather than navigating the sticky itself.
host.addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  window.sticky.openExternal(link.href);
});

/* ---------- toolbar ---------- */

const swatches = document.getElementById('swatches');
COLORS.forEach((color) => {
  const el = document.createElement('span');
  el.dataset.color = color;
  el.style.background = SWATCH[color];
  el.title = color;
  el.addEventListener('click', () => setColor(color));
  swatches.appendChild(el);
});

const menuButton = document.getElementById('menu');
menuButton.addEventListener('click', () => window.sticky.openAppMenu());
// Space and Enter reach a <button> natively, but only if it can be focused,
// and the toolbar is inside a drag region that swallows plain clicks.
menuButton.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    window.sticky.openAppMenu();
  }
});

document.getElementById('add').addEventListener('click', () => window.sticky.create());
document.getElementById('close').addEventListener('click', () => window.sticky.close());
pin.addEventListener('click', () => {
  const next = !note.alwaysOnTop;
  window.sticky.setAlwaysOnTop(next);
  setPinned(next);
});

window.sticky.on('font-size', (delta) => setFontSize(note.fontSize + delta));
window.sticky.on('always-on-top-changed', (v) => setPinned(v));

/* ---------- start ---------- */

window.sticky.get().then((loaded) => {
  note = loaded || { body: '', color: 'yellow', fontSize: 15, alwaysOnTop: false };
  setColor(note.color);
  setFontSize(note.fontSize || 15);
  setPinned(!!note.alwaysOnTop);

  view = createLiveEditor({
    parent: host,
    doc: note.body,
    onChange: (text) => {
      note.body = text;
      scheduleSave();
    },
  });

  // In the offscreen window used to photograph the note, render everything as
  // a reader sees it, measure how tall that is, and let the main process take
  // it from there. No caret, no focus, nothing unfolded.
  if (window.sticky.isSnapshot) {
    document.body.classList.add('capturing-note');
    // Left on for good: this window exists only to be photographed.
    setSnapshotMode(view, true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const bar = document.getElementById('bar');
      window.sticky.snapshotReady(bar.offsetHeight + host.scrollHeight + 8);
    }));
    return;
  }

  // Autocomplete is optional and off unless Ollama is answering, so this may
  // simply resolve to disabled.
  refreshGhostSettings();
  window.sticky.on('ai-settings-changed', refreshGhostSettings);

  // Caret at the end, not the start. At position 0 the caret sits inside the
  // heading, which unfolds it -- so every note would open showing "# " before
  // its title.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  view.focus();
});
