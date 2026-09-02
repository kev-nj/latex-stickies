#!/usr/bin/env node
/**
 * Runs the whole suite. Wired to `npm test` and to `prepublishOnly`, so a
 * broken renderer cannot be published to npm.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const file of files) {
  console.log(`\n── ${file}`);
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(
  failed
    ? `\n${failed} of ${files.length} suites failing`
    : `\nall ${files.length} suites passing`
);
process.exit(failed ? 1 : 0);
