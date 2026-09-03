/**
 * Editor conveniences for the note textarea: auto-indent, Tab handling,
 * bracket pairing and list continuation.
 *
 * The behavior is context-aware. Inside a ``` fence the textarea acts like a
 * code editor; outside one it acts like a notes field. That split matters --
 * indenting after a trailing colon is right in Python and wrong after "Note:",
 * and auto-closing a quote is right in code and infuriating in "don't".
 *
 * Every rule here is a pure function returning an edit descriptor
 * ({ from, to, insert, selStart, selEnd }) rather than touching the DOM, so the
 * logic is testable on its own. applyEdit() is the only part that writes, and
 * it goes through execCommand('insertText') so Cmd+Z still walks back through
 * the changes one at a time -- assigning to textarea.value would wipe the
 * browser's native undo stack.
 */

const INDENT = '  '; // two spaces: notes are narrow

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`', $: '$' };
// Quotes are excluded outside fences: apostrophes in ordinary prose are far
// more common than quoted pairs. `$` stays, because math is the point here.
const PROSE_PAIRS = new Set(['(', '[', '{', '$']);
const CLOSERS = new Set(Object.values(PAIRS));

const lineStart = (v, i) => v.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (v, i) => {
  const n = v.indexOf('\n', i);
  return n === -1 ? v.length : n;
};
const indentOf = (line) => (/^[ \t]*/.exec(line) || [''])[0];

/** Is the caret inside a fenced code block? Odd number of fences above it. */
function insideFence(value, pos) {
  const before = value.slice(0, pos);
  const fences = before.match(/^[ \t]*```/gm);
  return !!fences && fences.length % 2 === 1;
}

/* ---------- Enter ---------- */

const OPENS_BLOCK = /[:{[(]\s*$/;
const LIST_ITEM = /^([ \t]*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )(.*)$/;

function onEnter(value, start, end) {
  const ls = lineStart(value, start);
  const line = value.slice(ls, start);

  if (insideFence(value, start)) {
    const indent = indentOf(line);
    const deeper = OPENS_BLOCK.test(line);
    const inner = deeper ? indent + INDENT : indent;
    const after = value.slice(end, end + 1);

    // Caret sits between a just-opened pair: put the closer on its own line,
    // the way an editor does for `{|}`.
    if (deeper && CLOSERS.has(after)) {
      return {
        from: start, to: end,
        insert: `\n${inner}\n${indent}`,
        selStart: start + 1 + inner.length,
      };
    }
    return { from: start, to: end, insert: `\n${inner}` };
  }

  // Outside a fence: carry markdown lists onward.
  const item = LIST_ITEM.exec(value.slice(ls, lineEnd(value, start)));
  if (!item) return null;

  const [, indent, marker, content] = item;

  // Enter on an empty item ends the list rather than making another bullet.
  if (!content.trim()) {
    return { from: ls, to: end, insert: indent };
  }

  let next = marker;
  const ordered = /^(\d+)([.)] )$/.exec(marker);
  if (ordered) next = `${Number(ordered[1]) + 1}${ordered[2]}`;
  else if (/\[[xX]\]/.test(marker)) next = marker.replace(/\[[xX]\]/, '[ ]');

  return { from: start, to: end, insert: `\n${indent}${next}` };
}

/* ---------- Tab ---------- */

function onTab(value, start, end, shift) {
  const ls = lineStart(value, start);
  const le = lineEnd(value, end);

  // A selection spanning lines shifts the whole block.
  if (start !== end && value.slice(start, end).includes('\n')) {
    const lines = value.slice(ls, le).split('\n');
    const shifted = lines.map((l) =>
      shift ? l.replace(new RegExp(`^( {1,${INDENT.length}}|\t)`), '') : INDENT + l);
    const insert = shifted.join('\n');
    return { from: ls, to: le, insert, selStart: ls, selEnd: ls + insert.length };
  }

  if (shift) {
    const line = value.slice(ls, le);
    const removed = /^( {1,2}|\t)/.exec(line);
    if (!removed) return null;
    const n = removed[0].length;
    return {
      from: ls, to: ls + n, insert: '',
      selStart: Math.max(ls, start - n), selEnd: Math.max(ls, end - n),
    };
  }

  return { from: start, to: end, insert: INDENT };
}

/* ---------- brackets and quotes ---------- */

function onPair(value, start, end, ch) {
  const close = PAIRS[ch];
  if (!close) return null;

  const inFence = insideFence(value, start);
  if (!inFence && !PROSE_PAIRS.has(ch)) return null;

  // Wrapping a selection always makes sense, in code or prose.
  if (start !== end) {
    const selected = value.slice(start, end);
    return {
      from: start, to: end,
      insert: ch + selected + close,
      selStart: start + 1, selEnd: end + 1,
    };
  }

  // Don't auto-close when it would run into a word: `foo|bar` typing `(`.
  const after = value.slice(end, end + 1);
  if (after && !/[\s)\]}>,.;:]/.test(after)) return null;

  // For symmetric marks, a closer is more likely than a new pair when one is
  // already open on this line.
  if (ch === close) {
    const line = value.slice(lineStart(value, start), start);
    const count = line.split(ch).length - 1;
    if (count % 2 === 1) return null;
  }

  return { from: start, to: end, insert: ch + close, selStart: start + 1 };
}

/** Typing the closer that's already sitting there just steps over it. */
function onCloser(value, start, end, ch) {
  if (start !== end || !CLOSERS.has(ch)) return null;
  if (value.slice(end, end + 1) !== ch) return null;
  return { from: start, to: end, insert: '', selStart: start + 1 };
}

/** Backspace between an empty pair removes both halves. */
function onBackspace(value, start, end) {
  if (start !== end || start === 0) return null;
  const before = value[start - 1];
  const after = value[start];
  if (PAIRS[before] && PAIRS[before] === after) {
    return { from: start - 1, to: start + 1, insert: '', selStart: start - 1 };
  }
  return null;
}

/* ---------- formatting shortcuts ---------- */

const WRAPPERS = {
  b: '**',
  i: '*',
  e: '`',
};

/**
 * Cmd/Ctrl+B, +I, +E wrap the selection, and unwrap it again when it is
 * already wrapped -- pressing bold twice should leave the text as it started,
 * not bury it in four asterisks.
 */
function onWrap(value, start, end, key) {
  const mark = WRAPPERS[key];
  if (!mark) return null;
  const n = mark.length;

  const selected = value.slice(start, end);

  // Already wrapped, either inside the selection or just outside it.
  if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length > n * 2) {
    const inner = selected.slice(n, -n);
    return {
      from: start, to: end, insert: inner,
      selStart: start, selEnd: start + inner.length,
    };
  }
  if (value.slice(start - n, start) === mark && value.slice(end, end + n) === mark) {
    return {
      from: start - n, to: end + n, insert: selected,
      selStart: start - n, selEnd: start - n + selected.length,
    };
  }

  if (start === end) {
    // No selection: leave the caret between a fresh pair, ready to type.
    return { from: start, to: end, insert: mark + mark, selStart: start + n };
  }

  return {
    from: start, to: end,
    insert: mark + selected + mark,
    selStart: start + n, selEnd: end + n,
  };
}

/**
 * Cmd/Ctrl+K makes a link, and leaves the caret wherever there is still
 * something to type: in the URL when the label came from the selection, in the
 * brackets when the link is empty and needs a label first.
 */
function onLink(value, start, end) {
  const selected = value.slice(start, end);
  const insert = `[${selected}]()`;
  const caret = selected
    ? start + selected.length + 3 // inside ( )
    : start + 1;                  // inside [ ]
  return { from: start, to: end, insert, selStart: caret };
}

/* ---------- dispatch ---------- */

function computeEdit(e, value, start, end) {
  // Cmd on macOS, Ctrl elsewhere -- but never Alt, which carries its own
  // characters, and never both modifiers at once.
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (mod) {
    const key = (e.key || '').toLowerCase();
    if (key === 'k') return onLink(value, start, end);
    return onWrap(value, start, end, key);
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  if (e.key === 'Enter') return onEnter(value, start, end);
  if (e.key === 'Tab') return onTab(value, start, end, e.shiftKey);
  if (e.key === 'Backspace') return onBackspace(value, start, end);
  if (e.key.length === 1) {
    return onCloser(value, start, end, e.key) || onPair(value, start, end, e.key);
  }
  return null;
}

/* ---------- the one part that writes ---------- */

function applyEdit(el, edit) {
  el.setSelectionRange(edit.from, edit.to);
  // Keeps the change on the native undo stack, unlike assigning to .value.
  if (!document.execCommand('insertText', false, edit.insert)) {
    el.setRangeText(edit.insert, edit.from, edit.to, 'end');
  }
  const selStart = edit.selStart ?? edit.from + edit.insert.length;
  el.setSelectionRange(selStart, edit.selEnd ?? selStart);
}

function attachEditorBehaviors(el) {
  el.addEventListener('keydown', (e) => {
    const edit = computeEdit(e, el.value, el.selectionStart, el.selectionEnd);
    if (!edit) return;
    e.preventDefault();
    applyEdit(el, edit);
    el.dispatchEvent(new Event('input', { bubbles: true })); // triggers the save
  });
}
