#!/usr/bin/env node
/**
 * Launcher for `npx latex-stickies`.
 *
 * The `electron` package exports the path to the platform's Electron binary.
 * We spawn it against this package's own directory, detached, so the notes
 * keep running after the terminal that started them is closed -- a sticky
 * note that dies with your shell is not a sticky note.
 *
 * Detached, but not unwatched. This used to print "LaTeX Stickies is running"
 * the instant it had spawned something, with output going to /dev/null, so a
 * runtime that started and died a moment later -- a missing shared library, a
 * half-downloaded Electron, root without --no-sandbox -- reported success and
 * left nothing behind to read. The launcher now keeps the child for a couple
 * of seconds and says what happened if it does not survive.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** How long a launch has to survive before we call it a launch. */
const STARTUP_MS = 2000;
/** How much of the log to show when it does not. */
const LOG_TAIL_LINES = 20;
/** Kept from growing without bound: each launch starts a fresh log. */
const LOG_NAME = 'launch.log';

// Brand before resolving anything: this returns the path to a copy of the
// Electron shell carrying our name and icon, kept outside node_modules so it
// survives npx cache churn and npm ci. Falls back to the plain shell, which
// runs identically and only looks wrong in the Dock.
//
// postinstall cannot be relied on for this -- npm 11 warns about install
// scripts by default and blocks them outright for global installs, and plenty
// of people and companies turn them off.
let electron = null;
try {
  electron = require('../scripts/brand-electron.js').ensure();
} catch (err) {
  console.error(`could not brand the app: ${err.message}`);
}

if (!electron) {
  try {
    electron = require('electron');
  } catch (_) {
    console.error(
      'Could not find the Electron runtime.\n' +
      'Reinstall with: npm install -g latex-stickies'
    );
    process.exit(1);
  }
}

/** Where this platform expects a log to live. */
function logDirectory() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'latex-stickies');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA
      || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'latex-stickies');
  }
  const base = process.env.XDG_STATE_HOME
    || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'latex-stickies');
}

/**
 * Opens the log the app's output goes to.
 *
 * Truncated on every launch rather than appended to: it exists to explain the
 * launch that just failed, and that keeps it bounded without any rotation.
 * If it cannot be opened -- a read-only home, an odd container -- the launch
 * still goes ahead with the output discarded, because a missing log is a far
 * smaller problem than refusing to start.
 */
function openLog() {
  try {
    const dir = logDirectory();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_NAME);
    return { file, fd: fs.openSync(file, 'w') };
  } catch (_) {
    return { file: null, fd: 'ignore' };
  }
}

/** The tail of the log, for a failure message. */
function logTail(file) {
  if (!file) return '';
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch (_) {
    return '';
  }
}

const { file: logFile, fd: logFd } = openLog();

const appDir = path.join(__dirname, '..');
const child = spawn(electron, [appDir, ...process.argv.slice(2)], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});

// The child has its own handle on the log now; this one would otherwise keep
// the descriptor open for the life of the parent.
if (typeof logFd === 'number') {
  try { fs.closeSync(logFd); } catch (_) { /* already gone */ }
}

child.on('error', (err) => {
  console.error(`Failed to launch LaTeX Stickies: ${err.message}`);
  process.exit(1);
});

/**
 * Electron will not run as root without --no-sandbox, and says so only in the
 * output nobody was reading. Naming it beats adding the flag quietly: turning
 * off the sandbox is a decision for whoever is running as root to make.
 */
function rootHint() {
  if (process.getuid && process.getuid() === 0) {
    return '\nRunning as root: Electron refuses to start without a sandbox.'
      + '\nRun it as an ordinary user, or pass --no-sandbox if you mean it:'
      + '\n  latex-stickies --no-sandbox';
  }
  return '';
}

const onEarlyExit = (code, signal) => {
  clearTimeout(timer);
  const tail = logTail(logFile);
  console.error(
    `LaTeX Stickies exited immediately (code=${code}, signal=${signal}).`
    + rootHint()
    + (tail ? `\n\nLast ${LOG_TAIL_LINES} lines of the log:\n${tail}` : '')
    + (logFile ? `\n\nFull log: ${logFile}` : '\n\nNo log could be written.')
  );
  process.exit(1);
};

child.on('exit', onEarlyExit);

// Survived the window: let go of it and let this process end, so the terminal
// is not held open by a note that is running perfectly well.
const timer = setTimeout(() => {
  child.removeListener('exit', onEarlyExit);
  child.removeAllListeners('error');
  child.unref();
  console.log('LaTeX Stickies is running. Close the notes to quit.');
}, STARTUP_MS);

// Watching must not become waiting: an unreferenced timer still fires, but it
// no longer holds the event loop open on its own.
timer.unref();
