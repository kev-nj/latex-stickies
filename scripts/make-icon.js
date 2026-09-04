#!/usr/bin/env node
/**
 * Regenerates the app icon from assets/icon-master.png.
 *
 *   assets/logo.jpeg       original artwork, yellow tile on a blue field
 *   assets/icon-master.png the prepared master: tile cropped out, transparent
 *                          ground, art filling the whole 1024 canvas
 *   build/icon.icns        what electron-builder puts in the .app
 *   build/icon.png         what app.dock.setIcon() uses when run from npm
 *
 * The artwork is full-bleed, which is a deliberate break from the old
 * 824-of-1024 padding convention. macOS 26 masks every legacy icon into its
 * own rounded square, so a padded icon that already has rounded corners gets a
 * second set drawn around it and sits inside a visible white plate. Filling
 * the canvas lets that mask clip our own edges instead.
 *
 * Uses only sips and iconutil, both of which ship with macOS, so there is no
 * toolchain to install. To change the logo, replace icon-master.png with a
 * 1024x1024 transparent PNG whose art reaches all four edges, then run this.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'assets', 'icon-master.png');
const BUILD = path.join(ROOT, 'build');

// The ten renditions macOS expects; iconutil rejects an incomplete set.
const SIZES = [16, 32, 128, 256, 512];

if (!fs.existsSync(MASTER)) {
  console.error(`missing ${path.relative(ROOT, MASTER)}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.error('sips and iconutil are macOS-only; skipping icon build.');
  process.exit(1);
}

const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', MASTER])
  .toString();
const [width, height] = (dims.match(/pixel(?:Width|Height): (\d+)/g) || [])
  .map((m) => Number(m.split(': ')[1]));

if (width !== height) {
  console.error(`master must be square, got ${width}x${height}`);
  process.exit(1);
}
if (width < 1024) {
  console.error(`master must be at least 1024px, got ${width}px`);
  process.exit(1);
}

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')) + '/icon.iconset';
fs.mkdirSync(iconset);

try {
  for (const size of SIZES) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const px = size * scale;
      const out = path.join(iconset, `icon_${size}x${size}${suffix}.png`);
      execFileSync('sips', ['-z', String(px), String(px), MASTER, '--out', out], {
        stdio: 'ignore',
      });
    }
  }

  fs.mkdirSync(BUILD, { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
  fs.copyFileSync(MASTER, path.join(BUILD, 'icon.png'));

  const kb = (n) => `${(fs.statSync(path.join(BUILD, n)).size / 1024).toFixed(0)} KB`;
  console.log(`icon.icns  ${kb('icon.icns')}  (${SIZES.length * 2} renditions)`);
  console.log(`icon.png   ${kb('icon.png')}`);
} finally {
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
}
