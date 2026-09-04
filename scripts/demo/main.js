/**
 * Records the README demo by driving the real app.
 *
 * Screen recording needs a permission the terminal does not have, so instead
 * this loads the real note page with the real preload, types into it one
 * character at a time, and captures the window after each keystroke. Every
 * frame is the app actually rendering.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DEMO_ROOT;
const OUT = process.env.DEMO_FRAMES;
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function frame(win, copies = 1) {
  const png = (await win.webContents.capturePage()).toPNG();
  for (let i = 0; i < copies; i += 1) {
    fs.writeFileSync(path.join(OUT, `f${String(n++).padStart(4, '0')}.png`), png);
  }
}

/** A pause. Captures rather than duplicates: offscreen paint lags a dispatch. */
async function hold(win, frames) {
  for (let i = 0; i < frames; i += 1) {
    await wait(50);
    await frame(win);
  }
}

const js = (win, code) => win.webContents.executeJavaScript(code);
const VIEW = "window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor'))";

/** Types into the editor. `every` frames per character, so 2 = twice as fast. */
async function type(win, text, { every = 2 } = {}) {
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    await js(win, `(() => {
      const view = ${VIEW};
      const pos = view.state.selection.main.from;
      view.dispatch({ changes: { from: pos, insert: ${JSON.stringify(chars[i])} },
                      selection: { anchor: pos + 1 } });
    })()`);
    if (i % every === 0) await frame(win);
  }
  await frame(win);
}

const caretTo = (win, expr) => js(win, `(() => {
  const view = ${VIEW};
  view.dispatch({ selection: { anchor: ${expr} } });
})()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 400, height: 600, show: false, frame: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'pre.js'),
      contextIsolation: true,
      additionalArguments: ['--note-id=demo'],
    },
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/note.html'));
  await wait(1500);
  await js(win, `(() => { const view = ${VIEW};
    view.dispatch({ selection: { anchor: view.state.doc.length } }); })()`);
  await frame(win, 6);

  // 1. Maths, live.
  await type(win, 'The Gaussian integral\n\n');
  await type(win, '$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$\n');
  await hold(win, 10);

  // 2. A table, whose cells render maths too.
  await type(win, '\n| n | $n!$ |\n|---|---|\n| 4 | 24 |\n| 5 | 120 |\n');
  await hold(win, 10);

  // 3. A fenced block: language label, highlighting, copy button.
  await type(win, '\n```bash\nollama pull qwen2.5-coder:1.5b\n```\n');
  await hold(win, 10);

  // 4. Describe the maths in English; Cmd+Shift+M turns it into LaTeX.
  await type(win, '\nsum of 1 over n squared, 1 to infinity');
  await js(win, `(() => { const view = ${VIEW};
    const line = view.state.doc.lineAt(view.state.selection.main.from);
    view.dispatch({ selection: { anchor: line.from, head: line.to } }); })()`);
  await hold(win, 8);
  await js(win, "window.demo.fire('describe-latex')");
  await hold(win, 10);

  // 5. Autocomplete: a grey suggestion, accepted with Tab.
  await js(win, `(() => { const view = ${VIEW};
    view.dispatch({ selection: { anchor: view.state.doc.length } }); })()`);
  await type(win, '\n\nThe derivative of $x^2$ is ');
  await hold(win, 10);
  await js(win, `(() => { const view = ${VIEW};
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true })); })()`);
  await hold(win, 8);

  // 6. Click into the equation: the LaTeX source comes back.
  await caretTo(win, "view.state.doc.toString().indexOf('\\\\sqrt') + 2");
  await hold(win, 14);

  // Park on a blank line: nothing revealed, everything rendered.
  await caretTo(win, 'view.state.doc.line(2).from');
  await hold(win, 16);

  console.log('DEMO frames=' + n);
  app.exit(0);
}).catch((err) => { console.error('DEMO error ' + err.message); app.exit(1); });
