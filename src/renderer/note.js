const COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'];
const SWATCH = {
  yellow: '#fdf3a8', blue: '#cfe6fb', green: '#d3f2c8',
  pink: '#fbd2e2', purple: '#e2d6fb', gray: '#e6e6e6',
};

const host = document.getElementById('host');
const pin = document.getElementById('pin');

let note = null;
let view = null;

/* ---------- state ---------- */

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.sticky.update({ body: note.body }), 250);
}

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
  document.body.classList.add('capturing-note');
  try {
    await withSnapshot(view, async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bar = document.getElementById('bar');
      const contentHeight = bar.offsetHeight + host.scrollHeight;
      await window.sticky.copyNote({ contentHeight });
    });
  } finally {
    document.body.classList.remove('capturing-note');
  }
}

window.sticky.on('copy-note-image', copyNoteAsImage);

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

document.getElementById('add').addEventListener('click', () => window.sticky.create());
document.getElementById('close').addEventListener('click', () => window.sticky.close());
pin.addEventListener('click', () => {
  const next = !note.alwaysOnTop;
  window.sticky.setAlwaysOnTop(next);
  setPinned(next);
});

window.sticky.on('font-size', (delta) => setFontSize(note.fontSize + delta));
window.sticky.on('always-on-top-changed', (v) => setPinned(v));
window.sticky.on('request-delete', () => {
  if (!note.body.trim() || confirm('Delete this note? This cannot be undone.')) {
    window.sticky.remove();
  }
});
// Kept for the menu item, though there are no longer two modes to toggle.
window.sticky.on('toggle-edit', () => view && view.focus());

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

  // Caret at the end, not the start. At position 0 the caret sits inside the
  // heading, which unfolds it -- so every note would open showing "# " before
  // its title.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  view.focus();
});
