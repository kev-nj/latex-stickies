const { contextBridge, ipcRenderer } = require('electron');

const snapshot = process.argv.includes('--snapshot');
const arg = process.argv.find((a) => a.startsWith('--note-id='));
const noteId = arg ? arg.slice('--note-id='.length) : null;

contextBridge.exposeInMainWorld('sticky', {
  noteId,
  // True in the offscreen window used to photograph a note. That window is
  // not display-limited, so a note longer than the screen can be captured
  // whole -- which the visible window can never do.
  isSnapshot: snapshot,
  snapshotReady: (height) => ipcRenderer.send('note:snapshotReady', height),
  get: () => ipcRenderer.invoke('note:get', noteId),
  update: (patch) => ipcRenderer.invoke('note:update', { id: noteId, ...patch }),
  create: () => ipcRenderer.invoke('note:new'),
  remove: () => ipcRenderer.invoke('note:delete', noteId),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('note:setAlwaysOnTop', v),
  close: () => ipcRenderer.invoke('note:close'),
  openExternal: (url) => ipcRenderer.invoke('note:openExternal', url),
  // Routed through the main process rather than written here. The clipboard
  // API differs between processes and changed shape in Electron 44; this way
  // every copy in the app goes through one implementation that is known to
  // work, instead of a second one nobody tested.
  copy: (text) => ipcRenderer.invoke('note:copyText', String(text)),
  // Synchronous on purpose. This is called while the window is being torn
  // down, where an async invoke() would race the renderer's destruction and
  // lose the edit. sendSync blocks until main has the text.
  flush: (body) => ipcRenderer.sendSync('note:flush', { id: noteId, body }),
  mathMenu: (payload) => ipcRenderer.invoke('note:mathMenu', payload),
  copyNote: (payload) => ipcRenderer.invoke('note:copyNote', payload),
  // These windows are frameless, so on Windows and Linux there is no menu
  // bar at all. This is the way in.
  openAppMenu: () => ipcRenderer.send('app:show-menu'),

  // Optional, local-only autocomplete. Requests are made in the main process:
  // this page cannot reach the network, and should not be able to.
  ai: {
    settings: () => ipcRenderer.invoke('ai:settings'),
    complete: (payload) => ipcRenderer.invoke('ai:complete', payload),
    toLatex: (payload) => ipcRenderer.invoke('ai:toLatex', payload),
  },
  on: (channel, fn) => {
    const allowed = [
      'font-size', 'always-on-top-changed',
      'copy-note-image', 'ai-settings-changed', 'note-changed', 'note-conflict',
      'find-in-note', 'describe-latex',
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
