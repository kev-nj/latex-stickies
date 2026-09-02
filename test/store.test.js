// Verify the atomic-save fix: killing the process mid-run must never leave
// notes.json empty or truncated.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
const FILE = path.join(dir, 'notes.json');

// Stub electron's app.getPath so store.js can run under plain node.
const stub = path.join(dir, 'electron.js');
fs.writeFileSync(stub, `module.exports = { app: { getPath: () => ${JSON.stringify(dir)} } };`);

const harness = path.join(dir, 'run.js');
fs.writeFileSync(harness, `
const Module = require('module');
const orig = Module._load;
Module._load = (req, ...rest) =>
  req === 'electron' ? require(${JSON.stringify(stub)}) : orig(req, ...rest);
const store = require(${JSON.stringify(path.join(ROOT, 'src/store.js'))});
const mode = process.argv[2];
if (mode === 'seed') {
  for (let i = 0; i < 200; i++) {
    store.upsert({ id: 'n' + i, body: 'x'.repeat(500), color: 'yellow' });
  }
  store.saveNow();
  console.log('seeded');
} else if (mode === 'churn') {
  // Save repeatedly forever; the parent kills us at a random moment.
  let i = 0;
  setInterval(() => {
    store.upsert({ id: 'n' + (i++ % 200), body: 'y'.repeat(500) });
    store.saveNow();
  }, 1);
}
`);

execFileSync(process.execPath, [harness, 'seed'], { stdio: 'pipe' });
const good = fs.readFileSync(FILE, 'utf8');
console.log(`seeded file: ${good.length} bytes, ${JSON.parse(good).notes.length} notes`);

let empties = 0;
let unparseable = 0;
const ROUNDS = 25;

for (let r = 0; r < ROUNDS; r++) {
  const child = require('child_process').spawn(process.execPath, [harness, 'churn'], {
    stdio: 'ignore',
  });
  // Kill at an unpredictable point so some kills land mid-write.
  const waitMs = 30 + Math.floor(Math.random() * 60);
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${waitMs})`]);
  child.kill('SIGKILL');
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25)']);

  const raw = fs.readFileSync(FILE, 'utf8');
  if (raw.length === 0) empties++;
  else {
    try {
      const n = JSON.parse(raw).notes.length;
      if (n !== 200) unparseable++;
    } catch (_) {
      unparseable++;
    }
  }
}

const strays = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
console.log(`\nafter ${ROUNDS} SIGKILLs mid-save:`);
console.log(`  empty files:        ${empties}`);
console.log(`  corrupt/truncated:  ${unparseable}`);
console.log(`  leftover tmp files: ${strays.length}`);

const pass = empties === 0 && unparseable === 0;
console.log(pass ? '\nPASS  notes survived every kill' : '\nFAIL  data loss observed');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
