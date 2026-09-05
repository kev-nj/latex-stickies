/**
 * Notes on disk: one Markdown file per note, in a folder you can open.
 *
 *   ~/Documents/LaTeX Stickies/shopping-list.md
 *   ~/Documents/LaTeX Stickies/.stickies.json
 *
 * The point of a folder over a single JSON blob is that the notes stop being
 * trapped in this app: they are greppable, git-versionable, syncable through
 * Dropbox, and editable in any other editor.
 *
 * Metadata -- colour, window bounds, pinned state -- lives in the sidecar
 * index rather than in frontmatter, so the note files stay clean. A .tex file
 * with YAML at the top does not compile, which would defeat writing .tex at
 * all.
 *
 * Writes are atomic: temp file, fsync, rename. A crash or force quit leaves
 * the previous file intact rather than a truncated one.
 */
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Where the notes live.
 *
 * The override exists for harnesses. On macOS Electron resolves the documents
 * folder through the OS rather than $HOME, so a test that redirects HOME still
 * reads and writes the real notes -- which is how a verification run ended up
 * touching them.
 */
const DIR = process.env.LATEX_STICKIES_NOTES_DIR
  || path.join(app.getPath('documents'), 'LaTeX Stickies');
const INDEX = path.join(DIR, '.stickies.json');
/** The old single-file store, migrated from once and then left alone. */
const LEGACY = path.join(app.getPath('userData'), 'notes.json');

const DEFAULTS = { color: 'yellow', fontSize: 15, alwaysOnTop: false, open: true };

let notes = null; // [{ id, file, body, color, fontSize, alwaysOnTop, bounds }]
let timer = null;

/* ---------- names ---------- */

/** The stem of a filename, from a note's first line. */
function slugBase(body) {
  const first = (body || '').split('\n').find((l) => l.trim()) || '';
  return first
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'note';
}

/** A filename a person would recognise, taken from the note's first line. */
function slugFor(body, taken, ext = '.md') {
  const base = slugBase(body);
  let name = `${base}${ext}`;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}-${n}${ext}`;
    n += 1;
  }
  return name;
}

/** Was this file named by us, from that body, rather than by a person? */
function autoNamed(file, body) {
  const base = slugBase(body);
  const ext = path.extname(file);
  return file === `${base}${ext}` || new RegExp(`^${base}-\\d+$`).test(path.basename(file, ext));
}

/* ---------- reading ---------- */

function readIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    return data && typeof data === 'object' ? data.notes || {} : {};
  } catch (_) {
    return {};
  }
}

function load() {
  fs.mkdirSync(DIR, { recursive: true });
  sweepTempFiles();
  migrateLegacy();

  const meta = readIndex();
  const files = fs.readdirSync(DIR)
    .filter((f) => /\.(md|tex|txt)$/i.test(f) && !f.startsWith('.'))
    .sort();

  return files.map((file) => {
    const saved = meta[file] || {};
    let body = '';
    try {
      body = fs.readFileSync(path.join(DIR, file), 'utf8');
    } catch (_) { /* unreadable file: show it empty rather than vanish */ }
    seen.set(file, digest(body));
    return {
      ...DEFAULTS,
      ...saved,
      // The file is the source of truth for content; the index only decorates.
      id: saved.id || file,
      // A file that appeared in the folder from outside has no index entry,
      // and should show itself rather than stay invisible.
      open: saved.open !== false,
      file,
      body,
    };
  });
}

/**
 * Brings notes.json across the first time, and leaves it where it is.
 *
 * Deleting it would make this irreversible, and the whole history of this
 * app's storage bugs argues for keeping the old copy until the user is sure.
 */
function migrateLegacy() {
  if (fs.existsSync(INDEX) || !fs.existsSync(LEGACY)) return;

  let old;
  try {
    old = JSON.parse(fs.readFileSync(LEGACY, 'utf8')).notes;
    if (!Array.isArray(old) || !old.length) return;
  } catch (_) {
    return;
  }

  const taken = new Set(fs.readdirSync(DIR));
  const meta = {};
  for (const note of old) {
    const file = slugFor(note.body, taken);
    taken.add(file);
    try {
      writeFileAtomic(path.join(DIR, file), note.body || '');
      meta[file] = {
        id: note.id || file,
        color: note.color || DEFAULTS.color,
        fontSize: note.fontSize || DEFAULTS.fontSize,
        alwaysOnTop: !!note.alwaysOnTop,
        bounds: note.bounds,
      };
    } catch (err) {
      console.error(`could not migrate a note to ${file}`, err);
    }
  }
  writeIndex(meta);
  console.log(`migrated ${Object.keys(meta).length} notes to ${DIR}`);
}

/* ---------- writing ---------- */

function writeFileAtomic(target, contents) {
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd); // durable before the rename makes it live
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  seen.set(path.basename(target), digest(contents));
}

// A kill between the temp write and the rename strands a .tmp file.
function sweepTempFiles() {
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(DIR, name)); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* ignore */ }
}

function writeIndex(meta) {
  try {
    writeFileAtomic(INDEX, `${JSON.stringify({ notes: meta }, null, 2)}\n`);
  } catch (err) {
    console.error('failed to write the notes index', err);
  }
}

/** The sidecar index alone: filenames to ids, colours, bounds. */
function flushIndex() {
  const meta = {};
  for (const note of all()) {
    meta[note.file] = {
      id: note.id,
      color: note.color,
      fontSize: note.fontSize,
      alwaysOnTop: note.alwaysOnTop,
      bounds: note.bounds,
      open: note.open !== false,
    };
  }
  writeIndex(meta);
}

function flush() {
  timer = null;
  for (const note of all()) {
    // Only the notes that actually changed. Rewriting every note on every
    // keystroke multiplied the mtimes, the events and the chances of
    // misattributing one -- four notes turned one save into twenty events --
    // and churned any sync engine watching the folder.
    if (!isDirty(note)) continue;
    try {
      writeFileAtomic(path.join(DIR, note.file), note.body || '');
    } catch (err) {
      console.error(`failed to save ${note.file}`, err);
    }
  }
  flushIndex();
}

/** Has this note been edited since it was last written to disk? */
function isDirty(note) {
  return digest(note.body || '') !== seen.get(note.file);
}

// Writes are frequent (every keystroke, every window drag), so coalesce them.
function save() {
  if (timer) return;
  timer = setTimeout(flush, 400);
}

/* ---------- the store ---------- */

function all() {
  if (notes === null) notes = load();
  return notes;
}

function get(id) {
  return all().find((n) => n.id === id) || null;
}

function upsert(note) {
  const list = all();
  const i = list.findIndex((n) => n.id === note.id);

  if (i === -1) {
    // A patch for an id nobody has, carrying no text, is not a new note: it is
    // a stray message about one that has gone -- a window closing after its
    // note was deleted, or bounds arriving as it goes. Creating a note from it
    // resurrects what the user just deleted, empty.
    if (note.body === undefined) return;
    const taken = new Set(list.map((n) => n.file));
    list.push({ ...DEFAULTS, ...note, file: note.file || slugFor(note.body, taken) });
    save();
    return;
  }

  const before = list[i];
  list[i] = { ...before, ...note };

  // A note is created empty, so its first filename is always "note.md".
  // Follow the title once the note has one -- otherwise every note keeps a
  // meaningless name and the folder is no more readable than the old blob.
  // A file someone renamed themselves is left alone.
  const titleChanged = note.body !== undefined && slugBase(note.body) !== slugBase(before.body);
  if (titleChanged && autoNamed(before.file, before.body)) {
    const taken = new Set(list.filter((n) => n !== list[i]).map((n) => n.file));
    const next = slugFor(list[i].body, taken, path.extname(before.file) || '.md');
    try {
      const from = path.join(DIR, before.file);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(DIR, next));
      seen.delete(before.file);
      list[i].file = next;
      // Write this note's body now too. The rename is immediate but the body
      // is on the 400ms timer, so a reload in between would read the new file
      // and find the old text -- after which the filename stops following the
      // title, because it no longer looks like a name we chose.
      writeFileAtomic(path.join(DIR, next), list[i].body || '');
      // The index must follow the rename at once, not on the 400ms timer.
      // A note's id lives in the index, keyed by filename; anything that
      // reloads in the gap finds a file the index has never heard of, gives
      // it a fresh id, and orphans the window still holding the old one --
      // whose next keystroke then writes a second copy of the same note.
      flushIndex();
    } catch (err) {
      console.error(`could not rename ${before.file} to ${next}`, err);
    }
  }
  save();
}

function remove(id) {
  const note = get(id);
  if (note) {
    try {
      fs.unlinkSync(path.join(DIR, note.file));
    } catch (_) { /* already gone */ }
    // Forget what that filename held. Otherwise a later note that takes the
    // same name -- "note.md" is handed out again the moment an untitled note
    // is deleted -- is compared against the dead file's content, matches, and
    // is judged already saved. It then never reaches disk.
    seen.delete(note.file);
  }
  notes = all().filter((n) => n.id !== id);
  save();
}

function saveNow() {
  if (timer) clearTimeout(timer);
  flush();
}

/* ---------- watching the folder ---------- */

/**
 * The content we last wrote or read, per file, as a hash.
 *
 * This is how an event is attributed. A file whose bytes hash to what we last
 * put there is our own save coming back, whenever it arrives; anything else is
 * somebody else's edit. What it replaces was a 1200ms window after each write,
 * which is not what mature editors do and was wrong in both directions: a save
 * echoed back late -- measured at 2.5s when the main process stalls -- looked
 * like an outside edit and reverted the note being typed in.
 *
 * VS Code uses mtime+size for the same job and has an open issue about content
 * changing without the length changing; notes are small enough to just hash.
 */
const seen = new Map();
const digest = (text) => crypto.createHash('sha256').update(text || '').digest('hex');

/**
 * Calls back when a note file changes underneath us.
 *
 * This is the point of keeping notes as files: edit one in Vim, or let Dropbox
 * bring down a change from another machine, and the open note follows along.
 *
 * Two rules, both taken from how VS Code and Zed handle this:
 *
 *   - Only the file the event names is touched. Fanning one event out into a
 *     reload of every note is what let a change to one note revert the text
 *     being typed into another.
 *   - A note with unsaved edits is never overwritten. It is reported as a
 *     conflict instead, for the window to offer as a choice. "Do not resolve a
 *     model that is dirty" is the invariant every editor of this kind keeps.
 */
function watch(onChanged) {
  const timers = new Map();
  let watcher = null;

  const handle = (filename) => {
    timers.delete(filename);
    const full = path.join(DIR, filename);

    let body;
    try {
      body = fs.readFileSync(full, 'utf8');
    } catch (_) {
      // Deleted or moved away. The window keeps what it has: a file vanishing
      // underneath an open note is not a reason to blank it.
      seen.delete(filename);
      return;
    }

    const before = seen.get(filename);
    const now = digest(body);

    // Set LATEX_STICKIES_DEBUG_WATCH=1 to see why an event was attributed the
    // way it was. Guessing at this from the outside cost a day: the question
    // is always whether the bytes on disk are the bytes we last wrote.
    if (process.env.LATEX_STICKIES_DEBUG_WATCH) {
      const held = all().find((n) => n.file === filename);
      console.log(
        `WATCH ${filename} disk=${now.slice(0, 8)} lastWrote=${String(before).slice(0, 8)}`
        + ` memory=${digest(held ? held.body : '').slice(0, 8)}`
        + ` ours=${now === before} diskLen=${body.length}`
        + ` memLen=${held ? (held.body || '').length : -1}`
      );
    }

    if (now === before) return; // our own save, however late it arrives

    const note = all().find((n) => n.file === filename);
    if (!note) {
      // A file that appeared from outside. Added on its own rather than by
      // reloading the folder: a reload drops every note's unsaved edits on the
      // floor, so one new file would cost the words being typed in another.
      const meta = readIndex()[filename] || {};
      const added = {
        ...DEFAULTS, ...meta, id: meta.id || filename, file: filename, body,
      };
      all().push(added);
      seen.set(filename, now);
      onChanged([{ note: added, body, conflict: false }]);
      return;
    }

    // Whether the note was edited since we last wrote it has to be judged
    // against the hash from before this event, which is what our copy came
    // from -- not against the disk we have just read.
    const dirty = digest(note.body || '') !== before;
    seen.set(filename, now); // seen it now, so a repeat event says nothing new

    if (!dirty) note.body = body;
    onChanged([{ note, body, conflict: dirty }]);
  };

  try {
    watcher = fs.watch(DIR, (_event, filename) => {
      if (!filename || filename.startsWith('.') || filename.endsWith('.tmp')) return;
      if (!/\.(md|tex|txt)$/i.test(filename)) return;

      // Editors save in bursts; wait for the dust to settle, per file.
      clearTimeout(timers.get(filename));
      timers.set(filename, setTimeout(() => handle(filename), 150));
    });
  } catch (err) {
    console.error('could not watch the notes folder', err);
  }

  // Returns a cleanup function. Both handles keep the event loop alive, so a
  // watcher left open is enough to stop the process exiting after its last
  // window closes -- which on Windows leaves the app running invisibly.
  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (watcher) watcher.close();
    watcher = null;
  };
}

/** Forget everything cached, so the next read comes from disk. */
function reload() {
  notes = null;
  return all();
}

/* ---------- settings ---------- */

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SETTING_DEFAULTS = { aiEnabled: false, aiModel: '' };

function settings() {
  try {
    return { ...SETTING_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    return { ...SETTING_DEFAULTS };
  }
}

function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('failed to save settings', err);
  }
  return next;
}

module.exports = {
  all, get, upsert, remove, saveNow, reload, watch, isDirty,
  settings, saveSettings, DIR,
};
