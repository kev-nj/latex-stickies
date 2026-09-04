#!/usr/bin/env node
/**
 * Installs the package the way a user does, and checks what they end up with.
 *
 * This exists because six releases in a row shipped a Dock name or icon that
 * was wrong on other people's machines while looking right here. Nothing
 * tested the install path: a checkout runs from source, and a built .app is
 * branded by electron-builder, so neither exercises the one thing users get --
 * a tarball unpacked into a global prefix, with npm 11 blocking its install
 * scripts, launched through bin/latex-stickies.
 *
 *   npm run verify
 *
 * macOS only; everywhere else there is nothing to brand and it exits clean.
 */
const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = 'LaTeX Stickies';
const APP_ID = 'com.kevinjusak.latexsticky';

if (process.platform !== 'darwin') {
  console.log('not macOS: nothing to verify');
  process.exit(0);
}

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-install-'));
// Its own notes directory, so a real desk full of notes is never the thing
// under test. store.js honours this; without it Electron resolves Documents
// through the OS and a redirected HOME changes nothing.
const notes = path.join(work, 'notes');
fs.mkdirSync(notes, { recursive: true });

let child = null;
process.on('exit', () => {
  if (child && !child.killed) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* gone */ }
  }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* ---------- 1. the exact tarball that would be published ---------- */

const packed = execFileSync('npm', ['pack', '--pack-destination', work], {
  cwd: ROOT, encoding: 'utf8',
}).trim().split('\n').pop();
const tarball = path.join(work, packed);

// The files allowlist has shipped a package missing a script it referenced
// before, which broke every install. Read the tarball, not the repo.
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
for (const needed of [
  'package/bin/latex-stickies.js',
  'package/scripts/brand-electron.js',
  'package/build/icon.icns',
  'package/build/icon.png',
  'package/src/main.js',
]) {
  check(`the tarball ships ${needed.replace('package/', '')}`, listing.includes(needed));
}

/* ---------- 2. install it as a user would ---------- */

const prefix = path.join(work, 'prefix');
// --ignore-scripts because npm 11 blocks install scripts for global installs
// by default. The launcher has to cope on its own.
const install = spawnSync('npm', [
  'install', '-g', '--prefix', prefix, '--cache', path.join(work, 'cache'),
  '--ignore-scripts', tarball,
], { encoding: 'utf8' });
check('the tarball installs', install.status === 0, (install.stderr || '').slice(-300));

const installed = path.join(prefix, 'lib', 'node_modules', 'latex-stickies');
const appPath = path.join(installed, 'node_modules', 'electron', 'dist', 'Electron.app');

/* ---------- 3. launch it exactly as a user would ---------- */

const launcher = path.join(prefix, 'bin', 'latex-stickies');
const run = spawnSync(launcher, [], {
  encoding: 'utf8',
  timeout: 180000, // a blocked postinstall means Electron downloads on first run
  env: { ...process.env, LATEX_STICKIES_NOTES_DIR: notes },
});
const output = `${run.stdout || ''}${run.stderr || ''}`;
// The first launch is the one that matters. It failed for a whole release --
// branding renamed the executable after the launcher had already resolved it.
check('the first launch does not error', run.status === 0 && !/Failed to launch|ENOENT/.test(output),
  output.trim().split('\n').slice(-2).join(' | '));

/* ---------- 4. what the user actually got ---------- */

const plist = path.join(appPath, 'Contents', 'Info.plist');
const read = (key) => {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
};

check('the bundle is named', read('CFBundleName') === NAME, read('CFBundleName'));
check('the bundle displays our name', read('CFBundleDisplayName') === NAME);
check('the bundle has our identifier', read('CFBundleIdentifier') === APP_ID, read('CFBundleIdentifier'));

// The Dock takes its label from the running executable, not from the plist.
check('the executable is renamed', read('CFBundleExecutable') === NAME
  && fs.existsSync(path.join(appPath, 'Contents', 'MacOS', NAME)));

// require('electron') reads path.txt, so it has to follow the rename -- this
// is the check that catches an ENOENT launch before a user does.
const pathTxt = path.join(installed, 'node_modules', 'electron', 'path.txt');
check('path.txt follows the rename',
  fs.existsSync(pathTxt) && fs.readFileSync(pathTxt, 'utf8').trim().endsWith(NAME),
  fs.existsSync(pathTxt) ? fs.readFileSync(pathTxt, 'utf8').trim() : 'missing');

// The icon in the bundle is what Finder, Cmd-Tab and the Dock show before the
// app runs. Compare the bytes: CFBundleIconFile says which file is used and
// would read "correct" with the Electron atom still inside it.
const icon = path.join(appPath, 'Contents', 'Resources', 'electron.icns');
check('the bundle carries our icon',
  fs.existsSync(icon) && sha(icon) === sha(path.join(ROOT, 'build', 'icon.icns')));

// An unsigned bundle will not launch at all on Apple Silicon, which is a worse
// outcome than any naming bug.
check('the bundle is still validly signed',
  spawnSync('codesign', ['--verify', appPath]).status === 0);

/* ---------- report ---------- */

let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}
console.log(bad ? `\n${bad} failing` : `\nall ${checks.length} passing`);
process.exit(bad ? 1 : 0);
