/**
 * Live-preview editor, built on CodeMirror 6.
 *
 * There is no edit mode and no preview mode: the note is always editable and
 * always rendered. Markdown syntax is hidden and its effect shown instead --
 * until the caret enters that particular element, which unfolds back to source.
 *
 * The reveal is per node, not per line. Putting the caret in one bold word
 * leaves the rest of the sentence rendered, which is what makes the editing
 * feel continuous rather than like a mode switch.
 *
 * Structural blocks -- tables, quotes, fenced code -- are not rebuilt as HTML.
 * They keep their markdown text and get a CSS class per line, which is far
 * cheaper than widget rendering and keeps every character editable in place.
 */

const {
  EditorState, StateField, EditorView, Decoration, WidgetType, keymap, Prec,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage, codeLanguages,
  syntaxTree, HighlightStyle, syntaxHighlighting, defaultHighlightStyle, tags,
} = window.CM;

/**
 * When true nothing unfolds, whatever the caret is doing.
 *
 * Screenshotting a note should capture it as a reader sees it, not with the
 * one element the caret happens to sit in showing its markdown.
 */
let snapshotMode = false;
let snapshotDirty = false;

/* ---------- widgets ---------- */

// Delimiters must hug their content, so prose like "costs $5 and $6" is left
// alone. Same rule as the read-only renderer.
const MATH = /\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\s)((?:\\.|[^$\\\n])*?[^\s\\]|[^\s$\\])\$(?!\d)/g;

class MathWidget extends WidgetType {
  constructor(tex, display) {
    super();
    this.tex = tex;
    this.display = display;
  }

  // Without an eq() CodeMirror rebuilds every widget on every keystroke.
  eq(other) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = 'cm-math';
    el.dataset.tex = this.tex;
    el.dataset.display = this.display ? 'block' : 'inline';
    try {
      katex.render(this.tex, el, {
        displayMode: this.display,
        throwOnError: true,
        strict: false,
        trust: false,
      });
    } catch (err) {
      // Show the source rather than blanking the line.
      el.className = 'cm-math cm-math-error';
      el.title = err.message;
      el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
    }
    return el;
  }

  ignoreEvent() {
    return false; // clicks put the caret in, which unfolds the source
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, from, to) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }

  // Position is part of identity: without it CodeMirror reuses a widget whose
  // stored range has moved, and the click then edits the wrong characters.
  eq(other) {
    return other.checked === this.checked
      && other.from === this.from && other.to === this.to;
  }

  toDOM(view) {
    const box = document.createElement('span');
    box.className = `cm-task${this.checked ? ' cm-task-done' : ''}`;
    box.textContent = this.checked ? '☑' : '☐';
    box.title = 'Click to tick';
    box.addEventListener('mousedown', (e) => {
      // Otherwise CodeMirror takes the click as "put the caret here", which
      // unfolds the marker back to source instead of ticking it.
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
      });
    });
    return box;
  }

  ignoreEvent() {
    return true; // it is a control, not text
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'cm-bullet';
    dot.textContent = '•';
    return dot;
  }
}

class CopyButtonWidget extends WidgetType {
  constructor(code) {
    super();
    this.code = code;
  }

  eq(other) {
    return other.code === this.code;
  }

  toDOM() {
    const button = document.createElement('span');
    button.className = 'cm-copy';
    button.textContent = 'Copy';
    button.title = 'Copy this block';
    button.addEventListener('mousedown', (e) => {
      // Keep CodeMirror from treating this as a click into the document.
      e.preventDefault();
      e.stopPropagation();
      window.sticky.copy(this.code);
      button.textContent = 'Copied';
      button.classList.add('done');
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('done');
      }, 1200);
    });
    return button;
  }

  ignoreEvent() {
    return true; // it is a button, not text
  }
}

/**
 * A markdown table, drawn as a real table.
 *
 * Rendered only while the caret is elsewhere; clicking in unfolds the pipes
 * again, exactly as an equation does. That keeps the source directly editable
 * without asking anyone to line up columns by eye to read them.
 */
class TableWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }

  eq(other) {
    return other.source === this.source;
  }

  toDOM() {
    const table = document.createElement('table');
    table.className = 'cm-table';

    const rows = this.source.split('\n').filter((l) => l.trim());
    // Row two is the delimiter: dashes, with optional colons for alignment.
    const align = (rows[1] || '').split('|').slice(1, -1).map((cell) => {
      const c = cell.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });

    rows.forEach((line, index) => {
      if (index === 1) return; // the delimiter row is not content
      const cells = line.split('|').slice(1, -1);
      if (!cells.length) return;

      const tr = document.createElement('tr');
      cells.forEach((raw, column) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        cell.style.textAlign = align[column] || 'left';
        fillCell(cell, raw.trim());
        tr.appendChild(cell);
      });
      table.appendChild(tr);
    });

    return table;
  }

  ignoreEvent() {
    return false; // a click puts the caret in, which unfolds the source
  }
}

/** Writes cell text, rendering any inline maths it contains. */
function fillCell(cell, text) {
  let last = 0;
  const inline = /(?<!\\)\$(?!\s)((?:\\.|[^$\\\n])*?[^\s\\]|[^\s$\\])\$/g;
  let match;
  while ((match = inline.exec(text)) !== null) {
    if (match.index > last) {
      cell.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const span = document.createElement('span');
    try {
      katex.render(match[1], span, { throwOnError: true, strict: false, trust: false });
    } catch (_) {
      span.textContent = match[0]; // leave broken maths as its source
    }
    cell.appendChild(span);
    last = match.index + match[0].length;
  }
  // Whatever is left is plain text, added as a text node so it can never be
  // interpreted as markup.
  if (last < text.length) cell.appendChild(document.createTextNode(text.slice(last)));
}

/**
 * A markdown link, drawn as a real link.
 *
 * CodeMirror styles link text but never builds an anchor, so a link looked
 * like one and did nothing. Clicking opens the browser through the same bridge
 * the old renderer used, which allows http and https only.
 */
class LinkWidget extends WidgetType {
  constructor(label, url) {
    super();
    this.label = label;
    this.url = url;
  }

  eq(other) {
    return other.label === this.label && other.url === this.url;
  }

  toDOM() {
    const anchor = document.createElement('a');
    anchor.className = 'cm-link';
    anchor.textContent = this.label;
    anchor.href = this.url;
    anchor.title = this.url;
    anchor.addEventListener('mousedown', (e) => {
      // Without this CodeMirror takes the click and puts the caret here,
      // unfolding the link instead of following it.
      e.preventDefault();
      e.stopPropagation();
      window.sticky.openExternal(this.url);
    });
    return anchor;
  }

  ignoreEvent() {
    return true; // it is a link, not text
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const hr = document.createElement('div');
    hr.className = 'cm-rule';
    return hr;
  }
}

/* ---------- decorations ---------- */

const HIDE = Decoration.replace({});

/** Line classes for blocks that keep their markdown but are styled as blocks. */
const LINE_CLASS = {
  Table: 'cm-md-table',
  Blockquote: 'cm-md-quote',
  FencedCode: 'cm-md-code',
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
};

/** Syntax markers that are noise once their effect is shown. */
const MARKS = new Set([
  'EmphasisMark', 'StrongEmphasisMark', 'HeaderMark', 'LinkMark',
  'QuoteMark', 'StrikethroughMark',
]);

function buildDecorations(state) {
  const sel = state.selection.main;
  const ranges = [];
  const lines = new Set();

  /** Is the caret inside this exact element? The per-node reveal. */
  const cursorInside = (from, to) =>
    !snapshotMode && sel.from >= from && sel.to <= to;

  const addLine = (pos, cls) => {
    const { from } = state.doc.lineAt(pos);
    const key = `${from}:${cls}`;
    if (lines.has(key)) return;
    lines.add(key);
    ranges.push({ from, to: from, line: true, value: Decoration.line({ class: cls }) });
  };

  // --- maths, found by scanning text rather than the syntax tree ---
  const mathSpans = [];
  const text = state.doc.toString();
  MATH.lastIndex = 0;
  let match;
  while ((match = MATH.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    mathSpans.push([from, to]);
    if (cursorInside(from, to)) continue;

    const display = match[1] !== undefined;
    const tex = (display ? match[1] : match[2]).trim();
    if (!tex) continue;

    // A block widget may only replace whole lines.
    const startLine = state.doc.lineAt(from);
    const asBlock = display && from === startLine.from && to === state.doc.lineAt(to).to;
    ranges.push({
      from,
      to,
      value: Decoration.replace({ widget: new MathWidget(tex, display), block: asBlock }),
    });
  }
  const inMath = (pos) => mathSpans.some(([a, b]) => pos >= a && pos < b);

  // --- everything else, from the markdown syntax tree ---
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Table' && !cursorInside(node.from, node.to)) {
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        ranges.push({
          from: first.from,
          to: last.to,
          value: Decoration.replace({
            widget: new TableWidget(state.doc.sliceString(first.from, last.to)),
            block: true,
          }),
        });
        return false; // nothing inside it needs decorating
      }

      const cls = LINE_CLASS[node.name];
      if (cls) {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) addLine(state.doc.line(n).from, cls);
        if (node.name === 'FencedCode') {
          addLine(state.doc.line(first).from, 'cm-md-code-first');
          addLine(state.doc.line(last).from, 'cm-md-code-last');

          // Everything between the fences is the code itself.
          const openLine = state.doc.line(first);
          const body = first + 1 <= last - 1
            ? state.doc.sliceString(state.doc.line(first + 1).from,
                                    state.doc.line(last - 1).to)
            : '';
          if (body.trim()) {
            ranges.push({
              from: openLine.to,
              to: openLine.to,
              value: Decoration.widget({ widget: new CopyButtonWidget(body), side: 1 }),
            });
          }
        }
      }

      // A whole link becomes an anchor, unless the caret is inside it.
      if (node.name === 'Link' && !cursorInside(node.from, node.to)) {
        const raw = state.doc.sliceString(node.from, node.to);
        const parts = /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/.exec(raw);
        if (parts) {
          ranges.push({
            from: node.from,
            to: node.to,
            value: Decoration.replace({
              widget: new LinkWidget(parts[1] || parts[2], parts[2]),
            }),
          });
          return false; // its marks and text are inside the widget now
        }
      }

      // A bare URL in the text is a link too.
      if (node.name === 'URL' && !cursorInside(node.from, node.to)) {
        const url = state.doc.sliceString(node.from, node.to);
        if (/^https?:\/\//i.test(url)) {
          ranges.push({
            from: node.from,
            to: node.to,
            value: Decoration.replace({ widget: new LinkWidget(url, url) }),
          });
          return false;
        }
      }

      // Inline code gets a chip, as the old renderer drew it. The mark spans
      // the backticks too, but those are replaced away, so only the code shows.
      if (node.name === 'InlineCode') {
        ranges.push({
          from: node.from,
          to: node.to,
          value: Decoration.mark({ class: 'cm-inline-code' }),
        });
        return;
      }

      if (node.name === 'CodeInfo') {
        ranges.push({
          from: node.from,
          to: node.to,
          value: Decoration.mark({ class: 'cm-code-lang' }),
        });
        return;
      }

      // The ``` runs are punctuation, not content. Hide them unless the caret
      // is in this block; the language name stays as the block's label.
      if (node.name === 'CodeMark' && node.to - node.from >= 3) {
        const fence = node.node.parent || node;
        if (!cursorInside(fence.from, fence.to)) {
          ranges.push({ from: node.from, to: node.to, value: HIDE });
        }
        return;
      }

      if (inMath(node.from)) return;

      if (node.name === 'HorizontalRule') {
        if (!cursorInside(node.from, node.to)) {
          ranges.push({
            from: node.from,
            to: node.to,
            value: Decoration.replace({ widget: new RuleWidget() }),
          });
        }
        return;
      }

      if (node.name === 'TaskMarker') {
        const item = node.node.parent || node;
        if (!cursorInside(item.from, item.to)) {
          const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
          ranges.push({
            from: node.from,
            to: node.to,
            value: Decoration.replace({
              widget: new CheckboxWidget(checked, node.from, node.to),
            }),
          });
        }
        return;
      }

      if (node.name === 'ListMark') {
        const item = node.node.parent || node;
        const mark = state.doc.sliceString(node.from, node.to);
        if (!/^[-*+]$/.test(mark) || cursorInside(item.from, item.to)) return;

        // A task item shows a checkbox; the dash as well is clutter, so it
        // goes entirely rather than becoming a second marker.
        const isTask = /^\s*\[[ xX]\]/.test(state.doc.sliceString(node.to, node.to + 4));
        ranges.push({
          from: node.from,
          to: node.to,
          value: isTask ? HIDE : Decoration.replace({ widget: new BulletWidget() }),
        });
        return;
      }

      if (node.name === 'CodeMark') {
        // Inline backticks only: hiding a fence would strand its language
        // label and the block's boundaries.
        if (node.to - node.from > 2) return;
        const parent = node.node.parent || node;
        if (!cursorInside(parent.from, parent.to)) {
          ranges.push({ from: node.from, to: node.to, value: HIDE });
        }
        return;
      }

      if (MARKS.has(node.name)) {
        const parent = node.node.parent || node;
        if (cursorInside(parent.from, parent.to)) return;

        // Take the space that follows a heading or quote marker with it.
        // Hiding "#" alone leaves the title indented by one space.
        let to = node.to;
        if (node.name === 'HeaderMark' || node.name === 'QuoteMark') {
          while (state.doc.sliceString(to, to + 1) === ' ') to += 1;
        }
        ranges.push({ from: node.from, to, value: HIDE });
      }
    },
  });

  // Line decorations must sort before the marks that share their position.
  ranges.sort((a, b) => a.from - b.from || (b.line ? 1 : 0) - (a.line ? 1 : 0));
  return Decoration.set(ranges.map((r) => r.value.range(r.from, r.to)), true);
}

/**
 * Decorations live in a state field rather than a view plugin. Display maths
 * replaces a whole line, and CodeMirror only accepts block decorations from a
 * field -- a plugin providing one throws outright.
 */
const livePreview = StateField.define({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection || snapshotDirty) return buildDecorations(tr.state);
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ---------- how markdown reads ---------- */

const markdownStyle = HighlightStyle.define([
  // textDecoration: 'none' is deliberate -- defaultHighlightStyle, loaded for
  // the colours inside code fences, underlines every heading.
  { tag: tags.heading, textDecoration: 'none' },
  { tag: tags.heading1, fontSize: '1.35em', fontWeight: '600', textDecoration: 'none' },
  { tag: tags.heading2, fontSize: '1.18em', fontWeight: '600', textDecoration: 'none' },
  { tag: tags.heading3, fontSize: '1.05em', fontWeight: '600', textDecoration: 'none' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', opacity: '0.6' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, Menlo, monospace' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.url, opacity: '0.7' },
]);

/* ---------- shortcuts ---------- */

/**
 * Bridges the pure edit rules in editor.js into CodeMirror commands, so bold,
 * italic, code and link behave identically to the plain-textarea editor.
 */
function wrapCommand(key) {
  return (view) => {
    const sel = view.state.selection.main;
    const edit = computeEdit(
      { key, metaKey: true },
      view.state.doc.toString(),
      sel.from,
      sel.to
    );
    if (!edit) return false;
    const caret = edit.selStart ?? edit.from + edit.insert.length;
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: caret, head: edit.selEnd ?? caret },
      scrollIntoView: true,
    });
    return true;
  };
}

const shortcuts = [
  { key: 'Mod-b', run: wrapCommand('b') },
  { key: 'Mod-i', run: wrapCommand('i') },
  { key: 'Mod-e', run: wrapCommand('e') },
  { key: 'Mod-k', run: wrapCommand('k') },
];

/* ---------- construction ---------- */

/** Mounts the editor into `parent`; `onChange` receives the text on every edit. */
function createLiveEditor({ parent, doc, onChange }) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        // Ahead of the defaults, so Mod-i and friends are not swallowed.
        Prec.high(keymap.of(shortcuts)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage, codeLanguages }),
        Prec.high(syntaxHighlighting(markdownStyle)),
        syntaxHighlighting(defaultHighlightStyle), // colours inside code fences
        livePreview,
        ghostCompletion(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}

/**
 * Turns snapshot rendering on or off and rebuilds the decorations.
 *
 * The offscreen window used to photograph a note leaves this on permanently:
 * it has no caret and nothing should ever unfold there.
 */
function setSnapshotMode(view, on) {
  snapshotMode = on;
  snapshotDirty = true;
  // A no-op transaction the field will still recompute from.
  view.dispatch({ selection: view.state.selection });
  snapshotDirty = false;
}

/** Renders everything as a reader would see it, for the duration of `fn`. */
async function withSnapshot(view, fn) {
  const rebuild = () => {
    snapshotDirty = true;
    // A no-op transaction the field will still recompute from.
    view.dispatch({ selection: view.state.selection });
    snapshotDirty = false;
  };

  snapshotMode = true;
  rebuild();
  try {
    return await fn();
  } finally {
    snapshotMode = false;
    rebuild();
  }
}
