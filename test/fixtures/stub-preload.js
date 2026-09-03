// Stand-in for the real preload: enough for note.js to boot.
const { contextBridge } = require('electron');
// The note body is injected by scripts/render-check.js, which runs this file
// from a temp directory where a relative require would not resolve.
const BODY = __BODY__;
contextBridge.exposeInMainWorld('sticky', {
  noteId: 'test',
  get: async () => ({ id: 'test', body: BODY, color: 'yellow', fontSize: 15 }),
  update: async () => {}, flush: () => {}, create: async () => {},
  remove: async () => {}, setAlwaysOnTop: async () => {}, close: async () => {},
  openExternal: () => {}, copy: async () => {}, mathMenu: async () => {},
  copyNote: async () => {}, on: () => {},
});
