// decorateCodeBlocks() runs on the DOM after sanitizing. Exercise it directly.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><body><div id="preview"></div></body>');
global.window = dom.window;
global.document = dom.window.document;
const preview = document.getElementById('preview');

// Pull just the function under test out of note.js.
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/note.js'), 'utf8');
const start = src.indexOf('function decorateCodeBlocks()');
const end = src.indexOf('let copyResetTimer');
eval(src.slice(start, end));

const checks = [];
const check = (name, ok) => checks.push([name, ok]);

// One labelled block plus one bare block.
preview.innerHTML =
  '<pre data-lang="python"><code class="language-python">x = 1</code></pre>' +
  '<pre><code>plain</code></pre>';
decorateCodeBlocks();

check('wraps every pre', preview.querySelectorAll('.code-block').length === 2);
check('one copy button per block', preview.querySelectorAll('.code-copy').length === 2);
check('label only where a language is known',
  preview.querySelectorAll('.code-lang').length === 1);
check('label reads the language',
  preview.querySelector('.code-lang').textContent === 'python');
check('pre still inside its wrapper',
  preview.querySelector('.code-block > pre') !== null);
check('code text preserved',
  preview.querySelector('code').textContent === 'x = 1');

// A re-render replaces innerHTML wholesale, so decoration must not accumulate.
preview.innerHTML = '<pre data-lang="go"><code>x := 1</code></pre>';
decorateCodeBlocks();
check('no buttons accumulate across renders',
  preview.querySelectorAll('.code-copy').length === 1);

// A note whose text merely looks like a code block must not gain controls
// beyond the ones we add ourselves.
preview.innerHTML = '<p>&lt;button class="code-copy"&gt;Copy&lt;/button&gt;</p>';
decorateCodeBlocks();
check('no controls from text that looks like markup',
  preview.querySelectorAll('button').length === 0);

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
process.exit(bad ? 1 : 0);
