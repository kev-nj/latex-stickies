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

// Name the Electron shell before launching it, not only at install time.
// postinstall scripts are increasingly blocked -- npm warns about them by
// default now, and plenty of people and companies set ignore-scripts -- and a
// user who installs with them off gets "Electron" in their Dock. Doing it here
// as well means the name is right by the time macOS reads the bundle, whatever
// happened during the install. It returns immediately once done.
try {
  require('../scripts/brand-electron.js');
} catch (_) { /* cosmetic: never block a launch over the name */ }

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
