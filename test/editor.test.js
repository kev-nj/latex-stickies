// Editor behaviors. The rules are pure functions, so drive them directly:
// "text with | as the caret" in, "text with | as the caret" out.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, 'src/renderer/editor.js'), 'utf8');
eval(src.slice(0, src.indexOf('/* ---------- the one part that writes')));

// "a|b" -> value "ab", caret 1.  "§" marks the end of a selection.
// (Not "]" -- that collides with task-list syntax like "- [x] done".)
function parse(spec) {
  const start = spec.indexOf('|');
  let rest = spec.slice(0, start) + spec.slice(start + 1);
  let end = rest.indexOf('§');
  if (end === -1) return { value: rest, start, end: start };
  rest = rest.slice(0, end) + rest.slice(end + 1);
  return { value: rest, start, end };
}

function render(value, selStart, selEnd) {
  if (selEnd > selStart) {
    return value.slice(0, selStart) + '|' + value.slice(selStart, selEnd) +
      '§' + value.slice(selEnd);
  }
  return value.slice(0, selStart) + '|' + value.slice(selStart);
}

function press(spec, key, shiftKey = false) {
  const { value, start, end } = parse(spec);
  const edit = computeEdit({ key, shiftKey }, value, start, end);
  if (!edit) return null;
  const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
  const selStart = edit.selStart ?? edit.from + edit.insert.length;
  return render(next, selStart, edit.selEnd ?? selStart);
}

const F = '```python\n'; // opens a fence for the code-context cases

const cases = [
  // --- auto-indent inside fences ---
  ['keeps indent',        F + '    x = 1|',        'Enter', F + '    x = 1\n    |'],
  ['indents after colon', F + 'for i in r():|',    'Enter', F + 'for i in r():\n  |'],
  ['indents after brace', F + 'if (x) {|',         'Enter', F + 'if (x) {\n  |'],
  ['nests indent',        F + '  while x:|',       'Enter', F + '  while x:\n    |'],
  ['closer to own line',  F + 'f({|}',             'Enter', F + 'f({\n  |\n}'],

  // --- prose must NOT get code indenting ---
  ['prose colon plain',   'Note:|',                'Enter', null],
  ['bullet continues',    '- milk|',               'Enter', '- milk\n- |'],
  ['numbered increments', '1. one|',               'Enter', '1. one\n2. |'],
  ['task resets box',     '- [x] done|',           'Enter', '- [x] done\n- [ ] |'],
  ['empty item ends list','- |',                   'Enter', '|'],
  ['nested bullet keeps indent', '  - a|',         'Enter', '  - a\n  - |'],

  // --- Tab ---
  ['tab inserts spaces',  'x|',                    'Tab',   'x  |'],
  ['tab indents block',   '|a\nb§',                'Tab',   '|  a\n  b§'],
  ['shift-tab dedents',   '    x|',                'Tab',   '  x|', true],
  ['shift-tab at margin', 'x|',                    'Tab',   null,  true],

  // --- pairs ---
  ['brackets close',      F + 'f|',                '(',     F + 'f(|)'],
  ['quotes close in code',F + 'x = |',             '"',     F + 'x = "|"'],
  ['quotes plain in prose','don|',                 "'",     null],
  ['dollar pairs in prose','see |',                '$',     'see $|$'],
  ['wraps selection',     'let |x§ be',            '$',     'let $|x§$ be'],
  ['skips over closer',   F + 'f(|)',              ')',     F + 'f()|'],
  ['no pair before word', F + '|foo',              '(',     null],
  ['backspace clears pair', F + 'f(|)',            'Backspace', F + 'f|'],
];

let bad = 0;
for (const [name, input, key, expected, shift] of cases) {
  const got = press(input, key, shift);
  const ok = got === expected;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        in:  ${JSON.stringify(input)}`);
    console.log(`        want:${JSON.stringify(expected)}`);
    console.log(`        got: ${JSON.stringify(got)}`);
  }
}
console.log(bad ? `\n${bad} failing` : `\nall ${cases.length} passing`);
process.exit(bad ? 1 : 0);
