#!/usr/bin/env node
/**
 * Checks that a note longer than the screen is photographed whole.
 *
 * The note's own window cannot do this -- macOS clamps a window to the display
 * and the editor only renders the lines it thinks are visible -- so captures
 * are taken in an offscreen window sized to the full content. This drives that
 * path with the real preload and the real page, and asserts the image is as
 * tall as the note rather than as tall as a screen.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const LINES = 120;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-check-'));
fs.writeFileSync(path.join(dir, 'package.json'),
  JSON.stringify({ name: 'snapshot-check', main: 'main.js' }));
fs.writeFileSync(path.join(dir, 'main.js'), `
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const body = ['# Long note', ''];
for (let i = 1; i <= ${LINES}; i++) body.push('Line ' + i + ' of a long note.');

setTimeout(() => { console.log('PROBE {"timeout":true}'); app.exit(2); }, 40000);
ipcMain.handle('note:get', async () => ({ id: 'x', body: body.join('\\n'), color: 'yellow', fontSize: 15 }));
for (const ch of ['note:update','note:setAlwaysOnTop','note:close','note:new','note:delete',
                  'note:openExternal','note:copyText','note:mathMenu','note:copyNote'])
  ipcMain.handle(ch, async () => null);
ipcMain.on('note:flush', (e) => { e.returnValue = true; });

app.whenReady().then(async () => {
  const shot = new BrowserWindow({ width: 380, height: 800, show: false, frame: false,
    webPreferences: { offscreen: true, preload: path.join(ROOT, 'src/preload.js'),
      contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--note-id=x', '--snapshot'] } });
  try {
    const height = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no height reported')), 10000);
      ipcMain.once('note:snapshotReady', (_e, h) => { clearTimeout(t); resolve(Math.ceil(h)); });
      shot.loadFile(path.join(ROOT, 'src/renderer/note.html')).catch(reject);
    });
    shot.setBounds({ ...shot.getBounds(), height });
    await new Promise((r) => setTimeout(r, 700));
    const img = await shot.webContents.capturePage();
    const rendered = await shot.webContents.executeJavaScript(
      "document.querySelectorAll('.cm-line').length");
    console.log('PROBE ' + JSON.stringify({ height, size: img.getSize(),
      empty: img.isEmpty(), rendered, expected: ${LINES} + 2 }));
    app.exit(0);
  } catch (err) {
    console.log('PROBE ' + JSON.stringify({ error: err.message }));
    app.exit(1);
  }
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
    console.error('FAIL  the capture never reported back\n' + out.slice(-800));
    process.exit(1);
  }
  const r = JSON.parse(line.slice(6));
  if (r.error || r.timeout) {
    console.error(`FAIL  ${r.error || 'timed out'}`);
    process.exit(1);
  }
  const checks = [
    ['note reported its full height, not the window height', r.height > 1500],
    ['every line rendered for the capture', r.rendered === r.expected],
    ['image is not empty', !r.empty],
    ['image is as tall as the note, not as tall as a screen', r.size.height >= r.height],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  if (bad) console.log(JSON.stringify(r));
  process.exit(bad ? 1 : 0);
});
