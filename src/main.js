const {
  app, BrowserWindow, ipcMain, Menu, clipboard, ClipboardItem, screen, shell,
} = require('electron');
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
  win.on('closed', () => {
    windows.delete(note.id);
    smokeLog(`windows=${windows.size}`);
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

function restoreNotes() {
  const notes = store.all();
  if (notes.length === 0) {
    createNote({ body: WELCOME });
    return;
  }
  notes.forEach(openNote);
}

const { WELCOME } = require('./welcome');

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

ipcMain.handle('note:copyText', (_e, text) => clipboard.writeText(String(text)));

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
