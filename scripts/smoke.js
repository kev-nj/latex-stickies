#!/usr/bin/env node
/**
 * Boots the real app and checks it is still alive a few seconds later.
 *
 * The unit suites cover the pure logic, but they never start Electron. This is
 * the check that the app actually opens a window on a machine that is not the
 * author's -- the whole point of running it on Windows and Linux, where nobody
 * has ever launched it.
 *
 * "Still running after N seconds" is a deliberately low bar, and the right one:
 * almost every way this breaks on a new platform (a missing module, a bad path,
 * an API that does not exist there) shows up as an immediate crash, and the
 * stderr is captured and printed when it does.
 *
 *   node scripts/smoke.js            # boot the app in this repo
 *   node scripts/smoke.js --package  # boot the installed latex-stickies
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ALIVE_MS = 12000;
const usePackage = process.argv.includes('--package');

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

const args = [appDir];
// CI containers run as root without a usable sandbox; this is a test harness,
// not how end users launch the app.
if (process.platform === 'linux') args.push('--no-sandbox');

const child = spawn(electronPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });

let exitedEarly = null;
child.on('exit', (code, signal) => { exitedEarly = { code, signal }; });
child.on('error', (err) => {
  console.error(`failed to spawn Electron: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  if (exitedEarly) {
    console.error(
      `\nFAIL  app exited after ${ALIVE_MS / 1000}s ` +
      `(code=${exitedEarly.code} signal=${exitedEarly.signal})`
    );
    process.exit(1);
  }

  // Electron spawns helper processes; kill the group so none are left behind.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }

  if (/Error:|Uncaught|Cannot find module/i.test(out)) {
    console.error('\nFAIL  app started but reported errors (see output above)');
    process.exit(1);
  }

  console.log(`\nPASS  app stayed up for ${ALIVE_MS / 1000}s with no errors`);
  process.exit(0);
}, ALIVE_MS);
