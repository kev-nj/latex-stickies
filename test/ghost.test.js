// Context assembly for autocomplete. Pulled out of ghost.js and driven with a
// stand-in for CodeMirror's document, so the line-boundary rules can be
// checked without starting an editor.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/ghost.js'), 'utf8');
const start = src.indexOf('function contextAround');
const end = src.indexOf('function requestGhost');
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 600;
eval(src.slice(start, end));

/** Minimal stand-in for CodeMirror's Text, enough for contextAround. */
function makeState(text) {
  const lines = text.split('\n');
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const lineAt = (pos) => {
    let n = 0;
    while (n + 1 < starts.length && starts[n + 1] <= pos) n += 1;
    return { from: starts[n], to: starts[n] + lines[n].length, number: n + 1, text: lines[n] };
  };
  return {
    doc: {
      length: text.length,
      lineAt,
      line: (n) => ({
        from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length,
        number: n, text: lines[n - 1],
      }),
      sliceString: (a, b) => text.slice(a, b),
    },
  };
}

const short = makeState('# Title\nhello world\nsecond line');
const shortAt = short.doc.length;

// A note long enough that the window cannot reach the top.
const longLines = ['# Physics notes'];
for (let i = 1; i <= 200; i += 1) longLines.push(`Line ${i} of the note about energy.`);
const long = makeState(longLines.join('\n'));
const longAt = long.doc.length;

const shortCtx = contextAround(short, shortAt);
const longCtx = contextAround(long, longAt);
const midCtx = contextAround(long, 4000);

const checks = [
  ['short note sends the whole thing', shortCtx.prefix.startsWith('# Title')],
  ['short note does not repeat the title', !shortCtx.prefix.includes('...')],

  ['long note keeps the heading', longCtx.prefix.startsWith('# Physics notes\n...\n')],
  ['long note prefix stays within budget', longCtx.prefix.length < PREFIX_CHARS + 120],
  // The point of the change: never hand the model a fragment of a line.
  ['prefix begins at a line boundary',
    longCtx.prefix.split('...\n')[1].startsWith('Line ')],
  ['suffix ends at a line boundary', !midCtx.suffix.length || midCtx.suffix.endsWith('.')],
  ['suffix stays within budget', midCtx.suffix.length < SUFFIX_CHARS + 120],
  ['at the end of a note there is nothing after the caret', longCtx.suffix === ''],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} failing` : `\nall ${checks.length} passing`);
process.exit(bad ? 1 : 0);
