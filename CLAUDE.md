# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start        # run from source
npm test         # every suite in test/
npm run verify   # install the packed tarball and check what a user gets (macOS)
npm run vendor   # rebuild src/renderer/vendor/ after changing CodeMirror/KaTeX/marked
npm run icon     # rebuild build/icon.icns from assets/icon-master.png
npm run demo     # re-record assets/demo.gif by driving the real app (needs ffmpeg)
npm run dist     # build the macOS .app, .dmg and .zip
npm run install-app   # dist, then replace /Applications/LaTeX Stickies.app
```

One suite: `node test/store.test.js`. Each is a plain Node script printing
`PASS`/`FAIL` lines and exiting non-zero — no framework, no watch mode.

Checks that drive the real app, all of which run in CI:

```
node scripts/smoke.js              # boots and stays up
node scripts/smoke.js --lifecycle  # closing every note behaves per platform
node scripts/render-check.js       # live preview actually rendered
node scripts/ghost-check.js        # autocomplete suggests, Tab accepts
node scripts/snapshot-check.js     # a long note is captured whole
node scripts/conflict-check.js     # the changed-on-disk banner behaves
node scripts/verify-install.js     # the npm install path, end to end
```

**Quit the app before running any of them.** A single-instance lock means a
running copy makes a second launch exit 0 immediately, which reads as a
mysterious failure.

## Architecture

**Main process** (`src/main.js`) owns windows, menus, the store and every
privileged operation. It pins `app.setName` and `app.setPath('userData')`
before requiring `store.js`, because Electron derives userData from the app
name and renaming the package once moved everyone's notes.

**Renderer** (`src/renderer/`) is one page per note, loaded over `file://`
under `default-src 'none'`. It reaches the filesystem, the clipboard and the
network only through `src/preload.js`. Ollama is called from the main process
so the page keeps that policy — never add `connect-src`.

Because the CSP forbids remote code and ES modules fail over `file://`,
CodeMirror and KaTeX are bundled into `src/renderer/vendor/` by
`scripts/vendor.js` and loaded as classic scripts. They therefore share one
global scope: `live-editor.js` and `ghost.js` both wrap themselves in an IIFE
to avoid redeclaring the same CodeMirror exports.

**Live preview** (`src/renderer/live-editor.js`) is CodeMirror decorations, not
a preview pane. Elements render in place and reveal their source when the caret
is inside them (`cursorInside`). Block-level decorations need a `StateField`
rather than a `ViewPlugin`. CodeMirror injects its own stylesheet *after* ours,
which has been the cause of several visual bugs — reach for specificity before
assuming a logic error.

**Storage** (`src/store.js`) is one Markdown file per note in
`~/Documents/LaTeX Stickies/`, with ids, colours, bounds and the open flag in a
`.stickies.json` sidecar. Metadata is deliberately not frontmatter: YAML at the
top of a `.tex` file stops it compiling. Writes are atomic (temp, fsync,
rename). `LATEX_STICKIES_NOTES_DIR` overrides the directory for harnesses.

Two invariants that have each cost a bug:

- A note's identity lives in the index, keyed by filename. Anything that
  renames a file must write the index in the same breath — a reload in between
  gives the file a fresh id and orphans the window still holding the old one,
  whose next keystroke writes a second copy of the note.
- `store.watch()` returns a cleanup function that must be called before exit.
  An open `fs.watch` handle keeps the event loop alive, and on Windows that
  leaves an invisible process the next launch hands off to.

## macOS branding

`scripts/brand-electron.js` clones the Electron shell to
`~/Library/Application Support/latex-stickies/LaTeX Stickies.app` and brands it
there; the launcher spawns that copy. This took seven releases to get right, so
before changing it:

- The Dock label comes from the **running executable**, not only the plist.
  Renaming `Contents/MacOS/Electron` is the step that actually works.
- Renaming that executable makes `app.isPackaged` return true — it is a
  basename comparison — so never gate anything on it. Helpers keep their names,
  so main and renderer disagree about it.
- LaunchServices keys records by **path and bundle identifier**. A path
  registered as "Electron" keeps serving that name back, and the shared
  `com.github.Electron` identifier can resolve to another app's record.
- Any edit under `Contents/` invalidates the signature, and an unsigned bundle
  will not launch on Apple Silicon. Re-sign without `--deep`, preserving
  metadata.
- Branding must run at **launch**, not only `postinstall`: npm 11 blocks
  install scripts for global installs by default.
- Never edit the vendored `node_modules` copy. npx installs under a fresh cache
  hash each time and `npm update electron` reverts it.

## Verifying

The install path is the one that breaks. A checkout runs from source and a
built `.app` is branded by electron-builder, so neither resembles what a user
gets — six consecutive releases shipped a bug that looked fine in both. Run
`npm run verify` before publishing anything that touches the launcher, the
branding or the `files` allowlist, and against a cold cache
(`rm -rf ~/.npm/_npx`) when the symptom is caching.

Claims about the app's identity should come from `lsappinfo info -only name
<pid>`, which reads what macOS believes, rather than from the plist, which is
only what we wrote.

## Releasing

`npm version <patch|minor|major>`, `git push --follow-tags`, then `npm publish`
(the user's step — it needs browser 2FA). `prepublishOnly` runs the suites.
`.dmg` and `.zip` are built locally and attached to a GitHub release by hand;
GitHub builds nothing. npm updates itself on next run, the `.dmg` never does.

A tag may be moved while nothing has consumed it — no release, not published.
Once either is true it is frozen; deleting a tag under a published release
demotes that release to a draft.

## Conventions

Comments explain **why**, especially where the obvious approach was tried and
failed; several read as historical notes on purpose. No emoji. Nothing in this
repository — commits, PRs, files — mentions AI assistance or carries
`Co-Authored-By`.
