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
fs.copyFileSync(path.join(ROOT, 'test/fixtures/stub-preload.js'), path.join(dir, 'pre.js'));
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
    table: document.querySelectorAll('.cm-md-table').length,
    code: document.querySelectorAll('.cm-md-code').length,
    heading: document.querySelectorAll('.cm-md-h1').length,
    highlighted: document.querySelectorAll('.cm-md-code span[class]').length,
    hidMarkers: !document.querySelector('.cm-content').innerText.includes('**bold**')
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
    ['table styled', r.table >= 3],
    ['code block styled', r.code >= 3],
    ['heading styled', r.heading >= 1],
    ['fenced code highlighted', r.highlighted > 0],
    ['emphasis markers hidden', r.hidMarkers],
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
