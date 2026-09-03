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
  const tag = display ? 'div' : 'span';
  return `<${tag} data-math="${mathChunks.length - 1}"></${tag}>`;
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

/**
 * Renders note text into `target`.
 *
 * Math is spliced in as a DOM operation, never by string replacement. An
 * earlier version substituted `@@MATH0@@` markers in the sanitized HTML string
 * and assigned the result to innerHTML -- but a note could put that marker
 * inside an attribute (`<img title="@@MATH0@@">`), and the KaTeX markup, which
 * carries its own quotes and angle brackets, then broke out of the attribute
 * when the string was re-parsed. That produced live elements DOMPurify had
 * never seen, including an <img> pointing anywhere the author liked. Filling
 * placeholder *elements* after sanitizing keeps every insertion scoped to one
 * node, so nothing can escape into the surrounding markup.
 */
function renderInto(target, src) {
  mathChunks.length = 0;

  target.innerHTML = DOMPurify.sanitize(marked.parse(src), {
    ADD_ATTR: ['target'],
    // `input` stays allowed so GFM task lists keep their checkboxes; DOMPurify
    // strips event handlers and dangerous attributes from it regardless.
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed'],
  });

  target.querySelectorAll('[data-math]').forEach((slot) => {
    const chunk = mathChunks[Number(slot.dataset.math)];
    // KaTeX output is generated locally with trust disabled, and lands inside
    // this one element -- it cannot alter the structure around it.
    if (!chunk) {
      slot.remove();
      return;
    }
    slot.innerHTML = renderMath(chunk);
    // Kept for "Copy LaTeX": the source is not recoverable from KaTeX's output.
    // Set through the DOM, so no escaping question arises.
    slot.dataset.tex = chunk.tex;
    slot.dataset.display = chunk.display ? 'block' : 'inline';
  });
}

/** Markdown source -> HTML string. Serialized from a real DOM, so attribute
 *  values are escaped and re-parsing yields the same tree. */
function renderMarkdown(src) {
  const scratch = document.createElement('div');
  renderInto(scratch, src);
  return scratch.innerHTML;
}
