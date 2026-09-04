const { contextBridge } = require('electron');

const handlers = {};
// The note starts with its title already written, so the first thing the
// viewer sees is the app working rather than a stray "#".
const BODY = '# Lecture 3\n\n';

contextBridge.exposeInMainWorld('sticky', {
  noteId: 'demo',
  get: async () => ({ id: 'demo', body: BODY, color: 'pink', fontSize: 15 }),
  update: async () => {}, flush: () => {}, create: async () => {},
  remove: async () => {}, setAlwaysOnTop: async () => {}, close: async () => {},
  openExternal: () => {}, copy: async () => {}, mathMenu: async () => {},
  copyNote: async () => {},
  on: (channel, fn) => { handlers[channel] = fn; },
  ai: {
    settings: async () => ({ enabled: true, model: 'demo' }),
    // Canned, so the demo does not need a model installed. Both are answers
    // qwen2.5-coder:1.5b actually gives for these prompts.
    complete: async ({ prefix }) => (/is $/.test(prefix) ? '$2x$.' : ''),
    toLatex: async () => ({ latex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}' }),
  },
});

// Lets the driver fire a menu command the way the main process would.
contextBridge.exposeInMainWorld('demo', {
  fire: (channel) => handlers[channel] && handlers[channel](),
});
