const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
global.window = dom.window;
global.document = dom.window.document;

global.katex = require(path.join(ROOT, 'node_modules/katex'));
global.DOMPurify = require(path.join(ROOT, 'node_modules/dompurify'))(dom.window);
global.marked = require(path.join(ROOT, 'node_modules/marked'));
// Evaluate the vendored bundle inside the jsdom window -- this exercises the
// exact file that ships, not a separate node build of Prism.
dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/renderer/vendor/prism.js'), 'utf8'));
global.Prism = dom.window.Prism;

eval(fs.readFileSync(path.join(ROOT, 'src/renderer/markdown.js'), 'utf8'));

const cases = {
  'inline math': 'Euler: $e^{i\\pi}+1=0$ done',
  'display math': '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  'math in code span': 'literal `$x_1$` stays',
  'math in fence': '```\nsum = $a_1 + b_2$\n```',
  'table': '| a | b |\n|---|---|\n| 1 | $x^2$ |',
  'task list': '- [ ] todo\n- [x] done',
  'quote+hr+del': '> quoted\n\n---\n\n~~gone~~ and **bold**',
  'xss img': '![x](y" onerror="alert(1))',
  'xss script': 'hi <script>alert(1)</script> there',
  'xss link': '[click](javascript:alert(1))',
  'currency': 'costs $5 and $6 today',
  'broken tex': 'oops $\\frac{1}$ here',
  'nested list': '- a\n  - b\n    - c',
};

for (const [name, src] of Object.entries(cases)) {
  const out = renderMarkdown(src).replace(/\s+/g, ' ');
  const brief = out.length > 150 ? out.slice(0, 150) + '…' : out;
  console.log(`### ${name}\n  ${brief}\n`);
}

// Parse the result and look for real event-handler attributes, rather than
// grepping the string -- escaped text may legitimately contain the word.
function noEventAttrs(src) {
  const el = dom.window.document.createElement('div');
  el.innerHTML = renderMarkdown(src);
  return [...el.querySelectorAll('*')].every((n) =>
    [...n.attributes].every((a) => !a.name.toLowerCase().startsWith('on')));
}

// hard assertions
const checks = [
  ['code span keeps $', renderMarkdown('`$x_1$`').includes('$x_1$')],
  ['fence keeps $', renderMarkdown('```\n$a_1$\n```').includes('$a_1$')],
  ['inline math renders', renderMarkdown('$x^2$').includes('katex')],
  ['display math renders', renderMarkdown('$$x^2$$').includes('katex-display')],
  ['no script tag', !renderMarkdown('<script>alert(1)</script>').includes('<script')],
  ['no injected attribute', noEventAttrs('![x](y" onerror="alert(1))')],
  ['no onerror on real img', !/onerror/.test(renderMarkdown('<img src=x onerror=alert(1)>'))],
  ['currency left alone', !renderMarkdown('costs $5 and $6 today').includes('katex')],
  ['price pair left alone', !renderMarkdown('between $10 and $20 total').includes('katex')],
  ['math still works after fix', renderMarkdown('$e^{i\\pi}+1=0$').includes('katex')],
  ['single char math', renderMarkdown('$x$').includes('katex')],
  ['spaced delims rejected', !renderMarkdown('$ x $').includes('katex')],
  ['no javascript: href', !renderMarkdown('[c](javascript:alert(1))').includes('javascript:')],
  ['table renders', renderMarkdown('| a |\n|---|\n| 1 |').includes('<table')],
  ['task list renders', renderMarkdown('- [ ] t').includes('checkbox')],
  ['broken tex flagged', renderMarkdown('$\\frac{1}$').includes('math-error')],
  ['no leftover placeholder', !renderMarkdown('$x$ and $$y$$').includes('@@MATH')],

  // --- syntax highlighting ---
  ['python highlights', renderMarkdown('```python\nx = 1\n```').includes('language-python')],
  ['python emits tokens', /class="token /.test(renderMarkdown('```python\ndef f(): pass\n```'))],
  ['alias sh -> bash', renderMarkdown('```sh\nls -la\n```').includes('language-bash')],
  ['alias py -> python', renderMarkdown('```py\nx=1\n```').includes('language-python')],
  ['latex highlights', renderMarkdown('```latex\n\\frac{1}{2}\n```').includes('language-latex')],
  ['data-lang set', renderMarkdown('```go\nx := 1\n```').includes('data-lang="go"')],
  ['unknown lang falls back', (() => {
    const o = renderMarkdown('```notalang\nkeep me\n```');
    return !o.includes('language-') && o.includes('keep me');
  })()],
  ['bare fence stays plain', (() => {
    const o = renderMarkdown('```\nplain text\n```');
    return !o.includes('language-') && o.includes('plain text');
  })()],
  ['fence content not mangled', renderMarkdown('```python\nx = 1\n```').includes('1')],

  // --- regressions the highlighter could break ---
  ['math still literal in fence', renderMarkdown('```python\ny = $a_1$\n```').includes('$a_1$')],
  ['script escaped in fence', noEventAttrs('```python\n<script>alert(1)</script>\n```')
     && !renderMarkdown('```python\n<script>alert(1)</script>\n```').includes('<script>')],
  ['no button from note text', !renderMarkdown('<button onclick="x()">hi</button>').includes('<button')],
  ['inline code untouched', renderMarkdown('`$x_1$`').includes('$x_1$')],
];
console.log('---');
let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
}
process.exit(bad ? 1 : 0);
