/**
 * Inline autocomplete: a grey continuation after the caret, accepted with Tab.
 *
 * The suggestion is never inserted into the document until it is accepted. It
 * lives in a state field as a decoration, so nothing typed here can be saved to
 * a note by accident, and dismissing it costs nothing.
 *
 * It asks only after a pause, and only in the quiet cases: no suggestion while
 * text is selected, mid-word, or immediately after another suggestion was
 * dismissed. A notes app that interrupts every keystroke is worse than one that
 * never suggests anything.
 */

// Wrapped, because these are classic scripts sharing one global scope: naming
// the same CodeMirror exports here and in live-editor.js is a redeclaration.
let ghostCompletion;
let refreshGhostSettings;

(() => {
// Continue.dev, the closest comparison for local FIM autocomplete, debounces
// at 250-350ms against a ~1024 token prompt budget. The whole industry target
// for a completion is around 500ms, so spending all of it waiting before even
// asking, as an earlier 500ms debounce did, leaves nothing for the model.
const IDLE_MS = 300;
const MIN_CONTEXT = 12; // don't pester at the very start of an empty note
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 600;

let enabled = false;
let model = '';
let timer = null;
let requestId = 0;

/** Turns suggestions on or off; called at startup and when the setting changes. */
refreshGhostSettings = async function refreshGhostSettings() {
  // The bridge may not offer it at all -- an older preload, or the snapshot
  // window. Absent means off, never an error.
  if (!window.sticky || !window.sticky.ai) {
    enabled = false;
    return false;
  }
  const settings = await window.sticky.ai.settings();
  enabled = !!settings.enabled;
  model = settings.model || '';
  return enabled;
};

/* ---------- the suggestion itself ---------- */

const { StateField, StateEffect, EditorView, Decoration, WidgetType, keymap, Prec } = window.CM;

const setGhost = StateEffect.define();
const clearGhost = StateEffect.define();

class GhostWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }

  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define({
  create: () => ({ text: '', pos: -1, deco: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(clearGhost)) {
        return { text: '', pos: -1, deco: Decoration.none };
      }
      if (effect.is(setGhost)) {
        const { text, pos } = effect.value;
        return {
          text,
          pos,
          deco: Decoration.set([
            Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(pos),
          ]),
        };
      }
    }
    // Any edit or cursor move invalidates it.
    if (tr.docChanged || tr.selection) {
      return { text: '', pos: -1, deco: Decoration.none };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

/* ---------- asking ---------- */

function shouldAsk(state) {
  const sel = state.selection.main;
  if (!sel.empty) return false; // not while selecting
  if (sel.from < MIN_CONTEXT) return false;

  // Only at the end of a line or before whitespace -- never in the middle of
  // a word, where a suggestion would be nonsense and the ghost text would sit
  // on top of what is already written.
  const after = state.doc.sliceString(sel.from, sel.from + 1);
  return !after || /\s/.test(after);
}

/**
 * The text either side of the caret, cut at line boundaries.
 *
 * Slicing by character count alone lands mid-word, mid-table-row, or inside a
 * code fence whose opening line has been cut away -- the model then has to
 * guess what it is inside. Snapping to whole lines costs nothing and keeps the
 * context syntactically intact.
 *
 * The note's first line comes along when it would otherwise be cut, since in a
 * long note the heading says what the whole thing is about.
 */
function contextAround(state, pos) {
  const doc = state.doc;

  const startLine = doc.lineAt(Math.max(0, pos - PREFIX_CHARS));
  let prefix = doc.sliceString(startLine.from, pos);

  if (startLine.number > 1) {
    const title = doc.line(1).text.trim();
    // A heading is worth its handful of characters: without it a long note
    // reads to the model as an unlabelled fragment.
    if (title) prefix = `${title}\n...\n${prefix}`;
  }

  const endLine = doc.lineAt(Math.min(doc.length, pos + SUFFIX_CHARS));
  const suffix = doc.sliceString(pos, endLine.to);

  return { prefix, suffix };
}

function requestGhost(view) {
  clearTimeout(timer);
  if (!enabled) return;

  timer = setTimeout(async () => {
    if (!shouldAsk(view.state)) return;
    const sel = view.state.selection.main;
    const { prefix, suffix } = contextAround(view.state, sel.from);

    const id = ++requestId;
    const text = await window.sticky.ai.complete({ prefix, suffix, model });

    // The caret has moved on, or a newer request overtook this one.
    if (id !== requestId || !text) return;
    if (view.state.selection.main.from !== sel.from) return;

    view.dispatch({ effects: setGhost.of({ text, pos: sel.from }) });
  }, IDLE_MS);
}

/* ---------- keys ---------- */

const acceptGhost = (view) => {
  const ghost = view.state.field(ghostField, false);
  if (!ghost || !ghost.text) return false; // let Tab indent as usual
  view.dispatch({
    changes: { from: ghost.pos, to: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: clearGhost.of(null),
  });
  return true;
};

const dismissGhost = (view) => {
  const ghost = view.state.field(ghostField, false);
  if (!ghost || !ghost.text) return false;
  view.dispatch({ effects: clearGhost.of(null) });
  return true;
};

/** The extension to hand CodeMirror. */
ghostCompletion = function ghostCompletion() {
  return [
    ghostField,
    // Ahead of indentWithTab, so Tab takes the suggestion when there is one.
    Prec.highest(keymap.of([
      { key: 'Tab', run: acceptGhost },
      { key: 'Escape', run: dismissGhost },
    ])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) requestGhost(update.view);
    }),
  ];
};
})();
