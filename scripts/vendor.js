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
  ['marked', from('marked', 'lib', 'marked.umd.js'), 'marked.js'],
  ['dompurify', from('dompurify', 'dist', 'purify.min.js'), 'purify.js'],
];

// Prism ships core plus one file per grammar; order matters, since components
// extend grammars defined before them. Core already carries markup, css,
// clike and javascript.
const PRISM_LANGUAGES = [
  'c', 'cpp', 'python', 'bash', 'json', 'yaml', 'typescript', 'jsx',
  'java', 'rust', 'go', 'sql', 'latex', 'diff', 'markdown', 'ruby',
  // php registers a global tokenize hook that reaches into markup-templating.
  // Without it loaded first, that hook throws on EVERY highlight call, not
  // just on php -- it takes the whole feature down.
  'markup-templating', 'php',
  'swift', 'toml',
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

const parts = [
  '/* Prism, vendored by scripts/vendor.js -- do not edit by hand. */',
  // Prism auto-highlights the whole page on load; the markdown renderer calls
  // Prism.highlight() itself, so switch that off.
  'window.Prism = window.Prism || {}; window.Prism.manual = true;',
  fs.readFileSync(from('prismjs', 'prism.js'), 'utf8'),
];

for (const lang of PRISM_LANGUAGES) {
  const file = from('prismjs', 'components', `prism-${lang}.min.js`);
  if (!fs.existsSync(file)) {
    console.error(`missing grammar: ${lang}`);
    process.exit(1);
  }
  parts.push(`\n/* --- ${lang} --- */\n${fs.readFileSync(file, 'utf8')}`);
}

fs.writeFileSync(path.join(OUT, 'prism.js'), parts.join('\n'));
console.log(
  `prism.js         <- prismjs ${version('prismjs')} ` +
  `(core + ${PRISM_LANGUAGES.length} grammars, ` +
  `${(fs.statSync(path.join(OUT, 'prism.js')).size / 1024).toFixed(0)} KB)`
);
