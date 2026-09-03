/**
 * Bundle entry for the live-preview editor.
 *
 * CodeMirror 6 ships as ES modules, which cannot be loaded over file:// under
 * the page's `script-src 'self'` policy. esbuild rolls the pieces we use into
 * one classic script that hangs off window.CM, matching how katex, purify and
 * prism are vendored. Run `npm run vendor` after changing this.
 *
 * The language packages are imported statically rather than through
 * @codemirror/language-data, which loads grammars with dynamic import -- that
 * would leave the bundle with chunks it cannot fetch over file://.
 */
import { EditorState, StateField, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
import {
  EditorView, keymap, Decoration, WidgetType, ViewPlugin,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  syntaxTree, HighlightStyle, syntaxHighlighting, defaultHighlightStyle,
  LanguageDescription,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  search, searchKeymap, highlightSelectionMatches, openSearchPanel,
} from '@codemirror/search';

import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { sql } from '@codemirror/lang-sql';

/** What a fence's language name may be written as, mapped to a grammar. */
const codeLanguages = [
  LanguageDescription.of({ name: 'python', alias: ['py'], load: async () => python() }),
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'ts', 'typescript', 'tsx'],
    load: async () => javascript(),
  }),
  LanguageDescription.of({ name: 'json', load: async () => json() }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], load: async () => yaml() }),
  LanguageDescription.of({ name: 'html', alias: ['xml'], load: async () => html() }),
  LanguageDescription.of({ name: 'css', load: async () => css() }),
  LanguageDescription.of({
    name: 'cpp',
    alias: ['c', 'c++', 'h'],
    load: async () => cpp(),
  }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], load: async () => rust() }),
  LanguageDescription.of({ name: 'go', load: async () => go() }),
  LanguageDescription.of({ name: 'java', load: async () => java() }),
  LanguageDescription.of({ name: 'sql', load: async () => sql() }),
];

window.CM = {
  EditorState, StateField, StateEffect, RangeSetBuilder, Prec,
  EditorView, keymap, Decoration, WidgetType, ViewPlugin,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage,
  syntaxTree, HighlightStyle, syntaxHighlighting, defaultHighlightStyle,
  tags, codeLanguages,
  search, searchKeymap, highlightSelectionMatches, openSearchPanel,
};
