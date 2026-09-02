const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'notes.json');

// A kill between the temp write and the rename strands a .tmp file. They are
// never read, so clear any from previous runs rather than letting them pile up.
function sweepTempFiles() {
  const dir = path.dirname(FILE);
  const prefix = `${path.basename(FILE)}.`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
      }
    }
  } catch (_) {}
}

function load() {
  sweepTempFiles();
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (_) {
    return []; // no file yet: first run
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.notes)) throw new Error('missing notes array');

    // A note without an id, or sharing one, would be treated as already-open
    // and never get a window -- present in the file but unreachable. Drop the
    // duplicates rather than silently hiding them.
    const seen = new Set();
    return data.notes.filter((note) => {
      if (!note || typeof note.id !== 'string' || seen.has(note.id)) return false;
      seen.add(note.id);
      return true;
    });
  } catch (err) {
    // The file exists but is unreadable. Never silently start empty and then
    // overwrite it -- keep the damaged copy so the notes can be recovered.
    const backup = `${FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(FILE, backup);
      console.error(`notes.json unreadable (${err.message}); kept copy at ${backup}`);
    } catch (copyErr) {
      console.error('notes.json unreadable and could not be backed up', copyErr);
    }
    return [];
  }
}

let notes = null;
let timer = null;

function all() {
  if (notes === null) notes = load();
  return notes;
}

function get(id) {
  return all().find((n) => n.id === id) || null;
}

// Write to a sibling temp file and rename over the target. rename() is atomic,
// so a crash or a kill mid-save leaves the previous good file intact instead of
// a truncated (or empty) one -- writeFileSync truncates in place and can lose
// every note if the process dies at the wrong moment.
function flush() {
  timer = null;
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const payload = JSON.stringify({ notes: all() }, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd); // durable on disk before the rename makes it live
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('failed to save notes', err);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Writes are frequent (every keystroke, every window drag), so coalesce them.
function save() {
  if (timer) return;
  timer = setTimeout(flush, 400);
}

function upsert(note) {
  const list = all();
  const i = list.findIndex((n) => n.id === note.id);
  if (i === -1) list.push(note);
  else list[i] = { ...list[i], ...note };
  save();
}

function remove(id) {
  notes = all().filter((n) => n.id !== id);
  save();
}

function saveNow() {
  if (timer) clearTimeout(timer);
  flush();
}

module.exports = { all, get, upsert, remove, saveNow };
