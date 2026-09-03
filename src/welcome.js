/**
 * The first note anyone sees.
 *
 * Written in the features it describes, so the app demonstrates itself: every
 * line below renders as you read it, and clicking into any of it shows the
 * markdown that produced it. Kept short enough to fit a default window --
 * a wall of text is not a good first impression for a sticky note.
 */
const WELCOME = [
  '# Welcome to LaTeX Stickies',
  '',
  'Everything renders as you type. Click into a line to see its source.',
  '',
  'Maths goes inline like $e^{i\\pi} + 1 = 0$, or on its own:',
  '',
  '$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$',
  '',
  'Right-click an equation to copy it as an image or as LaTeX.',
  '',
  '## Markdown works',
  '',
  '**bold**, *italic*, `code`, ~~struck through~~',
  '',
  '- [ ] task lists',
  '- tables and code blocks:',
  '',
  '| Symbol | Meaning |',
  '|--------|---------|',
  '| $c$ | speed of light |',
  '| $h$ | Planck |',
  '',
  '```python',
  'print("hover me for a copy button")',
  '```',
  '',
  '## Shortcuts',
  '',
  'Cmd+N new · Cmd+W close · Cmd+Shift+Backspace delete',
  'Cmd+B bold · Cmd+I italic · Cmd+K link',
  'Cmd+T keep on top · Cmd+Shift+C copy note as image',
  '',
  'Notes save themselves. [Source and issues](https://github.com/kev-nj/latex-stickies).',
].join('\n');

module.exports = { WELCOME };
