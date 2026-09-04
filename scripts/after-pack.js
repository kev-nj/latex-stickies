/**
 * Signs the packaged app, ad-hoc, before the .dmg and .zip are made.
 *
 * electron-builder finds no Developer ID here, so it skips signing entirely --
 * and leaves Electron's own linker signature in place on a bundle whose
 * executable, icon and Info.plist it has just rewritten. That signature no
 * longer matches its contents, so macOS reports the download as "damaged and
 * can't be opened", which right-click > Open cannot bypass. A user who saw
 * that dialog had no way in at all.
 *
 * An ad-hoc signature does not make the app trusted -- only Apple's Developer
 * ID and notarization do that, and this is not signed with either. What it
 * does is make the bundle internally consistent, so the dialog becomes the
 * ordinary "unidentified developer" one that right-click > Open does clear.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // --deep is deprecated by Apple but correct here: everything inside is
  // ad-hoc signed too, and there are no entitlements to preserve.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {
    stdio: 'inherit',
  });
  // Fail the build rather than ship what we cannot verify.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], {
    stdio: 'inherit',
  });

  console.log(`  • ad-hoc signed  ${path.basename(app)}`);
};
