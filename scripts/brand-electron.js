#!/usr/bin/env node
/**
 * Gives the Electron shell this app's name and icon, on macOS.
 *
 * Run from source or from npm there is no .app bundle of our own, so macOS
 * takes the Dock name and icon from the shell being launched -- which is called
 * "Electron" and wears the atom logo. app.setName() cannot change that: the
 * Dock reads it from the bundle before any of our code runs.
 *
 * Editing Info.plist invalidates the bundle's ad-hoc signature, so it is
 * re-signed afterwards. That matters: an unsigned bundle will not launch on
 * Apple Silicon at all, which is a far worse outcome than a wrong name. If
 * anything here fails, the original Info.plist goes back and the install
 * continues quietly -- a cosmetic nicety must never break someone's install.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = 'LaTeX Stickies';
/**
 * Our own bundle identifier, matching the packaged builds.
 *
 * The Electron shell ships as com.github.Electron, and LaunchServices keys its
 * database by identifier rather than by path. So on a machine that has seen any
 * other Electron -- another project's node_modules, an old npx copy, a
 * different Electron app entirely -- the Dock can serve that record's name,
 * "Electron", however carefully this script renames our copy. Taking our own
 * identifier is what stops the collision; renaming alone cannot.
 */
const APP_ID = 'com.kevinjusak.latexsticky';

/**
 * Makes LaunchServices re-read a bundle.
 *
 * It caches an app's name from the first time it sees the path, and npm
 * extracts Electron under a directory macOS indexes -- so it can record
 * "Electron" before this script ever runs, and then keep showing that in the
 * Dock however right the plist is. Renaming alone is not enough.
 */
function refreshLaunchServices(appPath) {
  try {
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks'
      + '/LaunchServices.framework/Support/lsregister',
      ['-f', appPath],
      { stdio: 'ignore', timeout: 10000 }
    );
  } catch (_) { /* the name is still right; only the cache is stale */ }
}

function main() {
  if (process.platform !== 'darwin') return; // only macOS names apps this way

  let appPath;
  try {
    const binary = require(require.resolve('electron', { paths: [path.join(__dirname, '..')] }));
    // .../Electron.app/Contents/MacOS/Electron -> .../Electron.app
    appPath = path.resolve(path.dirname(binary), '..', '..');
  } catch (_) {
    return; // no runtime installed; nothing to brand
  }

  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return;

  const read = (key) => {
    try {
      return execFileSync('plutil', ['-extract', key, 'raw', plist]).toString().trim();
    } catch (_) {
      return '';
    }
  };

  if (read('CFBundleName') === NAME && read('CFBundleIdentifier') === APP_ID) {
    // Already named, so a wrong name in the Dock can only be a stale cache.
    refreshLaunchServices(appPath);
    // Say so rather than exiting in silence. A user reporting "the Dock still
    // says Electron" needs to know whether the rename failed or whether they
    // are looking at an older instance still holding the single-instance lock.
    if (process.env.LATEX_STICKIES_VERBOSE) {
      console.log(`the Electron shell is already named "${NAME}"`);
    }
    return;
  }

  const backup = fs.readFileSync(plist);
  try {
    const fields = [
      ['CFBundleName', NAME],
      ['CFBundleDisplayName', NAME],
      ['CFBundleIdentifier', APP_ID],
    ];
    for (const [key, value] of fields) {
      try {
        execFileSync('plutil', ['-replace', key, '-string', value, plist]);
      } catch (_) {
        execFileSync('plutil', ['-insert', key, '-string', value, plist]);
      }
    }

    // The bundle icon is what shows before the app can set its own.
    const icon = path.join(__dirname, '..', 'build', 'icon.icns');
    const target = path.join(appPath, 'Contents', 'Resources', 'electron.icns');
    if (fs.existsSync(icon) && fs.existsSync(target)) fs.copyFileSync(icon, target);

    // Required: the edits above invalidate the ad-hoc signature, and macOS
    // refuses to launch a bundle whose signature does not match its contents.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'ignore',
    });
    execFileSync('codesign', ['--verify', appPath], { stdio: 'ignore' });

    refreshLaunchServices(appPath);

    console.log(`named the Electron shell "${NAME}"`);
  } catch (err) {
    fs.writeFileSync(plist, backup);
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
        stdio: 'ignore',
      });
    } catch (_) { /* leave it as found */ }
    console.log(`could not rename the Electron shell (${err.message.split('\n')[0]})`);
  }
}

try {
  main();
} catch (err) {
  // Never fail an install over the name in the Dock.
  console.log('skipped naming the Electron shell:', err.message.split('\n')[0]);
}
