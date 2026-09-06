#!/usr/bin/env node
/**
 * Boots the app against a notes folder it is not allowed to read.
 *
 * macOS can refuse Documents outright -- permission is tied to the app's
 * signature, so a rebuilt copy starts with none -- and the app used to fail
 * that read, restore nothing and open no window, which looks exactly like a
 * launch that crashed. A denied folder must say so.
 *
 * Quit the app first, as with smoke.js: the single-instance lock makes a
 * second launch exit immediately, which would read as a silent failure here.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'win32') {
  console.log('SKIP  a folder cannot be made unreadable this way on Windows');
  process.exit(0);
}
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('SKIP  root reads a folder whatever its mode says');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denied-check-'));
fs.chmodSync(dir, 0o000);

const args = process.platform === 'linux'
  ? [ROOT, '--no-sandbox']
  : [ROOT];
const child = spawn(electronPath, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LATEX_STICKIES_NOTES_DIR: dir },
});

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const done = (ok, why) => {
  clearTimeout(timer);
  try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${why}`);
  if (!ok) console.error(out.slice(-600));
  process.exit(ok ? 0 : 1);
};

// The dialog blocks, so waiting for the process to exit would wait for ever.
const timer = setTimeout(
  () => done(false, 'a refused notes folder was never reported'),
  25000
);

child.on('exit', (code) => {
  if (!/notes folder refused/.test(out)) {
    done(false, `the app exited (code ${code}) without reporting the refusal`
      + ' -- is another copy already running?');
  }
});

const poll = setInterval(() => {
  if (/notes folder refused: (EPERM|EACCES)/.test(out)) {
    clearInterval(poll);
    done(true, 'a refused notes folder is reported, not swallowed');
  }
}, 200);
