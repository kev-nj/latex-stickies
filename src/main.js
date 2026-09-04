const {
  app, BrowserWindow, dialog, ipcMain, Menu, clipboard, ClipboardItem,
  nativeImage, screen, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

// Pin the identity before anything derives a path from it.
//
// Electron builds userData out of the app name, so the notes directory would
// otherwise follow whatever `name` happens to be in package.json. Renaming the
// package for npm silently moved every note to a new folder and greeted the
// user with an empty desk. Fixing the directory here decouples where notes live
// from what the package is called.
app.setName('LaTeX Stickies');
app.setPath('userData', path.join(app.getPath('appData'), 'latex-stickies'));

// Required after the path is set: store.js resolves notes.json when it loads.
const store = require('./store');
const ai = require('./ai');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

/**
 * Test hook for scripts/smoke.js, inert unless the variable is set.
 *
 * What it enables is the ability to observe the window lifecycle from outside
 * the app: how many notes are open, and closing them all on cue. That is the
 * one thing CI could not reach, and the reason a Windows-only bug -- the app
 * lingering with no windows and no way back -- shipped unnoticed.
 */
const SMOKE_CLOSE_MS = Number(process.env.LATEX_STICKIES_SMOKE_CLOSE_MS) || 0;
const smokeLog = (message) => {
  if (SMOKE_CLOSE_MS) console.log(`SMOKE ${message}`);
};

const COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'];

/** noteId -> BrowserWindow */
const windows = new Map();

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** What to call a note in a menu: its first non-empty line. */
function titleOf(note) {
  const first = (note.body || '').split('\n').find((l) => l.trim());
  if (!first) return 'Untitled note';
  const clean = first.replace(/^#+\s*/, '').trim();
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

/**
 * Deletes the focused note, asking first.
 *
 * The confirmation is a native dialog rather than window.confirm(). These
 * windows are frameless, transparent and often on top, and a web confirm can
 * end up behind the note or invisible -- the delete then blocks on a prompt
 * nobody can see, which looks exactly like the shortcut doing nothing.
 */
async function deleteFocusedNote() {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  const entry = [...windows.entries()].find(([, w]) => w === win);
  if (!entry) return;
  const [id] = entry;

  const note = store.get(id);
  if (note && note.body.trim()) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Delete this note?',
      detail: `"${titleOf(note)}" will be removed from your notes folder. `
        + 'This cannot be undone.',
    });
    if (response !== 0) return;
  }

  store.remove(id);
  if (!win.isDestroyed()) win.destroy();
  buildMenu();
}

function cascadeBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const n = windows.size;
  return {
    x: area.x + 60 + ((n * 28) % 320),
    y: area.y + 60 + ((n * 28) % 320),
    width: 340,
    height: 380,
  };
}

function openExternal(url) {
  // Only real web links; never file:// or custom schemes typed into a note.
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

/**
 * Keeps a note reachable. Bounds are restored verbatim from disk, so a note
 * last placed on a monitor that is no longer attached would open completely
 * off-screen -- present in the file, invisible on the desk, and indistinguishable
 * from a lost note. Fall back to a fresh position when the saved rectangle does
 * not overlap any current display.
 */
function onScreenBounds(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return cascadeBounds();
  }
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width &&
    bounds.x + (bounds.width || 0) > a.x &&
    bounds.y < a.y + a.height &&
    bounds.y + (bounds.height || 0) > a.y);
  return visible ? bounds : { ...cascadeBounds(), width: bounds.width, height: bounds.height };
}

function openNote(note) {
  const existing = windows.get(note.id);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  store.upsert({ id: note.id, open: true });

  const win = new BrowserWindow({
    ...onScreenBounds(note.bounds),
    minWidth: 220,
    minHeight: 160,
    frame: false,
    transparent: true,
    icon: ICON,
    hasShadow: true,
    alwaysOnTop: !!note.alwaysOnTop,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--note-id=${note.id}`],
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'note.html'));

  const persistBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    store.upsert({ id: note.id, bounds: win.getBounds() });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('closed', () => {
    windows.delete(note.id);
    smokeLog(`windows=${windows.size}`);

    // Closing a note is a decision that should survive a restart. Quitting is
    // not: an app that shuts down closes every window, and treating that as
    // "the user closed them all" would greet them with an empty desk.
    if (!quitting) store.upsert({ id: note.id, open: false });

    // macOS apps outlive their windows; the Dock icon is the way back.
    // Elsewhere there is no way back, so an app with no windows is just an
    // invisible process -- and the next launch hands off to it and appears to
    // do nothing. Leave, rather than trusting the quit lifecycle to unwind an
    // event loop that open handles can keep alive.
    if (windows.size === 0 && process.platform !== 'darwin') {
      prepareToExit();
      process.exit(0);
      return;
    }

    buildMenu(); // the tick beside this note in the All Notes menu
  });

  // Links inside a note open in the real browser, never inside the sticky.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // A note must never navigate away from its own page and become a browser.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternal(url);
  });

  windows.set(note.id, win);
  smokeLog(`windows=${windows.size}`);
  return win;
}

function createNote(seed = {}) {
  const note = {
    id: randomId(),
    body: '',
    color: seed.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    fontSize: 15,
    alwaysOnTop: false,
    bounds: cascadeBounds(),
    createdAt: Date.now(),
    ...seed,
  };
  store.upsert(note);
  openNote(note);
  return note;
}

/**
 * Opens the notes that were on screen when the app was last used.
 *
 * Not every note: someone with thirty notes and three on screen wants three
 * windows back, and reopening all of them made closing one pointless. A note
 * closed on purpose stays closed until it is opened again from All Notes.
 */
function restoreNotes() {
  const notes = store.all();
  if (notes.length === 0) {
    createNote({ body: WELCOME });
    return;
  }

  const open = notes.filter((n) => n.open !== false);
  // Never nothing. A launch that puts no window on screen looks like a failed
  // launch, and on Windows it leaves an invisible process with no way back.
  (open.length ? open : [notes[notes.length - 1]]).forEach(openNote);
}

const { WELCOME } = require('./welcome');

async function buildMenu() {
  const saved = store.settings();
  // Only ask Ollama when the feature is on: a cold check on every menu build
  // would add a wait to startup for people who never enable it.
  const { available, models } = saved.aiEnabled
    ? await ai.status()
    : { available: false, models: [] };

  const modelItems = models.map((m) => ({
    label: `${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`,
    type: 'radio',
    checked: m.name === saved.aiModel,
    click: () => {
      store.saveSettings({ aiModel: m.name });
      buildMenu();
      windows.forEach((w) => w.webContents.send('ai-settings-changed'));
    },
  }));

  // Every saved note, so a closed one is not lost until the next launch --
  // until now nothing in the interface said it still existed.
  const noteItems = store.all().map((note) => ({
    label: titleOf(note),
    type: 'checkbox',
    // The tick means "on screen". Since it looks like a checkbox it has to
    // behave like one: clicking a ticked note closes it, rather than the tick
    // being decoration you cannot affect.
    checked: windows.has(note.id),
    click: () => {
      const open = windows.get(note.id);
      if (open && !open.isDestroyed()) open.close();
      else openNote(store.get(note.id) || note);
    },
  }));

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => createNote() },
        {
          label: 'Close Note',
          accelerator: 'CmdOrCtrl+W',
          click: () => BrowserWindow.getFocusedWindow()?.close(),
        },
        { type: 'separator' },
        {
          label: 'Delete Note',
          // Not Cmd+Backspace: that is "delete to start of line" in every
          // macOS text field, and CodeMirror binds it too -- so the editor ate
          // the key, and had it not, reaching for a normal editing shortcut
          // would have destroyed a note with no undo.
          accelerator: 'CmdOrCtrl+Shift+Backspace',
          click: () => deleteFocusedNote(),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Note',
      submenu: [
        {
          label: 'Maths from Description...',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('describe-latex'),
        },
        { type: 'separator' },
        {
          label: 'Find in Note',
          accelerator: 'CmdOrCtrl+F',
          // The editor owns the panel; this entry is for discoverability.
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('find-in-note'),
        },
        { type: 'separator' },
        {
          label: 'Open Notes Folder',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => shell.openPath(store.DIR),
        },
        { type: 'separator' },
        {
          label: 'Autocomplete (Ollama)',
          type: 'checkbox',
          checked: saved.aiEnabled,
          click: async (item) => {
            if (!item.checked) {
              store.saveSettings({ aiEnabled: false });
            } else {
              const found = await ai.status();
              if (!found.available || !found.models.length) {
                item.checked = false;
                dialog.showMessageBox({
                  type: 'info',
                  message: 'Ollama is not running',
                  detail: 'Autocomplete runs entirely on this machine through '
                    + `Ollama, which was not reachable at ${ai.HOST}.\n\n`
                    + 'Start it with "ollama serve", or install it from '
                    + 'ollama.com and pull a model:\n    ollama pull qwen2.5-coder:1.5b',
                  buttons: ['OK'],
                });
                return;
              }
              store.saveSettings({
                aiEnabled: true,
                aiModel: saved.aiModel || ai.pickDefault(found.models),
              });
            }
            await buildMenu(); // the model list only appears once it is on
            windows.forEach((w) => w.webContents.send('ai-settings-changed'));
          },
        },
        {
          label: 'Autocomplete Model',
          // Populated once autocomplete is on and Ollama has answered.
          submenu: modelItems.length
            ? modelItems
            : [{ label: available ? 'No usable models' : 'Turn on autocomplete first',
                 enabled: false }],
        },
        { type: 'separator' },
        {
          label: 'Copy Note as Image',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => BrowserWindow.getFocusedWindow()
            ?.webContents.send('copy-note-image'),
        },
        { type: 'separator' },
        {
          label: 'Always on Top',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            const next = !win.isAlwaysOnTop();
            win.setAlwaysOnTop(next);
            win.webContents.send('always-on-top-changed', next);
          },
        },
        { type: 'separator' },
        {
          label: 'Bigger Text',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('font-size', 1),
        },
        {
          label: 'Smaller Text',
          accelerator: 'CmdOrCtrl+-',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('font-size', -1),
        },
      ],
    },
    {
      // "All Notes", not "Notes": it sits beside the "Note" menu, and two
      // near-identical names for the current note and the list of every note
      // is a coin toss every time you reach for one.
      label: 'All Notes',
      submenu: noteItems.length
        ? noteItems
        : [{ label: 'No notes yet', enabled: false }],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        {
          label: 'Bring All Notes to Front',
          click: () => windows.forEach((w) => w.show()),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every instance reads and writes the same notes.json, so a second one is not
// just clutter -- two copies hold divergent state in memory and the last to
// save wins, silently losing notes. Refuse to start twice; surface the notes
// that are already running instead.
if (!app.requestSingleInstanceLock()) {
  // Leave before any window or handler is set up. Relying on quit() alone to
  // unwind a half-initialised second instance is how two processes end up
  // touching notes.json at once.
  app.exit(0);
}

/**
 * Brings the notes back to the front -- from a Dock click on macOS, or from a
 * second launch anywhere.
 *
 * Reopening from disk when nothing is on screen is the important half. Without
 * it, launching again while a note-less instance was alive iterated an empty
 * set of windows and did nothing at all, so the app looked hung: the launcher
 * reported it was running, and no window ever appeared.
 */
function surfaceNotes() {
  if (windows.size === 0) {
    restoreNotes();
    return;
  }
  windows.forEach((win) => {
    if (win.isMinimized()) win.restore();
    win.show();
  });
}

app.on('second-instance', surfaceNotes);

/**
 * Follows edits made to the note files by anything else -- another editor,
 * Dropbox, a git checkout. The open window updates in place rather than
 * quietly overwriting what was changed on disk.
 */
let stopWatchingNotes = null;
/** Set while the app is shutting down, so closing windows is not a choice. */
let quitting = false;

/**
 * Everything that must happen before the process goes away.
 *
 * Synchronous on purpose: it runs immediately before process.exit(), which
 * gives nothing asynchronous a chance to finish. The watcher is closed first
 * because its handle is what keeps the event loop -- and so the invisible
 * process -- alive after the last window has gone.
 */
function prepareToExit() {
  quitting = true;
  // Nothing here may throw. The caller's next statement is process.exit(), and
  // an exception thrown on the way out skips it -- leaving exactly the
  // invisible, unreachable process this whole path exists to prevent. Saving
  // is worth attempting; it is not worth staying alive for.
  try {
    if (stopWatchingNotes) {
      stopWatchingNotes();
      stopWatchingNotes = null;
    }
  } catch (err) {
    console.error('could not stop watching the notes folder', err);
  }
  try {
    store.saveNow();
  } catch (err) {
    console.error('could not save on the way out', err);
  }
}

function watchNotesFolder() {
  stopWatchingNotes = store.watch((changed) => {
    for (const note of changed) {
      const win = windows.get(note.id);
      if (win && !win.isDestroyed()) win.webContents.send('note-changed', note.body);
    }
  });
}

app.whenReady().then(async () => {
  // Run from npm there is no .app bundle of our own to carry the icon, so
  // macOS would show the generic Electron atom in the Dock. Set it explicitly.
  //
  // Keyed on the file existing, not on app.isPackaged. Naming the Dock entry
  // means renaming the executable inside the vendored Electron.app, and
  // isPackaged is derived from that executable's name -- so an npm install
  // started reporting itself as packaged, this branch stopped running, and
  // fixing the name cost the icon. A packaged build has no build/ directory
  // inside it, which is the same condition, tested directly.
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON)) {
    try {
      const image = nativeImage.createFromBuffer(fs.readFileSync(ICON));
      if (!image.isEmpty()) app.dock.setIcon(image);
    } catch (err) {
      console.error('could not set dock icon', err);
    }
  }

  await buildMenu();
  restoreNotes();
  watchNotesFolder();

  if (SMOKE_CLOSE_MS) {
    setTimeout(() => {
      smokeLog('closing every note');
      [...windows.values()].forEach((win) => win.close());
    }, SMOKE_CLOSE_MS);
  }

  app.on('activate', surfaceNotes);
});

// macOS apps outlive their windows -- that is how Stickies behaves, and the
// Dock icon is the way back. Windows and Linux have no such affordance: the
// process lingered invisibly with no way to reach it, and the next launch
// handed off to it and appeared to do nothing. Quit there instead. The notes
// are already on disk and come back on the next launch.
// Belt and braces: the window 'closed' handler above normally gets there
// first, but this catches any window torn down by another route.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    prepareToExit();
    process.exit(0);
  }
});
app.on('before-quit', prepareToExit);

ipcMain.handle('note:get', (_e, id) => store.get(id));
let titleTimer = null;
let lastTitles = '';

/** Rebuilds the Notes menu when a title changes, at a human pace. */
function refreshNoteTitles() {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    const titles = store.all().map(titleOf).join('\u0000');
    if (titles === lastTitles) return;
    lastTitles = titles;
    buildMenu();
  }, 800);
}

ipcMain.handle('note:update', (_e, patch) => {
  store.upsert(patch);
  if (patch && patch.body !== undefined) refreshNoteTitles();
});

// A closing note flushes its last edit here. Write straight through rather than
// joining the debounce: the window is already going away.
ipcMain.on('note:flush', (e, patch) => {
  if (patch && patch.id) {
    store.upsert(patch);
    store.saveNow();
  }
  e.returnValue = true;
});
ipcMain.handle('note:new', () => {
  const id = createNote().id;
  buildMenu();
  return id;
});

ipcMain.handle('note:delete', (_e, id) => {
  store.remove(id);
  const win = windows.get(id);
  if (win && !win.isDestroyed()) win.destroy();
  buildMenu();
});

ipcMain.handle('note:setAlwaysOnTop', (e, value) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setAlwaysOnTop(!!value);
});

ipcMain.handle('note:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

/**
 * Right-click menu for a rendered equation.
 *
 * "Copy as Image" screenshots just the equation's rectangle out of the live
 * window. KaTeX draws with HTML and fonts rather than emitting a picture, so
 * capturing what is already on screen is both the simplest route to a
 * pasteable image and the one guaranteed to match what the note shows.
 *
 * Resolves once the menu closes, so the renderer knows when to drop the
 * temporary capture styling.
 */
ipcMain.handle('note:mathMenu', (e, { rect, tex } = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;

  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Copy as Image',
        enabled: !!rect,
        click: async () => {
          try {
            // capturePage stalls on macOS when the window is not frontmost.
            // Right-clicking a note focuses it, but make that explicit.
            if (!win.isFocused()) win.focus();
            // capturePage wants whole pixels inside the page. It captures at
            // the display's scale factor, so this comes back at 2x on Retina.
            const image = await win.webContents.capturePage({
              x: Math.max(0, Math.floor(rect.x)),
              y: Math.max(0, Math.floor(rect.y)),
              width: Math.max(1, Math.ceil(rect.width)),
              height: Math.max(1, Math.ceil(rect.height)),
            });
            await copyImage(image);
          } catch (err) {
            console.error('could not copy the equation as an image', err);
          }
        },
      },
      {
        label: 'Copy LaTeX',
        enabled: !!tex,
        click: () => {
          Promise.resolve(clipboard.writeText(tex)).catch((err) =>
            console.error('could not copy the LaTeX source', err));
        },
      },
      { type: 'separator' },
      {
        label: 'Copy Note as Image',
        // The renderer has to hide the toolbar and measure the content first.
        click: () => win.webContents.send('copy-note-image'),
      },
    ]);
    menu.popup({ window: win, callback: () => resolve(null) });
  });
});

ipcMain.handle('note:openExternal', (_e, url) => openExternal(url));

/**
 * Pops the application menu open at the toolbar button.
 *
 * frame: false means Windows and Linux draw no menu bar, so every command
 * behind it was reachable only by a shortcut someone had to already know.
 * The same menu, so accelerators and this stay in step by construction.
 */
ipcMain.on('app:show-menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const menu = Menu.getApplicationMenu();
  if (win && menu) menu.popup({ window: win, x: 8, y: 26 });
});

ipcMain.handle('note:copyText', (_e, text) => clipboard.writeText(String(text)));

/**
 * Whether autocomplete is on, and with which model.
 *
 * Off unless Ollama is actually answering: the feature is optional, and a
 * setting that promises something the machine cannot do is worse than no
 * setting at all.
 */
ipcMain.handle('ai:settings', async () => {
  const saved = store.settings();
  if (!saved.aiEnabled) return { enabled: false };

  const { available, models } = await ai.status();
  if (!available || !models.length) return { enabled: false, reason: 'ollama-unreachable' };

  // models are { name, size } objects; the setting is a name. Fall back to a
  // sensible pick if the chosen model has been removed.
  const names = models.map((m) => m.name);
  const model = names.includes(saved.aiModel) ? saved.aiModel : ai.pickDefault(models);
  if (model !== saved.aiModel) store.saveSettings({ aiModel: model });
  return { enabled: true, model };
});

ipcMain.handle('ai:complete', (_e, payload) => ai.complete(payload || {}));

ipcMain.handle('ai:toLatex', async (_e, { text } = {}) => {
  const saved = store.settings();
  const { available, models } = await ai.status();
  if (!available || !models.length) return { error: 'ollama-unreachable' };
  const names = models.map((m) => m.name);
  const model = names.includes(saved.aiModel) ? saved.aiModel : ai.pickDefault(models);
  return { latex: await ai.toLatex({ text, model }) };
});

/**
 * Puts a PNG on the clipboard.
 *
 * Electron 44 replaced the clipboard with the async, web-shaped API: there is
 * no writeImage, and write() takes ClipboardItems. The older call fails
 * silently rather than throwing, so everything image-related goes through here.
 */
async function copyImage(image) {
  if (!image || image.isEmpty()) throw new Error('captured an empty image');
  await clipboard.write([new ClipboardItem({ 'image/png': image.toPNG() })]);
}

/**
 * Screenshots a whole note.
 *
 * A note can hold more than its window shows, and a picture that stops at the
 * scroll line is not the note. So the window is grown to fit its content for
 * the capture and put straight back -- capped to the display, since a very long
 * note would otherwise ask for a window taller than the screen.
 */
/**
 * Screenshots a whole note, however long it is.
 *
 * The note's own window cannot do this: macOS clamps a window to the display,
 * and the editor only renders the lines it believes are on screen, so a note
 * taller than the screen came out cut off. Instead the note is opened again in
 * an offscreen window -- which has no such limit -- sized to its full content,
 * and that is what gets photographed.
 *
 * The offscreen page is the same note.html loading the same note id, so the
 * picture cannot drift from what the real window shows.
 */
ipcMain.handle('note:copyNote', async (e, { width } = {}) => {
  const source = BrowserWindow.fromWebContents(e.sender);
  const entry = [...windows.entries()].find(([, w]) => w === source);
  if (!source || !entry) return null;
  const noteId = entry[0];

  const shot = new BrowserWindow({
    width: width || source.getBounds().width,
    height: 800, // resized once the page reports how tall it really is
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--note-id=${noteId}`, '--snapshot'],
    },
  });

  try {
    const height = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the note never reported its height')), 8000);
      ipcMain.once('note:snapshotReady', (_event, reported) => {
        clearTimeout(timer);
        resolve(Math.ceil(reported) || 800);
      });
      shot.loadFile(path.join(__dirname, 'renderer', 'note.html')).catch(reject);
    });

    shot.setBounds({ ...shot.getBounds(), height });
    // Let the editor fill in the lines the taller viewport now covers.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await copyImage(await shot.webContents.capturePage());
  } catch (err) {
    console.error('could not copy the note as an image', err);
  } finally {
    if (!shot.isDestroyed()) shot.destroy();
  }
  return null;
});
