/**
 * Bundle entry for the live-preview editor.
 *
 * CodeMirror 6 ships as ES modules, which cannot be loaded over file:// under
 * the page's `script-src 'self'` policy. esbuild rolls the pieces we use into
 * one classic script that hangs off window.CM, matching how katex, marked,
 * purify and prism are vendored. Run `npm run vendor` after changing this.
 */
import { EditorState, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
import {
  EditorView, keymap, Decoration, WidgetType, ViewPlugin, drawSelection,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

window.CM = {
  EditorState, StateEffect, RangeSetBuilder, Prec,
  EditorView, keymap, Decoration, WidgetType, ViewPlugin, drawSelection,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, syntaxTree, HighlightStyle, syntaxHighlighting, tags,
};
