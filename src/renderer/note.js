const COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'];
const SWATCH = {
  yellow: '#fdf3a8', blue: '#cfe6fb', green: '#d3f2c8',
  pink: '#fbd2e2', purple: '#e2d6fb', gray: '#e6e6e6',
};

const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const pin = document.getElementById('pin');

let note = null;

/* ---------- rendering ---------- */

// renderMarkdown() comes from markdown.js (marked + KaTeX + DOMPurify).
function render(src) {
  if (!src.trim()) {
    preview.innerHTML = '<span class="placeholder">Empty note \u2014 click to write.</span>';
    return;
  }
  renderInto(preview, src);
  decorateCodeBlocks();
}

/**
 * Adds the language label and copy button to each code block.
 *
 * This runs after the HTML is in the DOM rather than inside the markdown
 * renderer on purpose: the sanitizer still forbids <button>, so text typed into
 * a note can never fake one. These are built with createElement, so they can
 * only ever come from here.
 */
function decorateCodeBlocks() {
  preview.querySelectorAll('pre').forEach((pre) => {
    // The <pre> scrolls its own long lines, so an absolutely positioned label
    // inside it would scroll out of view. The wrapper is the anchor instead.
    const block = document.createElement('div');
    block.className = 'code-block';
    pre.parentNode.insertBefore(block, pre);
    block.appendChild(pre);

    const lang = pre.dataset.lang;
    if (lang) {
      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang;
      block.appendChild(label);
    }

    const button = document.createElement('button');
    button.className = 'code-copy';
    button.textContent = 'Copy';
    button.title = 'Copy to clipboard';
    block.appendChild(button);
  });
}

let copyResetTimer = null;

// Delegated so it keeps working across re-renders, which replace these nodes.
preview.addEventListener('mousedown', (e) => {
  // Stop the paper's own handler below from flipping the note into edit mode.
  if (e.target.closest('.code-copy')) e.stopPropagation();
}, true);

preview.addEventListener('click', (e) => {
  const button = e.target.closest('.code-copy');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();

  const code = button.closest('.code-block').querySelector('code');
  window.sticky.copy(code.textContent);

  button.textContent = 'Copied';
  button.classList.add('done');
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    button.textContent = 'Copy';
    button.classList.remove('done');
  }, 1200);
});

/* ---------- state ---------- */

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.sticky.update({ body: note.body }), 250);
}

// Typing is saved on a 250ms debounce, which Cmd+W would otherwise outrun: the
// window is closed from the main process, so the textarea never blurs and the
// pending timer dies with the renderer, losing the last few words typed.
// beforeunload is the last point where the renderer can still be heard.
window.addEventListener('beforeunload', () => {
  if (!note) return;
  clearTimeout(saveTimer);
  if (document.body.classList.contains('editing')) note.body = editor.value;
  window.sticky.flush(note.body);
});

function setEditing(on) {
  document.body.classList.toggle('editing', on);
  if (on) {
    editor.focus();
  } else {
    render(note.body);
    clearTimeout(saveTimer);
    window.sticky.update({ body: note.body });
  }
}

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

/* ---------- wiring ---------- */

const swatches = document.getElementById('swatches');
COLORS.forEach((color) => {
  const el = document.createElement('span');
  el.dataset.color = color;
  el.style.background = SWATCH[color];
  el.title = color;
  el.addEventListener('click', () => setColor(color));
  swatches.appendChild(el);
});

attachEditorBehaviors(editor);

editor.addEventListener('input', () => {
  note.body = editor.value;
  scheduleSave();
});
editor.addEventListener('blur', () => setEditing(false));

// Clicking the paper enters editing, but links and checkboxes act first.
preview.addEventListener('mousedown', (e) => {
  if (e.target.closest('a')) return;
  e.preventDefault();
  setEditing(true);
});

// Links open in the real browser rather than navigating the sticky itself.
preview.addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  window.sticky.openExternal(link.href);
});

document.getElementById('add').addEventListener('click', () => window.sticky.create());
document.getElementById('close').addEventListener('click', () => window.sticky.close());
pin.addEventListener('click', () => {
  const next = !note.alwaysOnTop;
  window.sticky.setAlwaysOnTop(next);
  setPinned(next);
});

// Keeps the toolbar up whenever this note is the focused window. The title bar
// is a drag region and swallows mouse events, so CSS :hover alone would hide
// the controls just as the cursor reached them.
function setFocused(on) {
  document.body.classList.toggle('focused', on);
}
window.addEventListener('focus', () => setFocused(true));
window.addEventListener('blur', () => setFocused(false));
setFocused(document.hasFocus());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('editing')) setEditing(false);
});

window.sticky.on('toggle-edit', () =>
  setEditing(!document.body.classList.contains('editing')));
window.sticky.on('font-size', (delta) => setFontSize(note.fontSize + delta));
window.sticky.on('always-on-top-changed', (v) => setPinned(v));
window.sticky.on('request-delete', () => {
  if (!note.body.trim() || confirm('Delete this note? This cannot be undone.')) {
    window.sticky.remove();
  }
});

window.sticky.get().then((loaded) => {
  note = loaded || { body: '', color: 'yellow', fontSize: 15, alwaysOnTop: false };
  editor.value = note.body;
  setColor(note.color);
  setFontSize(note.fontSize || 15);
  setPinned(!!note.alwaysOnTop);
  render(note.body);
  if (!note.body) setEditing(true);
});
