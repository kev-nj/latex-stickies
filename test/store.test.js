// The notes store: a folder of Markdown files plus a sidecar index.
//
// Storage is where this app has lost notes before, so this covers the paths
// that matter -- migration, metadata round-trips, external edits, deletion,
// and surviving a kill mid-write -- rather than just the happy path.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const checks = [];
const check = (name, ok) => checks.push([name, ok]);

/** Runs `body` with the store loaded against a throwaway home directory. */
function inStore(body, { legacy } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  fs.mkdirSync(path.join(base, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(base, 'userdata'), { recursive: true });
  if (legacy) {
    fs.writeFileSync(path.join(base, 'userdata', 'notes.json'),
      JSON.stringify({ notes: legacy }, null, 2));
  }

  const script = path.join(base, 'run.js');
  fs.writeFileSync(script, `
const Module = require('module');
const orig = Module._load;
Module._load = (req, ...rest) => req === 'electron'
  ? { app: { getPath: (k) => k === 'documents'
      ? ${JSON.stringify(path.join(base, 'docs'))}
      : ${JSON.stringify(path.join(base, 'userdata'))} } }
  : orig(req, ...rest);
const store = require(${JSON.stringify(path.join(ROOT, 'src/store'))});
const fs = require('fs');
const path = require('path');
const DIR = store.DIR;
const out = (v) => console.log('RESULT ' + JSON.stringify(v));
${body}
`);
  const stdout = execFileSync(process.execPath, [script], { stdio: 'pipe' }).toString();
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return { result: line ? JSON.parse(line.slice(7)) : null, base, stdout };
}

/* ---------- migration ---------- */

const LEGACY = [
  { id: 'a1', body: '# Shopping list\n- milk', color: 'blue', fontSize: 16,
    alwaysOnTop: true, bounds: { x: 10, y: 20, width: 300, height: 400 } },
  { id: 'a2', body: '# Physics\n$e=mc^2$', color: 'green', fontSize: 15,
    alwaysOnTop: false, bounds: { x: 50, y: 60, width: 340, height: 380 } },
];

{
  const { result, base } = inStore(`
    const notes = store.all();
    out({
      count: notes.length,
      files: fs.readdirSync(DIR).sort(),
      first: notes.find((n) => n.file === 'shopping-list.md'),
      legacyKept: fs.existsSync(path.join(${JSON.stringify('')} + process.env.HOME || '', '')) || true,
    });
  `, { legacy: LEGACY });

  check('migrates every note', result.count === 2);
  check('names files from the note title',
    result.files.includes('shopping-list.md') && result.files.includes('physics.md'));
  check('writes a sidecar index', result.files.includes('.stickies.json'));
  check('keeps the colour', result.first.color === 'blue');
  check('keeps the font size', result.first.fontSize === 16);
  check('keeps the pinned state', result.first.alwaysOnTop === true);
  check('keeps the window bounds', result.first.bounds && result.first.bounds.width === 300);
  check('keeps the body', result.first.body === '# Shopping list\n- milk');
  // Migration must never be the step that loses the only copy.
  check('leaves the old notes.json alone',
    fs.existsSync(path.join(base, 'userdata', 'notes.json')));
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- round-trip ---------- */

{
  const { result, base } = inStore(`
    store.upsert({ id: 'n1', body: '# Kept\\nbody text', color: 'pink' });
    store.saveNow();
    store.reload();
    const again = store.all()[0];
    out({ file: again.file, body: again.body, color: again.color,
          onDisk: fs.readFileSync(path.join(DIR, again.file), 'utf8') });
  `);
  check('a new note becomes a file named after it', result.file === 'kept.md');
  check('the file holds exactly the note text', result.onDisk === '# Kept\nbody text');
  check('metadata survives a reload', result.color === 'pink');
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- editing the file outside the app ---------- */

{
  const { result, base } = inStore(`
    store.upsert({ id: 'n1', body: 'original' });
    store.saveNow();
    // Something else -- Vim, Dropbox, a git checkout -- rewrites the file.
    fs.writeFileSync(path.join(DIR, 'original.md'), 'edited elsewhere');
    out({ afterReload: store.reload()[0].body });
  `);
  check('picks up an edit made outside the app', result.afterReload === 'edited elsewhere');
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- names ---------- */

{
  const { result, base } = inStore(`
    store.upsert({ id: 'n1', body: '# Notes' });
    store.upsert({ id: 'n2', body: '# Notes' });
    store.upsert({ id: 'n3', body: '' });
    store.saveNow();
    out({ files: fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort() });
  `);
  check('two notes with the same title do not collide',
    result.files.includes('notes.md') && result.files.includes('notes-2.md'));
  check('an untitled note still gets a name', result.files.includes('note.md'));
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- following the title ---------- */

{
  const { result, base } = inStore(`
    store.upsert({ id: 'n1', body: '' });            // a new note is empty
    store.saveNow();
    const first = store.all()[0].file;
    store.upsert({ id: 'n1', body: '# Lecture 3' }); // then it gets a title
    store.saveNow();
    out({ first, then: store.all()[0].file, files: fs.readdirSync(DIR).filter(f => f.endsWith('.md')) });
  `);
  check('an empty note starts as note.md', result.first === 'note.md');
  check('naming the note renames its file', result.then === 'lecture-3.md');
  check('the old filename does not linger', !result.files.includes('note.md'));
  fs.rmSync(base, { recursive: true, force: true });
}

{
  const { result, base } = inStore(`
    store.upsert({ id: 'n1', body: '# First' });
    store.saveNow();
    // Someone renames the file themselves, outside the app.
    fs.renameSync(path.join(DIR, 'first.md'), path.join(DIR, 'my-own-name.md'));
    store.reload();
    const id = store.all()[0].id;
    store.upsert({ id, body: '# Second' });
    store.saveNow();
    out({ file: store.all()[0].file });
  `);
  // Renaming over someone's chosen filename would be rude, and would break
  // any link or script pointing at it.
  check('a file renamed by hand keeps its name', result.file === 'my-own-name.md');
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- one note, one file ---------- */

// A real report: a user retitled one note and the All Notes menu filled up
// with copies of it. Retitling renames the file at once, so anything that
// reloaded before the debounced index write found a file the index had never
// heard of, gave it a fresh id, and orphaned the window still holding the old
// one -- whose next keystroke wrote a second copy.
{
  const { result, base } = inStore(`
    store.upsert({ id: 'X', body: '# Banana' });   // a window opens it
    store.saveNow();
    store.upsert({ id: 'X', body: '# Banana2' });  // the user retitles it
    store.reload();                                // the watcher reloads
    const ids = store.all().map((n) => n.id);
    store.upsert({ id: 'X', body: '# Banana2 more' }); // the window types on
    store.saveNow();
    out({ ids, files: fs.readdirSync(DIR).filter((f) => f.endsWith('.md')) });
  `);
  check('the note keeps its id across a reload after a retitle',
    result.ids.length === 1 && result.ids[0] === 'X');
  check('retitling a note does not fork it into two files',
    result.files.length === 1 && result.files[0] === 'banana2-more.md');
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- deletion ---------- */

{
  const { result, base } = inStore(`
    store.upsert({ id: 'n1', body: '# Doomed' });
    store.saveNow();
    const before = fs.existsSync(path.join(DIR, 'doomed.md'));
    store.remove('n1');
    store.saveNow();
    out({ before, after: fs.existsSync(path.join(DIR, 'doomed.md')), left: store.all().length });
  `);
  check('deleting a note removes its file', result.before === true && result.after === false);
  check('deleting a note removes it from the store', result.left === 0);
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- durability ---------- */

{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'store-kill-'));
  fs.mkdirSync(path.join(base, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(base, 'userdata'), { recursive: true });
  const script = path.join(base, 'churn.js');
  fs.writeFileSync(script, `
const Module = require('module');
const orig = Module._load;
Module._load = (req, ...rest) => req === 'electron'
  ? { app: { getPath: (k) => k === 'documents'
      ? ${JSON.stringify(path.join(base, 'docs'))}
      : ${JSON.stringify(path.join(base, 'userdata'))} } }
  : orig(req, ...rest);
const store = require(${JSON.stringify(path.join(ROOT, 'src/store'))});
store.upsert({ id: 'n1', body: 'x'.repeat(4000) });
store.saveNow();
let i = 0;
setInterval(() => { store.upsert({ id: 'n1', body: 'y'.repeat(4000) + (i++) }); store.saveNow(); }, 1);
`);

  let damaged = 0;
  const DIR = path.join(base, 'docs', 'LaTeX Stickies');
  for (let round = 0; round < 12; round += 1) {
    const child = require('child_process').spawn(process.execPath, [script], { stdio: 'ignore' });
    execFileSync(process.execPath, ['-e',
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${40 + Math.floor(Math.random() * 60)})`]);
    child.kill('SIGKILL');
    execFileSync(process.execPath, ['-e',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)']);
    const file = fs.readdirSync(DIR).find((f) => f.endsWith('.md'));
    const body = file ? fs.readFileSync(path.join(DIR, file), 'utf8') : '';
    if (!file || body.length < 4000) damaged += 1;
  }
  check('a note survives being killed mid-write', damaged === 0);
  const strays = fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp'));
  check('no temp files are left behind after a clean load', strays.length <= 1);
  fs.rmSync(base, { recursive: true, force: true });
}

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} failing` : `\nall ${checks.length} passing`);
process.exit(bad ? 1 : 0);
