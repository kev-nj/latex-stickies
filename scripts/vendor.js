#!/usr/bin/env node
/**
 * Rebuilds src/renderer/vendor/ from node_modules.
 *
 * The note page loads over file:// under `script-src 'self'`, so every library
 * has to be a local classic script -- no CDN, no ES modules. Vendoring by hand
 * is how the shipped copies drifted from the declared dependencies once
 * already (marked 18 was shipping while the tests ran against marked 14), so
 * this script is the only supported way to update them: it copies from the
 * installed packages and prints the versions it took, making a mismatch
 * between what is tested and what ships visible instead of silent.
 *
 * Run `npm run vendor` after changing any of these dependencies.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'renderer', 'vendor');

const from = (...p) => path.join(ROOT, 'node_modules', ...p);
const version = (pkg) => require(from(pkg, 'package.json')).version;

// Straight copies: browser-ready builds that need no assembly.
const COPIES = [
  ['katex', from('katex', 'dist', 'katex.min.js'), 'katex.min.js'],
  ['katex', from('katex', 'dist', 'katex.min.css'), 'katex.min.css'],
];

fs.mkdirSync(OUT, { recursive: true });

for (const [pkg, src, name] of COPIES) {
  fs.copyFileSync(src, path.join(OUT, name));
  console.log(`${name.padEnd(16)} <- ${pkg} ${version(pkg)}`);
}

// KaTeX loads its own font files relative to the stylesheet.
const fontsSrc = from('katex', 'dist', 'fonts');
const fontsOut = path.join(OUT, 'fonts');
fs.rmSync(fontsOut, { recursive: true, force: true });
fs.cpSync(fontsSrc, fontsOut, { recursive: true });
console.log(`fonts/           <- katex ${version('katex')} (${fs.readdirSync(fontsOut).length} files)`);

// CodeMirror ships ES modules only, and those cannot load over file:// under
// the page's script-src 'self'. Roll them into one classic script.
const cmOut = path.join(OUT, 'codemirror.js');
require('esbuild').buildSync({
  entryPoints: [path.join(ROOT, 'src', 'editor', 'entry.js')],
  outfile: cmOut,
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'chrome120',
});
console.log(
  `codemirror.js   <- @codemirror/* ` +
  `(${(fs.statSync(cmOut).size / 1024).toFixed(0)} KB)`
);
