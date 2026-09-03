/**
 * Live-preview editor, built on CodeMirror 6.
 *
 * There is no edit mode and no preview mode: the note is always editable and
 * always rendered. Maths becomes a KaTeX widget the moment the caret leaves it,
 * and markdown markers hide unless the caret is on their line -- so a note
 * reads as finished text while you are writing it, and shows its source exactly
 * where you are working.
 *
 * The rule for revealing source is "same line as the caret". Obsidian is finer
 * grained about it, but a sticky note is a few lines long, and per-line is
 * predictable in a way that per-node is not: you can always see what you are
 * about to edit.
 */

const {
  EditorState, EditorView, Decoration, WidgetType, ViewPlugin, keymap, Prec,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, syntaxTree, HighlightStyle, syntaxHighlighting, tags,
} = window.CM;

/* ---------- maths ---------- */

// Same delimiter rules as the read-only renderer: `$$…$$` for display, and for
// inline maths the delimiters must hug their content, so prose like
// "costs $5 and $6" is left alone.
const MATH = /\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\s)((?:\\.|[^$\\\n])*?[^\s\\]|[^\s$\\])\$(?!\d)/g;

class MathWidget extends WidgetType {
  constructor(tex, display) {
    super();
    this.tex = tex;
    this.display = display;
  }

  // Without this CodeMirror rebuilds every widget on each keystroke.
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
      // Show the source rather than blanking the line, as the preview does.
      el.className = 'cm-math math-error';
      el.title = err.message;
      el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
    }
    return el;
  }

  // Let clicks through, so putting the caret in an equation reveals its source.
  ignoreEvent() {
    return false;
  }
}

/* ---------- decorations ---------- */

const HIDE = Decoration.replace({});

/** Marks worth hiding. List and quote marks stay: they are the content. */
const HIDEABLE_MARKS = new Set(['EmphasisMark', 'StrongEmphasisMark', 'HeaderMark']);

function buildDecorations(view) {
  const { state } = view;
  const sel = state.selection.main;
  const text = state.doc.toString();
  const ranges = [];
  const mathSpans = [];

  MATH.lastIndex = 0;
  let match;
  while ((match = MATH.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    mathSpans.push([from, to]);

    // While the caret is inside, show the source so it can be edited.
    if (sel.from <= to && sel.to >= from) continue;

    const display = match[1] !== undefined;
    const tex = (display ? match[1] : match[2]).trim();
    if (!tex) continue;

    // A block widget may only replace whole lines; anything else is inline.
    const line = state.doc.lineAt(from);
    const asBlock = display && from === line.from && to === state.doc.lineAt(to).to;

    ranges.push({
      from,
      to,
      value: Decoration.replace({
        widget: new MathWidget(tex, display),
        block: asBlock,
      }),
    });
  }

  const insideMath = (pos) => mathSpans.some(([a, b]) => pos >= a && pos < b);

  syntaxTree(state).iterate({
    enter(node) {
      if (!HIDEABLE_MARKS.has(node.name)) {
        // Inline code backticks only -- hiding a fence would strand its
        // language label and the block's boundaries.
        if (node.name !== 'CodeMark' || node.to - node.from > 2) return;
      }
      if (insideMath(node.from)) return;

      const line = state.doc.lineAt(node.from);
      // Caret on this line: show the markers being worked on.
      if (sel.from <= line.to && sel.to >= line.from) return;

      ranges.push({ from: node.from, to: node.to, value: HIDE });
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges.map((r) => r.value.range(r.from, r.to)), true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/* ---------- how markdown looks ---------- */

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.35em', fontWeight: '600' },
  { tag: tags.heading2, fontSize: '1.18em', fontWeight: '600' },
  { tag: tags.heading3, fontSize: '1.05em', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, Menlo, monospace' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.quote, opacity: '0.85' },
]);

/* ---------- shortcuts ---------- */

/**
 * Bridges the pure edit rules in editor.js into CodeMirror commands, so bold,
 * italic, code and link behave identically whichever editor is in use.
 */
function wrapCommand(key) {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    const edit = computeEdit(
      { key, metaKey: true },
      state.doc.toString(),
      sel.from,
      sel.to
    );
    if (!edit) return false;
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: {
        anchor: edit.selStart ?? edit.from + edit.insert.length,
        head: edit.selEnd ?? edit.selStart ?? edit.from + edit.insert.length,
      },
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

/**
 * Mounts the editor into `parent`. `onChange` is called with the document text
 * whenever it changes.
 */
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
        markdown(),
        syntaxHighlighting(markdownStyle),
        livePreview,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
}
