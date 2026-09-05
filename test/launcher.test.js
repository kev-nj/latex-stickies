// The launcher's promise: if it says the app is running, the app is running.
//
// It used to print that the moment it had spawned something, with the output
// discarded, so a runtime that started and died a moment later reported
// success and left nothing to read. That is the failure this covers.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const checks = [];
const check = (name, ok) => checks.push([name, ok]);

/**
 * Runs the launcher against a stand-in for Electron.
 *
 * Its own app-support directory and its own home, so branding a copy of the
 * shell cannot touch the real one -- a first attempt at this wiped the branded
 * bundle on the machine it ran on.
 */
function launchWith(script) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  const stub = path.join(base, 'node_modules', 'electron');
  fs.mkdirSync(stub, { recursive: true });

  const binary = path.join(stub, 'stub-electron');
  fs.writeFileSync(binary, script);
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(path.join(stub, 'index.js'),
    `module.exports = ${JSON.stringify(binary)};`);
  fs.writeFileSync(path.join(stub, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }));

  for (const dir of ['bin', 'scripts', 'src']) {
    fs.cpSync(path.join(ROOT, dir), path.join(base, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(base, 'package.json'));

  const result = spawnSync(process.execPath, [path.join(base, 'bin', 'latex-stickies.js')], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      LATEX_STICKIES_APP_DIR: path.join(base, 'app'),
      HOME: base,
      XDG_STATE_HOME: path.join(base, 'state'),
      LOCALAPPDATA: path.join(base, 'local'),
    },
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return { result, output, base };
}

/* ---------- a runtime that dies on startup ---------- */

{
  const { result, output, base } = launchWith(
    '#!/bin/sh\necho "dyld: Library not loaded: libfoo.dylib" >&2\nexit 127\n'
  );
  check('a launch that dies immediately is reported', /exited immediately/.test(output));
  check('the exit code is named', /code=127/.test(output));
  check('the launcher does not claim success', !/is running/.test(output));
  check('it exits non-zero', result.status !== 0);
  // The reason a user needs is in the runtime's own output, which used to go
  // nowhere at all.
  check('the log tail explains why', /Library not loaded/.test(output));
  check('the log path is given', /Full log: .*launch\.log/.test(output));
  fs.rmSync(base, { recursive: true, force: true });
}

/* ---------- a runtime that stays up ---------- */

{
  const started = Date.now();
  const { result, output, base } = launchWith('#!/bin/sh\nsleep 30\n');
  const elapsed = Date.now() - started;

  check('a launch that survives is reported as running', /is running/.test(output));
  check('a good launch exits zero', result.status === 0);
  // The point of holding the child is to watch it, not to wait on it: the
  // terminal must come back rather than hang for the life of the app.
  check('the launcher returns rather than waiting for the app', elapsed < 15000);

  // Nothing may hold the parent open once it has let go -- an un-unref'd timer
  // would keep it alive to the end of the startup window and beyond.
  check('the parent does not linger', elapsed < 10000);

  try {
    execFileSync('pkill', ['-f', path.join(base, 'node_modules', 'electron', 'stub-electron')]);
  } catch (_) { /* already gone */ }
  fs.rmSync(base, { recursive: true, force: true });
}

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} failing` : `\nall ${checks.length} passing`);
process.exit(bad ? 1 : 0);
