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
  EditorState, EditorSelection, StateField, StateEffect, EditorView, Decoration,
  WidgetType, ViewPlugin, keymap, Prec,
  defaultKeymap, history, historyKeymap, indentWithTab,
  cursorLineUp, cursorLineDown, selectLineUp, selectLineDown,
  markdown, markdownLanguage, codeLanguages, insertNewlineContinueMarkup,
  syntaxTree, HighlightStyle, syntaxHighlighting, defaultHighlightStyle, tags,
  search, searchKeymap, highlightSelectionMatches,
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
  constructor(code, visible) {
    super();
    this.code = code;
    this.visible = visible;
  }

  eq(other) {
    return other.code === this.code && other.visible === this.visible;
  }

  toDOM() {
    const button = document.createElement('span');
    button.className = this.visible ? 'cm-copy cm-copy-open' : 'cm-copy';
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

/**
 * A syntax marker that is hidden by width rather than removed.
 *
 * Replacing "## " takes it out of the rendered line entirely, so the caret
 * jumps over it and the heading pops between two widths as you arrive. Kept as
 * a mark at font-size 0 the characters stay in the line box and can simply
 * slide back in. Only their width animates -- the heading text beside them
 * already sets the line height -- so CodeMirror's vertical measurements, which
 * drive cursor placement and scrolling, are never in motion.
 *
 * The class never varies. A decoration with a different class is a different
 * decoration, and CodeMirror rebuilds the span rather than restyling it --
 * a brand new element has no previous width to animate from, so the marker
 * snapped back into place. The reveal is `markerReveal` below, which sets a
 * class on the existing element and leaves the decoration alone.
 */
const MARKER = Decoration.mark({ class: 'cm-md-marker' });



/** Elements whose markers are shown while the caret is inside them. */
const REVEAL = new Set([
  'Emphasis', 'StrongEmphasis', 'Strikethrough', 'InlineCode', 'FencedCode',
  'Blockquote', 'ListItem', 'Link',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3',
  'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
]);

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

/**
 * Which fenced block the pointer is over, as its start position, or -1.
 *
 * Each line is its own element with nothing wrapping the block, so there is no
 * element to hang a CSS :hover on -- hovering has to be worked out from the
 * pointer's document position instead.
 */
const setHoveredFence = StateEffect.define();

const hoveredFence = StateField.define({
  create: () => -1,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHoveredFence)) return effect.value;
    return tr.docChanged ? -1 : value;
  },
});

/** Reports the fenced block under the pointer, dispatching only on a change. */
const fenceHover = EditorView.domEventHandlers({
  mousemove(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    let fence = -1;
    if (pos !== null) {
      for (let node = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
        if (node.name === 'FencedCode') {
          fence = node.from;
          break;
        }
      }
    }
    if (fence !== view.state.field(hoveredFence)) {
      view.dispatch({ effects: setHoveredFence.of(fence) });
    }
  },
  mouseleave(_event, view) {
    if (view.state.field(hoveredFence) !== -1) {
      view.dispatch({ effects: setHoveredFence.of(-1) });
    }
  },
});

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
              value: Decoration.widget({
                widget: new CopyButtonWidget(body, state.field(hoveredFence, false) === node.from),
                side: 1,
              }),
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

      // The ``` runs are punctuation, not content. They stay hidden until the
      // caret is on their line; the language name is the block's label.
      if (node.name === 'CodeMark' && node.to - node.from >= 3) {
        ranges.push({ from: node.from, to: node.to, value: MARKER });
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
          value: isTask ? MARKER : Decoration.replace({ widget: new BulletWidget() }),
        });
        return;
      }

      if (node.name === 'CodeMark') {
        // Inline backticks only: hiding a fence would strand its language
        // label and the block's boundaries.
        if (node.to - node.from > 2) return;
        ranges.push({ from: node.from, to: node.to, value: MARKER });
        return;
      }

      if (MARKS.has(node.name)) {
        // Take the space that follows a heading or quote marker with it.
        // Hiding "#" alone leaves the title indented by one space.
        let to = node.to;
        if (node.name === 'HeaderMark' || node.name === 'QuoteMark') {
          while (state.doc.sliceString(to, to + 1) === ' ') to += 1;
        }
        ranges.push({ from: node.from, to, value: MARKER });
      }
    },
  });

  // Line decorations must sort before the marks that share their position.
  ranges.sort((a, b) => a.from - b.from || (b.line ? 1 : 0) - (a.line ? 1 : 0));
  return Decoration.set(ranges.map((r) => r.value.range(r.from, r.to)), true);
}

/**
 * Shows the markers of whichever element the caret is in.
 *
 * This is a plugin rather than a decoration because the reveal has to leave
 * the DOM node alone: change the decoration and CodeMirror builds a new span,
 * which has no width to animate from and snaps. Setting a class on the element
 * already there is what lets it slide.
 *
 * It also asks for a re-measure when the slide finishes. The caret is
 * positioned once, at the start of the transition, so without this it sits a
 * few pixels off the text until the next keystroke -- which reads as a click
 * that did not take.
 */
const markerReveal = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.onEnd = (event) => {
      if (event.target.classList.contains('cm-md-marker')) view.requestMeasure();
    };
    view.contentDOM.addEventListener('transitionend', this.onEnd);
    this.sync();
  }

  update() {
    // Every update, not only the ones that moved the caret. The parser runs
    // behind the keystroke, so the first "#" of a heading arrives as a plain
    // character and becomes a marker on a later update that changed neither
    // the document nor the selection. Skipping those left the reveal one
    // keystroke behind: a heading stayed hidden while it was being typed.
    this.sync();
  }

  destroy() {
    this.view.contentDOM.removeEventListener('transitionend', this.onEnd);
  }

  sync() {
    const { view } = this;
    const sel = view.state.selection.main;
    let from = -1;
    let to = -1;
    if (!snapshotMode) {
      const tree = syntaxTree(view.state);
      // Both sides of the caret, and the side before it first. Typing "###"
      // leaves the caret at the end of the line, where the node *starting*
      // here is the document, not the heading -- so looking forward only, a
      // heading stayed hidden the whole time you were typing it.
      const enclosing = (side) => {
        for (let node = tree.resolveInner(sel.from, side); node; node = node.parent) {
          if (REVEAL.has(node.name) && sel.to <= node.to) return node;
        }
        return null;
      };
      const node = enclosing(-1) || enclosing(1);
      if (node) {
        from = node.from;
        to = node.to;
      }
    }
    for (const el of view.contentDOM.querySelectorAll('.cm-md-marker')) {
      let pos;
      try {
        pos = view.posAtDOM(el);
      } catch (_) {
        continue; // mid-update, and the next sync will catch it
      }
      el.classList.toggle('cm-md-marker-open', pos >= from && pos < to);
    }
  }
});

/**
 * Decorations live in a state field rather than a view plugin. Display maths
 * replaces a whole line, and CodeMirror only accepts block decorations from a
 * field -- a plugin providing one throws outright.
 */
const livePreview = StateField.define({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    const hovered = tr.effects.some((effect) => effect.is(setHoveredFence));
    if (tr.docChanged || tr.selection || hovered || snapshotDirty) {
      return buildDecorations(tr.state);
    }
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

/**
 * ArrowUp and ArrowDown that cannot skip a line.
 *
 * CodeMirror moves the caret by screen geometry, and its measurements assume
 * one text height for the whole document -- a single number, measured once
 * from one short line. This note is not like that: code is smaller than the
 * prose, headings are bigger. When a probe lands in a line's padding rather
 * than on its glyphs, `posAtCoords` does not clamp into that line, it moves to
 * the top of the block and tries again, so one press could clear a whole code
 * block, the heading above it and the table above that.
 *
 * Only vertical motion hits this: it is the one caller that passes a scan
 * direction. The public posAtCoords, used below to find the column, does not.
 *
 * So the built-in command still decides *whether* to move -- it knows about
 * wrapped lines, which this must not break -- and this only pulls the caret
 * back when it has flown past a line it could have landed on.
 *
 * Extending a selection goes through the same geometry, so it gets the same
 * treatment: only the head moves, the anchor is left where the selection
 * started.
 */
function verticalStep(forward, base, extend) {
  return (view) => {
    const { doc } = view.state;
    const start = view.state.selection.main;
    const startLine = doc.lineAt(start.head);
    if (!base(view)) return false;

    const landed = view.state.selection.main;
    const landedNumber = doc.lineAt(landed.head).number;
    const moved = forward ? landedNumber - startLine.number : startLine.number - landedNumber;
    // 0 is a step within a wrapped line, 1 is the next line: both are right.
    if (moved <= 1) return true;

    const next = doc.line(forward ? startLine.number + 1 : startLine.number - 1);

    // A widget standing in for whole lines has nowhere to put a caret, so
    // flying over a table is the correct answer, not a bug to undo.
    const block = view.lineBlockAt(next.from);
    if (block.from !== next.from || block.to !== next.to) return true;

    // Coming up, the caret belongs on the line's last wrapped row.
    const edge = forward ? next.from : next.to;
    const goal = landed.goalColumn ?? start.goalColumn;
    let pos = null;
    if (goal != null) {
      const coords = view.coordsAtPos(edge);
      if (coords) {
        const left = view.contentDOM.getBoundingClientRect().left;
        pos = view.posAtCoords({ x: left + goal, y: (coords.top + coords.bottom) / 2 }, false);
      }
    }
    if (pos == null || doc.lineAt(pos).number !== next.number) {
      pos = Math.min(next.to, next.from + (start.head - startLine.from));
    }

    view.dispatch({
      selection: extend
        ? EditorSelection.range(start.anchor, pos, goal ?? undefined)
        : EditorSelection.cursor(pos, undefined, undefined, goal ?? undefined),
      scrollIntoView: true,
    });
    return true;
  };
}

/**
 * Enter carries a list on: a new bullet, the next number, another empty task
 * box, or a second quote line -- and a second Enter on an item with nothing in
 * it ends the list instead of adding to it.
 *
 * Without this, pressing Enter after "- [ ] milk" left a bare line, and typing
 * "[ ] eggs" there looks like a task and is not one: the box only means
 * anything inside a list item.
 */
const continueList = [{ key: 'Enter', run: insertNewlineContinueMarkup }];

const verticalKeymap = [
  { key: 'ArrowUp', run: verticalStep(false, cursorLineUp), preventDefault: true },
  { key: 'ArrowDown', run: verticalStep(true, cursorLineDown), preventDefault: true },
  { key: 'Shift-ArrowUp', run: verticalStep(false, selectLineUp, true), preventDefault: true },
  { key: 'Shift-ArrowDown', run: verticalStep(true, selectLineDown, true), preventDefault: true },
];

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
        Prec.high(keymap.of(verticalKeymap)),
        Prec.high(keymap.of(continueList)),
        // Search ahead of the defaults: Cmd+F must open the panel rather than
        // fall through to anything else bound to it.
        Prec.high(keymap.of(searchKeymap)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        search({ top: true }),
        highlightSelectionMatches(),
        markdown({ base: markdownLanguage, codeLanguages }),
        Prec.high(syntaxHighlighting(markdownStyle)),
        syntaxHighlighting(defaultHighlightStyle), // colours inside code fences
        hoveredFence,
        livePreview,
        markerReveal,
        fenceHover,
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
