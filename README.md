# LaTeX Stickies

Sticky notes for your desktop that render LaTeX and Markdown.

Write `$e^{i\pi} + 1 = 0$` in a note and it renders as soon as you click away.
Notes stay where you put them, in the color you chose, across restarts.

```
npx latex-stickies
```

Or install it so it stays around:

```
npm install -g latex-stickies
latex-stickies
```

Requires Node 18+. The first run downloads the Electron runtime (~230 MB), so
give it a minute; later launches are instant.

## Writing in a note

Click a note to edit it, click away to render. `Esc` also leaves edit mode.

**Math** — `$…$` inline, `$$…$$` on its own line. Delimiters have to hug their
content, so ordinary prose like `costs $5 and $6` stays text rather than turning
into a formula. Broken TeX shows the source underlined in red with the parse
error on hover, instead of blanking the note.

**Markdown** — headings, `**bold**`, `*italic*`, `~~strikethrough~~`, lists,
task lists, tables, blockquotes, and links (which open in your browser).

**Code** — fenced blocks are highlighted in 20 languages, with the language
labelled and a copy button on hover:

````
```python
def gaussian(x, mu, sigma):
    return exp(-((x - mu) ** 2) / (2 * sigma ** 2))
```
````

Aliases work as you would expect: `sh`, `shell` and `zsh` all mean bash, `py`
means python, and `tex` means latex. A fence with no language stays plain --
guessing on a two-line snippet is wrong often enough to be worse than nothing.

Inside a fence the editor behaves like a code editor: Enter keeps your
indentation and adds a level after `:` or `{`, Tab and Shift+Tab indent and
dedent (including a whole selection), and brackets and quotes auto-close.
Outside a fence it behaves like a notes field instead -- lists continue on
Enter, and quotes are left alone so `don't` types normally.

## Keyboard

Use `Ctrl` in place of `Cmd` on Windows and Linux.

| | |
|---|---|
| `Cmd+N` | New note |
| `Cmd+W` | Close note |
| `Cmd+Backspace` | Delete note |
| `Cmd+E` | Toggle edit / preview |
| `Cmd+T` | Keep on top |
| `Cmd+±` | Text size |
| `Esc` | Leave edit mode |

## Where notes live

| | |
|---|---|
| macOS | `~/Library/Application Support/latex-stickies/notes.json` |
| Windows | `%APPDATA%\latex-stickies\notes.json` |
| Linux | `~/.config/latex-stickies/notes.json` |

Saves are atomic -- written to a temp file, flushed, then renamed over the
target -- so a crash, a force quit, or pulling the power leaves the previous
good file intact rather than a truncated one. Only one instance runs at a time,
because two copies would hold divergent notes in memory and the last to quit
would silently overwrite the other.

## Development

```
npm install
npm start        # run from source
npm test         # 4 suites, 62 assertions
npm run vendor   # regenerate the bundled Prism
npm run icon     # rebuild the app icon from assets/icon-master.png
```

Artwork lives in `assets/`: `logo.jpeg` is the original, and `icon-master.png`
is the prepared 1024px master the icon is generated from -- transparent ground,
art filling 824 of the canvas, which is the macOS convention that keeps an icon
at the same visual weight as the rest of the Dock.

The renderer loads over `file://` under a strict content-security policy, so
KaTeX, marked, DOMPurify and Prism are vendored into `src/renderer/vendor/`
rather than pulled from a CDN. Note text is sanitized before it reaches the
page, and the renderer talks to disk only through a six-function preload bridge.

To build a macOS `.app` and `.dmg`:

```
npm run dist
```

The build is unsigned, so macOS will warn on other machines unless you sign it
with an Apple Developer ID.

## License

MIT
