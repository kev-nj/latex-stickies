#!/usr/bin/env node
/**
 * Records assets/demo.gif -- the README animation -- by driving the real app.
 *
 * Nothing here is a mockup: it loads the real note page with a stand-in
 * preload, types into it a character at a time, and captures the window after
 * each keystroke. Screen recording would need a permission a terminal does not
 * usually have, and this is reproducible besides -- rerun it whenever the UI
 * changes rather than re-recording by hand.
 *
 *   npm run demo
 *
 * Needs ffmpeg for the frames-to-GIF step (brew install ffmpeg).
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'demo.gif');
const FPS = 15;
const WIDTH = 420;

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg is needed to assemble the GIF: brew install ffmpeg');
  process.exit(1);
}

const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frames-'));
const electronPath = require('electron');
const args = process.platform === 'linux'
  ? [path.join(__dirname, 'demo'), '--no-sandbox']
  : [path.join(__dirname, 'demo')];

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env: { ...process.env, DEMO_ROOT: ROOT, DEMO_FRAMES: frames },
});

child.on('exit', (code) => {
  if (code !== 0) {
    console.error(`the recorder exited with ${code}`);
    process.exit(1);
  }
  const count = fs.readdirSync(frames).length;
  // One palette for the whole clip, so the paper colour does not shift
  // between frames the way a per-frame palette makes it.
  const filter = `scale=${WIDTH}:-1:flags=lanczos,split[a][b];`
    + '[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';
  const ff = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
    '-vf', filter, OUT, '-loglevel', 'error',
  ], { stdio: 'inherit' });
  fs.rmSync(frames, { recursive: true, force: true });
  if (ff.status !== 0) process.exit(1);

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`wrote ${OUT} -- ${count} frames, ${(count / FPS).toFixed(1)}s, ${kb} KB`);
});
