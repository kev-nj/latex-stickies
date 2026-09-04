#!/usr/bin/env node
/**
 * Gives this app its own macOS bundle, so the Dock shows our name and icon.
 *
 * Run from source or from npm there is no .app of our own: macOS takes the
 * Dock name and icon from the Electron shell being launched, which is called
 * "Electron" and wears the atom logo. app.setName() cannot help -- the Dock
 * reads the bundle before any of our code runs.
 *
 * So the shell is cloned to a stable path of our own and branded there:
 *
 *   ~/Library/Application Support/latex-stickies/LaTeX Stickies.app
 *
 * Cloning rather than editing node_modules in place, for three reasons. npx
 * installs under a fresh cache hash every time, so in-place work is redone
 * constantly and thrown away by any cache prune or npm ci. A path macOS has
 * already registered as "Electron" tends to keep serving that name back from
 * the LaunchServices database however correct the plist becomes -- a path it
 * has never seen has no such record. And `npm update electron` would silently
 * revert every rename we made.
 *
 * On APFS the clone is copy-on-write: near-instant, and it costs almost no
 * disk until the files diverge.
 *
 * Everything here is best-effort. A wrong name in the Dock is a blemish; a
 * failed launch is not, so any error falls back to the unbranded shell.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'LaTeX Stickies';
/**
 * Our own bundle identifier, matching the packaged builds.
 *
 * The shell ships as com.github.Electron, and LaunchServices keys its database
 * by identifier as well as by path -- so on a machine that has seen any other
 * Electron, that shared identifier can resolve to someone else's record and
 * serve its name, "Electron", however carefully this bundle is renamed.
 */
const APP_ID = 'com.kevinjusak.latexsticky';

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.icns');

/** Overridable so a test can brand somewhere disposable. */
const HOME = process.env.LATEX_STICKIES_APP_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'latex-stickies');
const TARGET = path.join(HOME, `${NAME}.app`);
const STAMP = path.join(HOME, '.branded.json');

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks'
  + '/LaunchServices.framework/Support/lsregister';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 120000, ...opts });

/** The Electron shell npm installed, and the version we would be cloning. */
function source() {
  const dir = path.dirname(require.resolve('electron/package.json', { paths: [ROOT] }));
  const binary = require(path.join(dir, 'index.js'));
  // .../Electron.app/Contents/MacOS/Electron -> .../Electron.app
  const app = path.resolve(path.dirname(binary), '..', '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return { app, version };
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** What the branded copy was built from, so it can be rebuilt when that moves. */
function stamp(version) {
  return JSON.stringify({
    electron: version,
    icon: fs.existsSync(ICON) ? sha(ICON) : '',
    name: NAME,
    id: APP_ID,
  });
}

function isCurrent(version) {
  try {
    return fs.existsSync(path.join(TARGET, 'Contents', 'MacOS', NAME))
      && fs.readFileSync(STAMP, 'utf8') === stamp(version);
  } catch (_) {
    return false;
  }
}

function setPlist(plist, key, value) {
  try {
    run('plutil', ['-replace', key, '-string', value, plist]);
  } catch (_) {
    run('plutil', ['-insert', key, '-string', value, plist]);
  }
}

/**
 * Builds the branded copy.
 *
 * The executable is renamed as well as the plist keys: macOS takes the Dock
 * label from the running executable, which is why packaged builds have always
 * been right -- electron-builder renames it -- and every npm install was not.
 */
function build(app, version) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.rmSync(TARGET, { recursive: true, force: true });

  // -c asks APFS for a copy-on-write clone; plain copy on any filesystem
  // that cannot, which is slower but correct.
  try {
    run('cp', ['-cR', app, TARGET]);
  } catch (_) {
    run('cp', ['-R', app, TARGET]);
  }

  const plist = path.join(TARGET, 'Contents', 'Info.plist');
  setPlist(plist, 'CFBundleName', NAME);
  setPlist(plist, 'CFBundleDisplayName', NAME);
  setPlist(plist, 'CFBundleIdentifier', APP_ID);
  setPlist(plist, 'CFBundleExecutable', NAME);

  const from = path.join(TARGET, 'Contents', 'MacOS', 'Electron');
  const to = path.join(TARGET, 'Contents', 'MacOS', NAME);
  if (fs.existsSync(from)) fs.renameSync(from, to);

  // The bundle icon is what Finder, Cmd-Tab and the Dock show before the app
  // is running; app.dock.setIcon() cannot stand in for it.
  const icon = path.join(TARGET, 'Contents', 'Resources', 'electron.icns');
  if (fs.existsSync(ICON) && fs.existsSync(icon)) fs.copyFileSync(ICON, icon);

  // Re-signing is required: any edit under Contents/ invalidates the ad-hoc
  // signature, and macOS will not launch a bundle whose signature does not
  // match its contents. Only the outer bundle was touched, so the helpers keep
  // their own signatures -- and --preserve-metadata keeps whatever
  // entitlements the stock build shipped with, which --deep would discard.
  run('codesign', [
    '--force',
    '--preserve-metadata=entitlements,requirements,flags',
    '--sign', '-', TARGET,
  ]);
  run('codesign', ['--verify', TARGET]);

  // Evict any record for this path before registering it, since lsregister -f
  // refreshes an entry but does not replace a stale one.
  try { run(LSREGISTER, ['-u', TARGET]); } catch (_) { /* nothing registered */ }
  try { run(LSREGISTER, ['-f', TARGET]); } catch (_) { /* only the cache */ }

  fs.writeFileSync(STAMP, stamp(version));
  return to;
}

/**
 * The binary to launch: the branded copy, or null to fall back to the shell.
 */
function ensure() {
  if (process.platform !== 'darwin') return null;

  let app;
  let version;
  try {
    ({ app, version } = source());
  } catch (err) {
    report(`could not find the Electron runtime to brand (${first(err)})`);
    return null;
  }

  try {
    if (isCurrent(version)) return path.join(TARGET, 'Contents', 'MacOS', NAME);
    const binary = build(app, version);
    report(`branded ${TARGET}`, true);
    return binary;
  } catch (err) {
    // Leave nothing half-built: a bundle with a broken signature will not
    // launch at all, which is far worse than the wrong name.
    fs.rmSync(TARGET, { recursive: true, force: true });
    report(`could not brand the app (${first(err)})`);
    return null;
  }
}

const first = (err) => String(err && err.message).split('\n')[0];

/**
 * Failures are reported, successes only when asked.
 *
 * A silent failure is what made this so hard to diagnose from a user's
 * terminal: "the Dock still says Electron" looked identical whether branding
 * had failed, had never run, or had worked on a bundle nobody was launching.
 */
function report(message, quiet = false) {
  if (!quiet || process.env.LATEX_STICKIES_VERBOSE) console.log(message);
}

module.exports = { ensure, TARGET, NAME, APP_ID };

if (require.main === module) ensure();
