# LaTeX Stickies

[![npm](https://img.shields.io/npm/v/latex-stickies)](https://www.npmjs.com/package/latex-stickies)
[![CI](https://github.com/kev-nj/latex-stickies/actions/workflows/ci.yml/badge.svg)](https://github.com/kev-nj/latex-stickies/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/latex-stickies)](LICENSE)

Sticky notes for your desktop that render LaTeX and Markdown as you type.
macOS, Windows and Linux.

Write `$e^{i\pi} + 1 = 0$` and it becomes the equation. Click into it and the
source comes back. There is no edit mode and no preview mode.

<img src="https://raw.githubusercontent.com/kev-nj/latex-stickies/main/assets/demo.gif" alt="Typing maths, a table, a code block and an autocompleted equation into a note" width="420">

```
npx latex-stickies
```

Or install it so it stays around:

```
npm install -g latex-stickies
latex-stickies
```

If a launch fails, the launcher says so and shows the runtime's own output;
the full log is kept at `~/Library/Logs/latex-stickies/launch.log` on macOS,
`%LOCALAPPDATA%\latex-stickies\` on Windows, and `$XDG_STATE_HOME` (or
`~/.local/state/latex-stickies/`) on Linux.

Requires Node 22.12 or newer. The first run downloads the Electron runtime
(~230 MB), so give it a minute; later launches are instant. On a Mac it also
keeps a copy of the runtime carrying this app's name and icon in
`~/Library/Application Support/latex-stickies/` -- on APFS that is a
copy-on-write clone, so it costs almost no disk. On a Mac you can
download a `.dmg` from [Releases](https://github.com/kev-nj/latex-stickies/releases)
instead and skip Node entirely. It is not signed by Apple, so the first launch
needs a right-click on the app and **Open** rather than a double-click.

## Writing in a note

Everything renders while you write. Put the caret in an element to see the
markdown behind it; move away and it renders again.

**Maths** — `$…$` inline, `$$…$$` on its own line. Delimiters have to hug their
content, so prose like `costs $5 and $6` stays text rather than turning into a
formula. Broken TeX shows the source underlined in red with the parse error on
hover, instead of blanking the note.

**Markdown** — headings, `**bold**`, `*italic*`, `` `code` ``, `~~struck~~`,
quotes, lists, and links that open in your browser. Tables render as tables,
and their cells render maths. Task list checkboxes are clickable: tick one and
`[ ]` becomes `[x]` in the file.

**Code** — fenced blocks are highlighted across eleven languages, labelled with
the language, and each has a copy button.

Inside a fence the editor behaves like a code editor: Enter keeps your
indentation and adds a level after `:` or `{`, Tab and Shift+Tab indent and
dedent, and brackets and quotes auto-close. Outside one it behaves like a notes
field — lists continue on Enter, and quotes are left alone so `don't` types
normally.

**Images of your maths** — right-click a rendered equation for *Copy as Image*
or *Copy LaTeX*. `Cmd+Shift+C` copies the whole note as an image, however long
it is. Both go straight to the clipboard, ready to paste into Slack or an email.

## Autocomplete (optional, local)

A grey suggestion appears after a pause in typing; **Tab** accepts it, **Esc**
dismisses it. It runs entirely on your machine through
[Ollama](https://ollama.com) — nothing is sent anywhere — and is **off by
default**. Turn it on under **Note → Autocomplete**.

Pull a small model. This fires on every pause, so speed matters far more than
size:

```
ollama pull qwen2.5-coder:1.5b
```

Measured on a MacBook: **0.06–0.5s** with that model, against 0.4–3.5s for a
14B — and the small one wrote better prose. Choose yours under **Note →
Autocomplete Model**; installed models are listed with their sizes.

It knows what this app is for. `$$\int_0^1 x^2 dx = ` suggests `\frac{1}{3}$$`,
and `The derivative of $x^2$ is ` suggests `$2x$.`

**`Cmd+Shift+M`** turns a description into LaTeX: select *"integral of e to the
minus x squared from 0 to infinity"* and it becomes
`$\int_{0}^{\infty} e^{-x^2}\,dx$`.

## Keyboard

Use `Ctrl` in place of `Cmd` on Windows and Linux.

| | |
|---|---|
| `Cmd+N` | New note |
| `Cmd+W` | Close note (it stays closed until you reopen it; an empty one is discarded) |
| `Cmd+Shift+Backspace` | Delete note, permanently |
| `Cmd+B` / `Cmd+I` / `Cmd+E` | Bold / italic / code |
| `Cmd+K` | Link |
| `Cmd+F` | Find in note |
| `Cmd+Shift+M` | Maths from a description |
| `Cmd+Shift+C` | Copy note as an image |
| `Cmd+Shift+O` | Open the notes folder |
| `Cmd+T` | Keep on top |
| `Cmd+±` | Text size |

On Windows and Linux the note windows have no menu bar, so the **☰** button
in a note's toolbar opens the same menu. Every command is there.

The **All Notes** menu lists every note you have. A tick means it is on screen;
click to open a note, or click a ticked one to close it. Closing a note is
remembered, so the desk you left is the desk you come back to -- the app
reopens what was on screen rather than every note you have ever written.

## Where notes live

One Markdown file per note, in a folder you can open:

```
~/Documents/LaTeX Stickies/
  shopping-list.md
  lecture-3.md
  .stickies.json      # colours, positions, pinned state
```

They are ordinary files: grep them, keep the folder in git, sync it through
Dropbox, or edit a note in another editor — the open note follows the change.
`Cmd+Shift+O` opens the folder.

Files are named from the note's first line, and renamed if you retitle it. A
file you rename yourself keeps its name. Dropping a `.tex` or `.txt` file into
the folder makes it a note too, and it keeps that extension.

Metadata lives in the sidecar index rather than in frontmatter, so the note
files stay clean — a `.tex` file with YAML at the top would not compile.

Saves are atomic: written to a temp file, flushed, then renamed over the
target, so a crash or force quit leaves the previous file intact rather than a
truncated one. Only one instance runs at a time, because two copies would hold
divergent notes and the last to quit would overwrite the other.

An existing `notes.json` from an older version is migrated the first time and
then left in place.

## Development

```
npm install
npm start        # run from source
npm test         # unit suites
npm run vendor   # rebuild the bundled libraries
npm run icon     # rebuild the app icon from assets/icon-master.png
npm run demo     # re-record assets/demo.gif from the real app (needs ffmpeg)
npm run verify   # install the packed tarball and check what a user gets
npm run dist     # build a macOS .app and .dmg
```

Beyond the unit tests, several checks drive the real app and run in CI on
macOS, Windows and Linux:

```
node scripts/smoke.js             # boots, and stays up
node scripts/smoke.js --lifecycle # closing every note behaves per platform
node scripts/render-check.js      # the first-run note renders correctly
node scripts/ghost-check.js       # autocomplete suggests, and Tab accepts
node scripts/snapshot-check.js    # a long note is captured whole
node scripts/conflict-check.js    # the changed-on-disk banner behaves
node scripts/verify-install.js    # the install path, end to end (macOS)
```

The renderer loads over `file://` under a strict content-security policy, so
CodeMirror and KaTeX are bundled into `src/renderer/vendor/` rather than pulled
from a CDN. Note text is never parsed as HTML, and the renderer reaches the
filesystem and the network only through a narrow preload bridge — Ollama is
called from the main process, so the page keeps `default-src 'none'`.

## License

MIT
