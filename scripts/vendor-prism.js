#!/usr/bin/env node
/**
 * Concatenates Prism's core and the language grammars we ship into one
 * classic script at src/renderer/vendor/prism.js.
 *
 * The note page loads over file:// under `script-src 'self'`, so everything has
 * to be a local, non-module script -- the same reason katex, marked and purify
 * are vendored rather than pulled from a CDN.
 *
 * Order matters: components extend grammars defined before them (cpp needs c,
 * jsx needs javascript, and so on). Core already carries markup, css, clike
 * and javascript.
 */
const fs = require('fs');
const path = require('path');

const LANGUAGES = [
  'c', 'cpp', 'python', 'bash', 'json', 'yaml', 'typescript', 'jsx',
  'java', 'rust', 'go', 'sql', 'latex', 'diff', 'markdown', 'ruby',
  // php registers a global tokenize hook that reaches into markup-templating.
  // Without it loaded first, that hook throws on EVERY highlight call, not
  // just on php -- it takes the whole feature down.
  'markup-templating', 'php',
  'swift', 'toml',
];

const root = path.join(__dirname, '..');
const from = path.join(root, 'node_modules', 'prismjs');
const out = path.join(root, 'src', 'renderer', 'vendor', 'prism.js');

const parts = [
  '/* Prism, vendored by scripts/vendor-prism.js -- do not edit by hand. */',
  // Prism auto-highlights the whole page on load; we call Prism.highlight()
  // ourselves from the markdown renderer, so switch that off.
  'window.Prism = window.Prism || {}; window.Prism.manual = true;',
  fs.readFileSync(path.join(from, 'prism.js'), 'utf8'),
];

for (const lang of LANGUAGES) {
  const file = path.join(from, 'components', `prism-${lang}.min.js`);
  if (!fs.existsSync(file)) {
    console.error(`missing grammar: ${lang}`);
    process.exit(1);
  }
  parts.push(`\n/* --- ${lang} --- */\n${fs.readFileSync(file, 'utf8')}`);
}

fs.writeFileSync(out, parts.join('\n'));
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`vendored prism.js -- core + ${LANGUAGES.length} grammars, ${kb} KB`);
