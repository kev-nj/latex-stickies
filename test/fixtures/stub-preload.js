// Stand-in for the real preload: enough for note.js to boot.
const { contextBridge } = require('electron');
const BODY = [
  '# Heading',
  'Some **bold** and *italic* and `code`.',
  'Inline $e^{i\\pi}+1=0$ here.',
  '',
  '$$\\int_0^1 x^2\\,dx$$',
  '',
  '- [ ] task',
  '- bullet',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```python',
  'def f(): return 1',
  '```',
  '',
  // A plain last line, so the caret parking at the end of the document does
  // not sit inside the code block and legitimately unfold it.
  'done.',
].join('\n');
contextBridge.exposeInMainWorld('sticky', {
  noteId: 'test',
  get: async () => ({ id: 'test', body: BODY, color: 'yellow', fontSize: 15 }),
  update: async () => {}, flush: () => {}, create: async () => {},
  remove: async () => {}, setAlwaysOnTop: async () => {}, close: async () => {},
  openExternal: () => {}, copy: async () => {}, mathMenu: async () => {},
  copyNote: async () => {}, on: () => {},
});
