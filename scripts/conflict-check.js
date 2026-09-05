#!/usr/bin/env node
/**
 * Drives the conflict banner in the real page.
 *
 * It shipped broken twice in an afternoon, both times invisibly to every other
 * check: the banner was styled `display: flex`, which beats the `hidden`
 * attribute -- that only sets `display: none` in the browser's own stylesheet
 * -- so it sat on screen from launch and could not be dismissed. Nothing in
 * the unit suites can see a computed style, and render-check does not touch
 * it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-check-'));
fs.writeFileSync(path.join(dir, 'package.json'),
  JSON.stringify({ name: 'conflict-check', main: 'main.js' }));

// A preload that keeps the handlers, so the check can deliver the same events
// the main process would.
fs.writeFileSync(path.join(dir, 'pre.js'), `
const { contextBridge } = require('electron');
const handlers = {};
contextBridge.exposeInMainWorld('sticky', {
  noteId: 'test',
  get: async () => ({ id: 'test', body: '# Note\\nmine', color: 'yellow', fontSize: 15 }),
  update: async () => {}, flush: () => {}, create: async () => {},
  remove: async () => {}, setAlwaysOnTop: async () => {}, close: async () => {},
  openExternal: () => {}, copy: async () => {}, mathMenu: async () => {},
  copyNote: async () => {},
  on: (channel, fn) => { handlers[channel] = fn; },
  ai: { settings: async () => ({ enabled: false }), complete: async () => '' },
});
contextBridge.exposeInMainWorld('probe', { fire: (c, p) => handlers[c] && handlers[c](p) });
`);

fs.writeFileSync(path.join(dir, 'main.js'), `
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DISPLAY = "getComputedStyle(document.getElementById('conflict')).display";
const DOC = "window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString()";

setTimeout(() => { console.log('PROBE {"timeout":true}'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 420, height: 420, show: false, webPreferences: {
    offscreen: true, preload: path.join(__dirname, 'pre.js'), contextIsolation: true,
    additionalArguments: ['--note-id=test'] } });
  const js = (code) => w.webContents.executeJavaScript(code);

  await w.loadFile(path.join(ROOT, 'src/renderer/note.html'));
  await wait(1500);

  const atLaunch = await js(DISPLAY);

  await js("window.probe.fire('note-conflict', '# Note\\\\ntheirs')");
  await wait(250);
  const onConflict = await js(DISPLAY);

  await js("document.querySelector('#conflict .mine').click()");
  await wait(250);
  const afterKeepMine = await js(DISPLAY);
  const keptMine = await js(DOC);

  await js("window.probe.fire('note-conflict', '# Note\\\\ntheirs')");
  await wait(250);
  await js("document.querySelector('#conflict .reload').click()");
  await wait(250);
  const afterUseTheirs = await js(DISPLAY);
  const tookTheirs = await js(DOC);

  // An ordinary outside edit, with nothing unsaved, is applied without asking
  // -- and spliced, so a caret set before it does not move to the end.
  await js("window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor')).dispatch({ selection: { anchor: 3 } })");
  await js("window.probe.fire('note-changed', '# Note\\\\ntheirs, edited elsewhere')");
  await wait(250);
  const spliced = await js(DOC);
  const caret = await js("window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.selection.main.head");

  console.log('PROBE ' + JSON.stringify({
    atLaunch, onConflict, afterKeepMine, keptMine, afterUseTheirs, tookTheirs, spliced, caret,
  }));
  app.exit(0);
}).catch((err) => { console.log('PROBE ' + JSON.stringify({ error: err.message })); app.exit(1); });
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
    console.error(`FAIL  the page never reported back\n${out.slice(-800)}`);
    process.exit(1);
  }
  const r = JSON.parse(line.slice(6));
  if (r.error || r.timeout) {
    console.error(`FAIL  ${r.error || 'timed out'}`);
    process.exit(1);
  }

  const checks = [
    ['the banner is hidden until there is a conflict', r.atLaunch === 'none'],
    ['a conflict shows it', r.onConflict === 'flex'],
    ['Keep mine dismisses it', r.afterKeepMine === 'none'],
    ['Keep mine keeps our text', r.keptMine === '# Note\nmine'],
    ['Use theirs dismisses it', r.afterUseTheirs === 'none'],
    ['Use theirs takes the other version', r.tookTheirs === '# Note\ntheirs'],
    ['an outside edit with nothing unsaved is applied', r.spliced === '# Note\ntheirs, edited elsewhere'],
    ['the caret survives an outside edit', r.caret === 3],
  ];

  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  console.log(bad ? `\n${bad} failing` : `\nall ${checks.length} passing`);
  process.exit(bad ? 1 : 0);
});
