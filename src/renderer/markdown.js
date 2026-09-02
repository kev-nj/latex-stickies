/**
 * Markdown + LaTeX rendering.
 *
 * Math is registered as marked extensions rather than pre-extracted with a
 * regex, so marked's own tokenizer claims code spans and fences first and
 * `$x$` inside `code` stays literal text.
 *
 * Each math token renders to a placeholder, not to KaTeX HTML directly. That
 * lets DOMPurify run over the markdown output — which may contain raw HTML
 * typed into the note — before the trusted KaTeX markup is spliced in. KaTeX's
 * own output is deliberately not sanitized: it is complex MathML that a
 * sanitizer would mangle, and it is generated locally with trust disabled.
 */

const mathChunks = [];

const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    return src.indexOf('$');
  },
  tokenizer(src) {
    // A single `$`, no newline inside, `\$` escapes out.
    //
    // The delimiters must hug their content: no space after the opening `$`,
    // none before the closing one. That is the usual CommonMark-math rule and
    // it is what keeps prose like "costs $5 and $6 today" from being swallowed
    // as a formula, since the closing candidate there sits after a space.
    const match = /^\$(?!\s)((?:\\.|[^$\\\n])*?[^\s\\]|[^\s$\\])\$(?!\d)/.exec(src);
    if (!match) return;
    return { type: 'inlineMath', raw: match[0], tex: match[1] };
  },
  renderer(token) {
    return placeholder(token.tex, false);
  },
};

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    return src.indexOf('$$');
  },
  tokenizer(src) {
    const match = /^\s*\$\$([\s\S]+?)\$\$\s*(?:\n|$)/.exec(src);
    if (!match) return;
    return { type: 'blockMath', raw: match[0], tex: match[1].trim() };
  },
  renderer(token) {
    return placeholder(token.tex, true);
  },
};

function placeholder(tex, display) {
  mathChunks.push({ tex, display });
  return `@@MATH${mathChunks.length - 1}@@`;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// What people actually type on a fence, mapped to Prism's grammar names.
const LANG_ALIASES = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  py: 'python', js: 'javascript', ts: 'typescript', yml: 'yaml',
  rb: 'ruby', 'c++': 'cpp', tex: 'latex', md: 'markdown',
  html: 'markup', xml: 'markup', tsx: 'jsx',
};

function resolveLang(info) {
  // marked hands over the whole info string, e.g. "python title=demo".
  const raw = (info || '').trim().split(/\s+/)[0].toLowerCase();
  if (!raw) return null;
  const name = LANG_ALIASES[raw] || raw;
  return Prism.languages[name] ? name : null;
}

/**
 * Fenced code blocks. A recognised language gets highlighted; anything else --
 * an unknown language, or a bare ``` with none -- falls back to escaped plain
 * text. Bare fences are deliberately not auto-detected: guessing on a two-line
 * snippet is wrong often enough to be worse than nothing.
 */
function renderCode(token) {
  const lang = resolveLang(token.lang);
  if (!lang) {
    return `<pre><code>${escapeHtml(token.text)}</code></pre>\n`;
  }
  const body = Prism.highlight(token.text, Prism.languages[lang], lang);
  return `<pre data-lang="${lang}"><code class="language-${lang}">${body}</code></pre>\n`;
}

marked.use({
  gfm: true,
  breaks: true, // single newlines are line breaks; notes are not prose documents
  extensions: [inlineMath, blockMath],
  renderer: { code: renderCode },
});

function renderMath(chunk) {
  try {
    return katex.renderToString(chunk.tex, {
      displayMode: chunk.display,
      throwOnError: true,
      strict: false,
      trust: false,
    });
  } catch (err) {
    const label = escapeHtml(chunk.display ? `$$${chunk.tex}$$` : `$${chunk.tex}$`);
    return `<span class="math-error" title="${escapeHtml(err.message)}">${label}</span>`;
  }
}

/** Markdown source -> HTML string, safe to assign to innerHTML. */
function renderMarkdown(src) {
  mathChunks.length = 0;

  const html = DOMPurify.sanitize(marked.parse(src), {
    ADD_ATTR: ['target'],
    // `input` stays allowed so GFM task lists keep their checkboxes; DOMPurify
    // strips event handlers and dangerous attributes from it regardless.
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed'],
  });

  return html.replace(/@@MATH(\d+)@@/g, (whole, i) => {
    const chunk = mathChunks[Number(i)];
    return chunk ? renderMath(chunk) : whole;
  });
}
