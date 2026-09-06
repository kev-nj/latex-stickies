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
  // Click the checkbox and see whether the markdown actually flipped.
  // Poll rather than trust the wait above. A loaded CI runner has taken
  // longer than this to draw the first widgets, which failed here as a
  // checkbox that would not tick.
  const ticked = await w.webContents.executeJavaScript(\`
    (async () => {
      let box = null;
      for (let i = 0; i < 60 && !box; i++) {
        box = document.querySelector('.cm-task');
        if (!box) await new Promise((r) => setTimeout(r, 100));
      }
      if (!box) return 'no checkbox';
      const view = window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      const before = view.state.doc.toString();
      box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const after = view.state.doc.toString();
      return before.includes('- [ ]') && after.includes('- [x]') ? 'toggled' : 'unchanged';
    })()
  \`).catch((e) => 'error: ' + e.message);
  console.log('PROBE_CLICK ' + ticked);

  // The markers are in the document, hidden by width. Navigation only stays
  // coherent if they come back the moment the caret is on their element, so
  // that is what is measured -- not whether the characters are absent.
  const interact = await w.webContents.executeJavaScript(\`
    (async () => {
      const view = window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      // The stars of the bold word, not simply the first marker in the note:
      // that one is the heading's hash, and the caret is nowhere near it.
      const stars = () => [...document.querySelectorAll('.cm-md-marker')]
        .find((el) => el.textContent === '**');
      const width = () => {
        const el = stars();
        return el ? el.getBoundingClientRect().width : -1;
      };
      const shut = width();
      const markerText = stars() ? stars().textContent : '';

      // The caret inside "bold" must open that word's stars and nothing else
      // on the line -- the reveal is per element, not per line.
      const text = view.state.doc.toString();
      view.dispatch({ selection: { anchor: text.indexOf('**bold**') + 3 } });
      await new Promise((r) => setTimeout(r, 300));
      const open = width();
      const openOpacity = Number(getComputedStyle(
        document.querySelector('.cm-md-marker-open')).opacity);

      // Colour, not opacity, is what makes a marker quiet: a faded one sinks
      // into the paper, and counting the hashes of a heading stops working.
      const inkOf = (el) => getComputedStyle(el.querySelector('span') || el).color;
      const markerColour = inkOf(stars());
      const bodyColour = getComputedStyle(document.querySelector('.cm-content')).color;
      const headColour = inkOf([...document.querySelectorAll('.cm-md-marker')]
        .find((el) => el.textContent.startsWith('#')));
      const perWord = [...document.querySelectorAll('.cm-md-marker')]
        .filter((el) => el.classList.contains('cm-md-marker-open'))
        .map((el) => el.textContent).join('');

      const codeLine = document.querySelector('.cm-md-code');
      const box = codeLine.getBoundingClientRect();
      const before = Number(getComputedStyle(document.querySelector('.cm-copy')).opacity);
      codeLine.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }));
      const after = Number(getComputedStyle(document.querySelector('.cm-copy')).opacity);
      // The link sits on the last line, below a 640px window, and CodeMirror
      // only builds DOM for the viewport. Scroll there so the checks below
      // can see it.
      view.dispatch({ effects: window.CM.EditorView.scrollIntoView(view.state.doc.length) });
      return JSON.stringify({ shut, open, openOpacity, markerColour, bodyColour, headColour,
        text: markerText, perWord,
        copyBefore: before, copyAfter: after,
      });
    })()
  \`).catch((e) => JSON.stringify({ error: e.message }));
  console.log('PROBE_INTERACT ' + interact);

  // Zero-width text is where selection and undo usually surprise you, so both
  // are exercised rather than reasoned about.
  const keys = await w.webContents.executeJavaScript(\`
    (async () => { try {
      const view = window.CM.EditorView.findFromDOM(document.querySelector('.cm-editor'));
      const heading = document.querySelector('.cm-md-h1');
      const range = document.createRange();
      range.selectNodeContents(heading);
      const dom = window.getSelection();
      dom.removeAllRanges();
      dom.addRange(range);
      const copied = dom.toString();
      dom.removeAllRanges();

      // Double-escaped on purpose: this source passes through two template
      // literals, and a single backslash-n arrives as a real newline that
      // breaks the string literal it sits in.
      // Walking the caret must visit every line on the way. Real key events,
      // not the command: the fix is a keymap entry ahead of the default one,
      // and calling the built-in command directly would step around it.
      const press = (key, mods) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',
        Object.assign({ key, bubbles: true, cancelable: true }, mods)));
      const pause = () => new Promise((r) => setTimeout(r, 60));
      view.focus();
      const walkFrom = async (anchor, key, steps, mods) => {
        view.dispatch({ selection: { anchor }, scrollIntoView: true });
        await new Promise((r) => setTimeout(r, 250));
        const seen = [];
        for (let i = 0; i < steps; i++) {
          press(key, mods);
          await pause();
          seen.push(view.state.doc.lineAt(view.state.selection.main.head).number);
        }
        return seen;
      };
      const walk = await walkFrom(view.state.doc.length, 'ArrowUp', 12);
      const walkDown = await walkFrom(view.state.doc.line(22).from, 'ArrowDown', 5);
      // Extending a selection goes through the same geometry as moving.
      const walkShift = await walkFrom(view.state.doc.line(27).from, 'ArrowUp', 5, { shiftKey: true });
      const selected = view.state.selection.main;
      const extended = selected.anchor === view.state.doc.line(27).from && !selected.empty;

      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: '\\\\n## New' }, selection: { anchor: end + 7 } });
      const typed = view.state.doc.toString();
      const undo = window.CM.historyKeymap.find((b) => b.key === 'Mod-z').run;
      undo(view);
      const undone = view.state.doc.length === end;
      const original = view.state.doc.toString();
      // Typing a heading must show its hashes as they are typed. The parser
      // runs behind the keystroke, so this is where the reveal was a
      // keystroke late and a heading was written blind.
      const typing = [];
      {
        const at = view.state.doc.length;
        view.dispatch({ changes: { from: at, insert: String.fromCharCode(10) },
          selection: { anchor: at + 1 } });
        await new Promise((r) => setTimeout(r, 260));
        for (const ch of ['#', '#', '#']) {
          const head = view.state.selection.main.head;
          view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 } });
          await new Promise((r) => setTimeout(r, 260));
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          const dom = view.domAtPos(line.from).node;
          const el = (dom.nodeType === 1 ? dom : dom.parentElement)
            .closest('.cm-line').querySelector('.cm-md-marker');
          typing.push(el && el.classList.contains('cm-md-marker-open')
            && el.getBoundingClientRect().width > 0);
        }
      }

      // A quote's own bar sat flush against its text, and every nesting level
      // was drawn identically. Both are geometry, so both are measured.
      const quotes = [];
      {
        const at = view.state.doc.length;
        view.dispatch({
          changes: { from: at, insert: String.fromCharCode(10) + '> One'
            + String.fromCharCode(10) + '>> Two' + String.fromCharCode(10) + '>>> Three' },
          selection: { anchor: at + 1 },
        });
        await new Promise((r) => setTimeout(r, 300));
        for (const n of [view.state.doc.lines - 2, view.state.doc.lines - 1, view.state.doc.lines]) {
          const dom = view.domAtPos(view.state.doc.line(n).from).node;
          const el = (dom.nodeType === 1 ? dom : dom.parentElement).closest('.cm-line');
          quotes.push({
            quote: el.classList.contains('cm-md-quote'),
            pad: parseFloat(getComputedStyle(el).paddingLeft),
            bar: parseFloat(getComputedStyle(el, '::before').width),
          });
        }
        // Walk back up through them: a padded block is where vertical motion
        // has gone wrong before.
        const bottom = view.state.doc.line(view.state.doc.lines);
        view.dispatch({ selection: { anchor: bottom.from + 2 }, scrollIntoView: true });
        await new Promise((r) => setTimeout(r, 300));
        for (let i = 0; i < 2; i++) {
          press('ArrowUp');
          await pause();
          quotes.push({ line: view.state.doc.lineAt(view.state.selection.main.head).number });
        }
      }

      // Enter has to carry a list on, or a bare line after a task invites
      // "[ ] thing", which looks like a task and is not one. A second Enter on
      // an item with nothing in it should end the list rather than extend it.
      const listed = [];
      for (const [start, typed] of [['- [ ] milk', 'eggs'], ['- one', 'two'],
                                    ['1. one', 'two'], ['> quoted', 'more']]) {
        const at = view.state.doc.length;
        view.dispatch({
          changes: { from: at, insert: '\\\\n' + start },
          selection: { anchor: at + start.length + 1 },
        });
        press('Enter');
        await pause();
        view.dispatch({ changes: { from: view.state.selection.main.head, insert: typed },
          selection: { anchor: view.state.selection.main.head + typed.length } });
        listed.push(view.state.doc.lineAt(view.state.selection.main.head).text);
        press('Enter');
        await pause();
        press('Enter');
        await pause();
        listed.push(view.state.doc.lineAt(view.state.selection.main.head).text);
      }

      // Put the note back: the checks after this one count what is on screen.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });

      // Let the markers of the last line the caret touched finish closing,
      // or the checks that follow measure one mid-transition.
      view.dispatch({ selection: { anchor: 0 } });
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify({ copied, walk, walkDown, walkShift, extended, listed, typing, quotes,
        typedOk: typed.endsWith('## New'), undone });
      } catch (e) { return JSON.stringify({ error: String(e) }); } })()
  \`).catch((e) => JSON.stringify({ error: e.message }));
  console.log('PROBE_KEYS ' + keys);

  console.log('PROBE ' + await w.webContents.executeJavaScript(\`JSON.stringify({
    editor: !!document.querySelector('.cm-editor'),
    math: document.querySelectorAll('.cm-math .katex').length,
    task: document.querySelectorAll('.cm-task').length,
    bullet: document.querySelectorAll('.cm-bullet').length,
    code: document.querySelectorAll('.cm-md-code').length,
    heading: document.querySelectorAll('.cm-md-h1').length,
    highlighted: document.querySelectorAll('.cm-md-code span[class]').length,
    markerWidth: Math.max(...[...document.querySelectorAll('.cm-md-marker:not(.cm-md-marker-open)')]
      .map((el) => el.getBoundingClientRect().width)),
    markers: document.querySelectorAll('.cm-md-marker').length,
    proseFont: getComputedStyle(document.querySelector('.cm-line:not(.cm-md-code)')).fontFamily,
    codeFont: getComputedStyle(document.querySelector('.cm-md-code')).fontFamily,
    fenceTicks: [...document.querySelectorAll('.cm-md-marker')]
      .some((el) => el.textContent.includes('\\u0060\\u0060\\u0060')),
    copyButtons: document.querySelectorAll('.cm-copy').length,

    titleIndent: document.querySelector('.cm-md-h1').innerText.startsWith(' '),
    contentPad: parseFloat(getComputedStyle(document.querySelector('.cm-content')).paddingLeft),
    headingUnderline: getComputedStyle(
      document.querySelector('.cm-md-h1 span') || document.querySelector('.cm-md-h1')
    ).textDecorationLine,
    langLabel: document.querySelectorAll('.cm-code-lang').length,
    inlineCode: document.querySelectorAll('.cm-inline-code').length,
    anchors: document.querySelectorAll('.cm-content a').length,
    inlineCodeBg: document.querySelector('.cm-inline-code')
      ? getComputedStyle(document.querySelector('.cm-inline-code')).backgroundColor : '',
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
  const clickLine = out.split('\n').find((l) => l.startsWith('PROBE_CLICK '));
  r.checkboxToggled = clickLine && clickLine.includes('toggled');
  const interactLine = out.split('\n').find((l) => l.startsWith('PROBE_INTERACT '));
  const i = interactLine ? JSON.parse(interactLine.slice(15)) : {};
  const keysLine = out.split('\n').find((l) => l.startsWith('PROBE_KEYS '));
  const k = keysLine ? JSON.parse(keysLine.slice(11)) : {}; if (process.env.DBG) console.error(keysLine);
  const checks = [
    ['editor mounted', r.editor],
    ['maths rendered by KaTeX', r.math >= 2],
    ['task checkbox shown', r.task === 1],
    ['clicking the checkbox ticks it', r.checkboxToggled === true],
    ['bullet shown, and not on the task item', r.bullet === 1],
    ['code block styled', r.code >= 3],
    ['heading styled', r.heading >= 1],
    ['fenced code highlighted', r.highlighted > 0],
    ['syntax markers kept in the document', r.markers >= 3],
    ['syntax markers take no width', r.markerWidth === 0],
    ['a revealed marker is fully opaque', i.openOpacity === 1],
    ['a marker is drawn in the marker grey', i.markerColour === 'rgb(117, 117, 117)'],
    ['a marker is not the colour of the prose', i.markerColour !== i.bodyColour],
    ['every kind of marker agrees on it', i.headColour === i.markerColour],
    ['a marker reappears when the caret is on its element', i.open > 0 && i.shut === 0],
    ['the revealed marker is the pair of stars', i.text === '**'],
    ['only the caret\'s own element shows its markers', i.perWord === '****'],
    ['copying a heading takes the text, not its markers',
      k.copied === 'Welcome to LaTeX Stickies'],
    // A repeat is a wrapped line, which is fine; a gap is a line the caret
    // could not land on.
    ['arrowing up visits every line, code block included',
      Array.isArray(k.walk) && k.walk.includes(24)
        && k.walk.every((n, idx) => idx === 0 || n === k.walk[idx - 1] || n === k.walk[idx - 1] - 1)],
    ['arrowing down does the same',
      Array.isArray(k.walkDown) && k.walkDown.join() === '23,24,25,26,27'],
    // A quote is the exception, and CodeMirror's own: an empty "> " carries
    // on rather than ending, so it is recorded here rather than asserted away.
    ['quoted text is inset from its bar',
      Array.isArray(k.quotes) && k.quotes[0].quote && k.quotes[0].pad > 0],
    ['each nesting level indents further and draws its own bar',
      Array.isArray(k.quotes)
        && k.quotes[1].pad > k.quotes[0].pad && k.quotes[2].pad > k.quotes[1].pad
        && k.quotes[1].bar > k.quotes[0].bar && k.quotes[2].bar > k.quotes[1].bar],
    ['the caret still steps through a nested quote',
      Array.isArray(k.quotes) && k.quotes[3] && k.quotes[4]
        && k.quotes[3].line === k.quotes[4].line + 1],
    ['a heading shows its hashes while it is being typed',
      Array.isArray(k.typing) && k.typing.length === 3 && k.typing.every(Boolean)],
    ['Enter carries a list on, and an empty item ends it',
      (k.listed || []).join('|') === '- [ ] eggs||- two||2. two||> more|> '],
    ['shift-arrow extends a line at a time too',
      Array.isArray(k.walkShift) && k.walkShift.join() === '26,25,24,23,22' && k.extended],
    ['undo after typing a heading marker steps back over it', k.typedOk && k.undone],
    // CodeMirror's base theme sets monospace on everything; prose must escape it.
    ['prose is not monospace', !/mono/i.test(r.proseFont || '')],
    ['code is monospace', /mono/i.test(r.codeFont || '')],
    ['fence backticks are markers, not text', r.fenceTicks === true],
    ['copy buttons on the code blocks', r.copyButtons >= 1],
    ['copy button hidden until the block is hovered', i.copyBefore === 0],
    ['hovering the code block reveals it', i.copyAfter > 0.2],
    ['heading not indented by its hidden marker', r.titleIndent === false],
    ['content inset from the window edge', r.contentPad >= 8],
    ['headings are not underlined', !/underline/.test(r.headingUnderline || '')],
    ['language name tagged as a label', r.langLabel >= 1],
    ['inline code marked', r.inlineCode >= 1],
    ['markdown link is a real anchor', r.anchors >= 1],
    ['inline code has a background chip', !/rgba\(0, 0, 0, 0\)/.test(r.inlineCodeBg)],
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
