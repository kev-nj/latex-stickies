#!/usr/bin/env node
/**
 * Boots the real app and checks it behaves, on whatever platform CI is running.
 *
 * The unit suites cover the pure logic but never start Electron, so everything
 * platform-shaped lives here.
 *
 *   node scripts/smoke.js              boot and stay up
 *   node scripts/smoke.js --package    boot the installed latex-stickies
 *   node scripts/smoke.js --lifecycle  close every note, check what happens next
 *
 * The lifecycle mode exists because of a real bug: closing the last note on
 * Windows left the process running with no window and no way to reach it, and
 * relaunching handed off to that instance and appeared to do nothing. A boot
 * test cannot see that -- it never closes a window. The app cooperates through
 * LATEX_STICKIES_SMOKE_CLOSE_MS, which is inert unless set.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALIVE_MS = 12000;
const CLOSE_AFTER_MS = 6000;
const GRACE_MS = 8000;

const usePackage = process.argv.includes('--package');
const lifecycle = process.argv.includes('--lifecycle');
const isMac = process.platform === 'darwin';

// Isolated home directories: the lifecycle run opens and closes real note
// windows, and must never migrate, rewrite or delete anyone's actual notes.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-home-'));
fs.mkdirSync(path.join(sandbox, 'Documents'), { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

let appDir;
let electronPath;
try {
  appDir = usePackage
    ? path.dirname(require.resolve('latex-stickies/package.json'))
    : path.join(__dirname, '..');
  // Resolve Electron from the app's own tree, so --package really exercises
  // what a user installed rather than this checkout's copy.
  electronPath = require(require.resolve('electron', { paths: [appDir] }));
} catch (err) {
  console.error('could not resolve the app or its Electron runtime:', err.message);
  process.exit(1);
}

console.log(`booting  ${appDir}`);
console.log(`electron ${electronPath}`);
console.log(`mode     ${lifecycle ? 'lifecycle' : 'boot'}`);

// CI containers run as root without a usable sandbox; this is a test harness,
// not how end users launch the app.
const args = process.platform === 'linux' ? [appDir, '--no-sandbox'] : [appDir];

// Chromium is noisy on a headless runner -- D-Bus, GPU and font warnings are
// printed on every Linux boot and say nothing about whether the app works.
// Only match what actually means the app failed.
const FATAL = [
  /Cannot find module/i,
  /A JavaScript error occurred in the main process/i,
  /Uncaught (Exception|TypeError|ReferenceError|SyntaxError)/i,
  /^\s*at .*[\\/]src[\\/].*\.js/m, // a stack trace through our own code
];

function launch(env = {}) {
  const child = spawn(electronPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, ...env },
  });
  child.unref?.();
  const state = { out: '', exited: null, child };
  const record = (d) => { state.out += d; process.stdout.write(d); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.on('exit', (code, signal) => { state.exited = { code, signal }; });
  child.on('error', (err) => {
    console.error(`failed to spawn Electron: ${err.message}`);
    process.exit(1);
  });
  return state;
}

function kill(child) {
  // Electron spawns helper processes; take the tree so none are left behind.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Is that pid still around? Signal 0 tests without sending anything. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/** Resolves true as soon as `test` passes, false if `ms` elapses first. */
async function until(test, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test()) return true;
    await wait(250);
  }
  return false;
}

function fail(message, state) {
  console.error(`\nFAIL  ${message}`);
  if (state && state.child && !state.exited) kill(state.child);
  process.exit(1);
}

function checkFatal(state) {
  const hit = FATAL.find((re) => re.test(state.out));
  if (hit) fail(`app reported a fatal error (matched ${hit})`, state);
}

/** Window count from the most recent SMOKE line the app printed. */
function windowCount(out) {
  const seen = [...out.matchAll(/SMOKE windows=(\d+)/g)];
  return seen.length ? Number(seen[seen.length - 1][1]) : null;
}

async function bootMode() {
  const app = launch();
  await wait(ALIVE_MS);
  if (app.exited) {
    fail(
      `app exited after ${ALIVE_MS / 1000}s ` +
      `(code=${app.exited.code} signal=${app.exited.signal})`,
      app
    );
  }
  kill(app.child);
  checkFatal(app);
  console.log(`\nPASS  app stayed up for ${ALIVE_MS / 1000}s with no errors`);
}

async function lifecycleMode() {
  const app = launch({ LATEX_STICKIES_SMOKE_CLOSE_MS: String(CLOSE_AFTER_MS) });

  if (!(await until(() => windowCount(app.out) > 0, 30000))) {
    fail('app never opened a note window', app);
  }
  if (!(await until(() => windowCount(app.out) === 0, 30000))) {
    fail('notes never closed -- the test hook did not fire', app);
  }
  console.log('\n--- every note closed; checking what the app does next');

  if (!isMac) {
    // No Dock and no activate event: an app with no windows is unreachable
    // here, so it has to quit rather than linger invisibly.
    if (!(await until(() => app.exited, GRACE_MS))) {
      fail(
        'app kept running with no windows open. On this platform there is no ' +
        'way back to it, and the next launch would hand off to this instance ' +
        'and appear to do nothing. An open handle -- the notes-folder watcher ' +
        'is the usual culprit -- keeps the event loop alive.',
        app
      );
    }
    // Electron spawns helpers; none of them should outlive the app either.
    const stragglers = await until(
      () => !isProcessAlive(app.child.pid), GRACE_MS);
    if (!stragglers) fail('the main process is still alive after exiting', app);

    checkFatal(app);
    console.log(`\nPASS  app quit after its last note closed (code=${app.exited.code})`);
    return;
  }

  // macOS keeps the app alive on purpose -- the Dock icon is the way back.
  await wait(GRACE_MS);
  if (app.exited) {
    fail('app quit when its last note closed; on macOS it should stay running', app);
  }

  // ...and a second launch must reopen the notes rather than hand off to an
  // instance that shows nothing.
  console.log('--- relaunching; the running instance should reopen its notes');
  const second = launch();
  const reopened = await until(() => windowCount(app.out) > 0, 20000);
  if (!second.exited) kill(second.child);
  if (!reopened) {
    fail('a second launch reopened no note -- the app is unreachable', app);
  }

  kill(app.child);
  checkFatal(app);
  console.log('\nPASS  app stayed up with no windows, and relaunching reopened its notes');
}

(lifecycle ? lifecycleMode() : bootMode()).catch((err) => {
  console.error(err);
  process.exit(1);
});
