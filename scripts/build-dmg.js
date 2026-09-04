#!/usr/bin/env node
/**
 * Builds the macOS app with electron-builder.
 *
 * The two distribution channels want `electron` in opposite places:
 *
 *   - npm needs it in `dependencies`, or `npx latex-stickies` installs no
 *     runtime and the launcher has nothing to spawn.
 *   - electron-builder refuses to build at all while it sits there, because a
 *     packaged app already embeds its runtime and would ship a second copy.
 *
 * There is no config flag for this -- the check in app-builder-lib is
 * unconditional for `electron`. So npm wins (it is the primary channel) and
 * this script moves the entry into devDependencies just for the build, then
 * puts package.json back exactly as it was.
 *
 * The restore runs from a finally block and from the signal handlers, so an
 * interrupted build cannot leave the manifest in the swapped state.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'package.json');
const original = fs.readFileSync(MANIFEST, 'utf8');

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  fs.writeFileSync(MANIFEST, original);
}

// Ctrl+C during a two-minute build must not strand the swapped manifest.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

try {
  const pkg = JSON.parse(original);
  const version = pkg.dependencies.electron;
  if (!version) {
    console.error('electron is not in dependencies -- has package.json drifted?');
    process.exit(1);
  }

  delete pkg.dependencies.electron;
  pkg.devDependencies = { ...pkg.devDependencies, electron: version };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`);

  const args = ['electron-builder', ...process.argv.slice(2)];
  if (args.length === 1) args.push('--mac');

  const result = spawnSync('npx', args, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
  if (result.status === 0) verifySignature();
} finally {
  restore();
}

/**
 * Refuses to leave a build that macOS will call damaged.
 *
 * A .dmg shipped with a signature that did not match its contents, and the
 * only dialog a downloader got was "damaged and can't be opened" with a Move
 * to Bin button. It looked fine on the machine that built it, because
 * installing locally strips the quarantine flag that triggers the check.
 */
function verifySignature() {
  if (process.platform !== 'darwin') return;
  const app = path.join(
    __dirname, '..', 'dist', `mac-${process.arch}`, 'LaTeX Stickies.app'
  );
  if (!fs.existsSync(app)) return;

  const check = spawnSync('codesign', ['--verify', '--deep', '--strict', app], {
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    console.error(`\nthe built app is not validly signed:\n${check.stderr}`);
    console.error('macOS would call this download damaged. Not shipping it.');
    process.exitCode = 1;
    return;
  }
  console.log('  • signature verified');
}
