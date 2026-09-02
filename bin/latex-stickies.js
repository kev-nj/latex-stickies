#!/usr/bin/env node
/**
 * Launcher for `npx latex-stickies`.
 *
 * The `electron` package exports the path to the platform's Electron binary.
 * We spawn it against this package's own directory, detached, so the notes
 * keep running after the terminal that started them is closed -- a sticky
 * note that dies with your shell is not a sticky note.
 */
const { spawn } = require('child_process');
const path = require('path');

let electron;
try {
  electron = require('electron');
} catch (_) {
  console.error(
    'Could not find the Electron runtime.\n' +
    'Reinstall with: npm install -g latex-stickies'
  );
  process.exit(1);
}

const appDir = path.join(__dirname, '..');
const child = spawn(electron, [appDir, ...process.argv.slice(2)], {
  detached: true,
  stdio: 'ignore',
});

child.on('error', (err) => {
  console.error('Failed to launch LaTeX Stickies:', err.message);
  process.exit(1);
});

child.unref();
console.log('LaTeX Stickies is running. Close the notes to quit.');
