#!/usr/bin/env node
/**
 * Drives the autocomplete UI with a stubbed model.
 *
 * Types into the real editor, waits for the debounce, and checks that a ghost
 * suggestion appears and that Tab accepts it. Ollama is not involved: this
 * isolates the renderer path, so a failure here means the editor wiring is
 * broken rather than the model being slow or absent.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const SUGGESTION = ' and the rest follows.';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-check-'));
fs.writeFileSync(path.join(dir, 'package.json'),
  JSON.stringify({ name: 'ghost-check', main: 'main.js' }));

fs.writeFileSync(path.join(dir, 'pre.js'), `
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('sticky', {
  noteId: 'g',
  get: async () => ({ id: 'g', body: 'Some existing note text here.', color: 'yellow', fontSize: 15 }),
  update: async () => {}, flush: () => {}, create: async () => {}, remove: async () => {},
  setAlwaysOnTop: async () => {}, close: async () => {}, openExternal: () => {},
  copy: async () => {}, mathMenu: async () => {}, copyNote: async () => {}, on: () => {},
  ai: {
    settings: async () => ({ enabled: true, model: 'stub' }),
    complete: async () => ${JSON.stringify(SUGGESTION)},
  },
});
`);

fs.writeFileSync(path.join(dir, 'main.js'), `
const { app, BrowserWindow } = require('electron');
const path = require('path');
setTimeout(() => { console.log('PROBE {"timeout":true}'); app.exit(2); }, 40000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 420, height: 400, show: true, webPreferences: {
    preload: path.join(__dirname, 'pre.js'), contextIsolation: true } });
  w.webContents.on('console-message', (_e, _l, m) => console.log('PAGE ' + m));
  await w.loadFile(${JSON.stringify(path.join(ROOT, 'src/renderer/note.html'))});
  await new Promise((r) => setTimeout(r, 2000));

  // Type a word, the way a person would.
  await w.webContents.executeJavaScript(\`
    (() => {
      const view = window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      view.focus();
      view.dispatch({
        changes: { from: view.state.doc.length, insert: ' more words' },
        selection: { anchor: view.state.doc.length + 11 },
      });
      return true;
    })()
  \`).catch((e) => console.log('PAGE typing failed: ' + e.message));

  await new Promise((r) => setTimeout(r, 2500)); // debounce plus the request
  const seen = await w.webContents.executeJavaScript(
    "document.querySelectorAll('.cm-ghost').length");
  const text = await w.webContents.executeJavaScript(
    "(document.querySelector('.cm-ghost') || {}).textContent || ''");

  // Tab should take the suggestion into the document.
  await w.webContents.executeJavaScript(\`
    (() => {
      const el = document.querySelector('.cm-content');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }));
      return true;
    })()
  \`).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const after = await w.webContents.executeJavaScript(
    "document.querySelector('.cm-content').innerText");

  console.log('PROBE ' + JSON.stringify({ seen, text, accepted: after.includes('rest follows') }));
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
  const pages = out.split('\n').filter((l) => l.startsWith('PAGE '));
  if (!line) {
    console.error('FAIL  no result\n' + pages.join('\n') + '\n' + out.slice(-500));
    process.exit(1);
  }
  const r = JSON.parse(line.slice(6));
  const checks = [
    ['a suggestion appeared', r.seen === 1],
    ['it shows the model text', (r.text || '').includes('rest follows')],
    ['Tab accepted it into the note', r.accepted === true],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); }
  if (bad && pages.length) console.log('\npage console:\n  ' + pages.slice(0, 6).join('\n  '));
  process.exit(bad ? 1 : 0);
});
