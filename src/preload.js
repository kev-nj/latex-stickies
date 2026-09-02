const { contextBridge, ipcRenderer, clipboard } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--note-id='));
const noteId = arg ? arg.slice('--note-id='.length) : null;

contextBridge.exposeInMainWorld('sticky', {
  noteId,
  get: () => ipcRenderer.invoke('note:get', noteId),
  update: (patch) => ipcRenderer.invoke('note:update', { id: noteId, ...patch }),
  create: () => ipcRenderer.invoke('note:new'),
  remove: () => ipcRenderer.invoke('note:delete', noteId),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('note:setAlwaysOnTop', v),
  close: () => ipcRenderer.invoke('note:close'),
  openExternal: (url) => ipcRenderer.invoke('note:openExternal', url),
  // Electron's clipboard rather than navigator.clipboard, which is
  // unreliable for a page served over file://.
  copy: (text) => clipboard.writeText(String(text)),
  on: (channel, fn) => {
    const allowed = ['toggle-edit', 'request-delete', 'font-size', 'always-on-top-changed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
