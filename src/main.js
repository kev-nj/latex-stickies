const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
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

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

const COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'];

/** noteId -> BrowserWindow */
const windows = new Map();

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  win.on('closed', () => windows.delete(note.id));

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

function restoreNotes() {
  const notes = store.all();
  if (notes.length === 0) {
    createNote({ body: WELCOME });
    return;
  }
  notes.forEach(openNote);
}

const WELCOME = [
  '# Welcome to LaTeX Stickies',
  '',
  'Type math inline like $e^{i\\pi} + 1 = 0$, or on its own line:',
  '',
  '$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$',
  '',
  'Markdown works too:',
  '',
  '- **bold**, *italic*, `code`, ~~strikethrough~~',
  '- [ ] task lists',
  '- > blockquotes, tables, and fenced code blocks',
  '',
  'Click the note to edit, click outside to render.',
  'Cmd+N new note · Cmd+E toggle edit · Cmd+T always on top',
].join('\n');

function buildMenu() {
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
          accelerator: 'CmdOrCtrl+Backspace',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('request-delete');
          },
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Note',
      submenu: [
        {
          label: 'Toggle Edit / Preview',
          accelerator: 'CmdOrCtrl+E',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('toggle-edit'),
        },
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

app.whenReady().then(() => {
  // Run from npm there is no .app bundle to carry the icon, so macOS would show
  // the generic Electron atom in the Dock. Set it explicitly.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(ICON);
    } catch (err) {
      console.error('could not set dock icon', err);
    }
  }

  buildMenu();
  restoreNotes();

  app.on('activate', surfaceNotes);
});

// macOS apps outlive their windows -- that is how Stickies behaves, and the
// Dock icon is the way back. Windows and Linux have no such affordance: the
// process lingered invisibly with no way to reach it, and the next launch
// handed off to it and appeared to do nothing. Quit there instead. The notes
// are already on disk and come back on the next launch.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => store.saveNow());

ipcMain.handle('note:get', (_e, id) => store.get(id));
ipcMain.handle('note:update', (_e, patch) => store.upsert(patch));

// A closing note flushes its last edit here. Write straight through rather than
// joining the debounce: the window is already going away.
ipcMain.on('note:flush', (e, patch) => {
  if (patch && patch.id) {
    store.upsert(patch);
    store.saveNow();
  }
  e.returnValue = true;
});
ipcMain.handle('note:new', () => createNote().id);

ipcMain.handle('note:delete', (_e, id) => {
  store.remove(id);
  const win = windows.get(id);
  if (win && !win.isDestroyed()) win.destroy();
});

ipcMain.handle('note:setAlwaysOnTop', (e, value) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setAlwaysOnTop(!!value);
});

ipcMain.handle('note:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

ipcMain.handle('note:openExternal', (_e, url) => openExternal(url));
