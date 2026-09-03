#!/usr/bin/env node
/**
 * Boots the real note page with a stub preload and checks that live preview
 * actually rendered.
 *
 * The unit suites cover pure logic and cannot see CodeMirror; this is the only
 * check that maths became a KaTeX widget, that markers hid, and that fenced
 * code got highlighted -- on whatever platform CI is running.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-check-'));
fs.writeFileSync(path.join(dir, 'package.json'),
  JSON.stringify({ name: 'render-check', main: 'main.js' }));
// The real first-run note: this check covers exactly what people see on
// install, so a welcome note that fails to render cannot ship.
const { WELCOME } = require(path.join(ROOT, 'src/welcome'));
fs.writeFileSync(
  path.join(dir, 'pre.js'),
  fs.readFileSync(path.join(ROOT, 'test/fixtures/stub-preload.js'), 'utf8')
    .replace('__BODY__', JSON.stringify(WELCOME))
);
fs.writeFileSync(path.join(dir, 'main.js'), `
const { app, BrowserWindow } = require('electron');
const path = require('path');
setTimeout(() => { console.log('PROBE {"timeout":true}'); app.exit(2); }, 40000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 420, height: 640, show: true, webPreferences: {
    preload: path.join(__dirname, 'pre.js'), contextIsolation: true } });
  w.webContents.on('console-message', (_e, _l, m) => console.log('PAGE ' + m));
  await w.loadFile(${JSON.stringify(path.join(ROOT, 'src/renderer/note.html'))});
  await new Promise((r) => setTimeout(r, 2500));
  console.log('PROBE ' + await w.webContents.executeJavaScript(\`JSON.stringify({
    editor: !!document.querySelector('.cm-editor'),
    math: document.querySelectorAll('.cm-math .katex').length,
    task: document.querySelectorAll('.cm-task').length,
    bullet: document.querySelectorAll('.cm-bullet').length,
    code: document.querySelectorAll('.cm-md-code').length,
    heading: document.querySelectorAll('.cm-md-h1').length,
    highlighted: document.querySelectorAll('.cm-md-code span[class]').length,
    hidMarkers: !document.querySelector('.cm-content').innerText.includes('**bold**'),
    proseFont: getComputedStyle(document.querySelector('.cm-line:not(.cm-md-code)')).fontFamily,
    codeFont: getComputedStyle(document.querySelector('.cm-md-code')).fontFamily,
    fenceTicks: document.querySelector('.cm-content').innerText.includes('\\u0060\\u0060\\u0060'),
    copyButtons: document.querySelectorAll('.cm-copy').length,
    copyOpacity: Number(getComputedStyle(document.querySelector('.cm-copy')).opacity),
    titleIndent: document.querySelector('.cm-md-h1').innerText.startsWith(' '),
    contentPad: parseFloat(getComputedStyle(document.querySelector('.cm-content')).paddingLeft),
    headingUnderline: getComputedStyle(
      document.querySelector('.cm-md-h1 span') || document.querySelector('.cm-md-h1')
    ).textDecorationLine,
    langLabel: document.querySelectorAll('.cm-code-lang').length,
    tableEl: document.querySelectorAll('table.cm-table').length,
    tableCells: document.querySelectorAll('.cm-table td').length,
    tableHeaders: document.querySelectorAll('.cm-table th').length,
    winInner: window.innerHeight
  })\`));
  app.exit(0);
});
`);

const args = process.platform === 'linux' ? [dir, '--no-sandbox'] : [dir];
const child = spawn(electronPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

child.on('exit', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('PROBE '));
  if (!line) {
    console.error('FAIL  the page never reported back\n' + out.slice(-800));
    process.exit(1);
  }
  const r = JSON.parse(line.slice(6));
  const checks = [
    ['editor mounted', r.editor],
    ['maths rendered by KaTeX', r.math >= 2],
    ['task checkbox shown', r.task === 1],
    ['bullet shown, and not on the task item', r.bullet === 1],
    ['code block styled', r.code >= 3],
    ['heading styled', r.heading >= 1],
    ['fenced code highlighted', r.highlighted > 0],
    ['emphasis markers hidden', r.hidMarkers],
    // CodeMirror's base theme sets monospace on everything; prose must escape it.
    ['prose is not monospace', !/mono/i.test(r.proseFont || '')],
    ['code is monospace', /mono/i.test(r.codeFont || '')],
    ['fence backticks hidden', r.fenceTicks === false],
    ['copy buttons on the code blocks', r.copyButtons >= 1],
    ['copy button visible without hovering', r.copyOpacity > 0.2],
    ['heading not indented by its hidden marker', r.titleIndent === false],
    ['content inset from the window edge', r.contentPad >= 8],
    ['headings are not underlined', !/underline/.test(r.headingUnderline || '')],
    ['language name tagged as a label', r.langLabel >= 1],
    ['table drawn as a real table', r.tableEl === 1],
    ['table has a header row', r.tableHeaders === 2],
    ['table has its body cells', r.tableCells === 4],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  const page = out.split('\n').filter((l) => l.startsWith('PAGE ')).slice(0, 5);
  if (page.length) console.log('\npage console:\n  ' + page.join('\n  '));
  process.exit(bad ? 1 : 0);
});
