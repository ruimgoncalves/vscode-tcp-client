#!/usr/bin/env node
/* Verify the package's files array will include all webview resources
 * the panel needs at runtime. Catches the case where a build ships
 * without out/webview/main.js (e.g. after a partial tsc invocation,
 * or when files glob excludes the directory).
 *
 * Without this, a stale installed extension shows a dead panel with
 * a webview devtools 404 on the JS resource, and the user has no
 * clear signal that the extension needs rebuilding.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REQUIRED_AT_BUILD = [
  // Compiled webview bundle (must exist after tsc -p ./tsconfig.webview.json)
  'out/webview/main.js',
  // CSS for the panel
  'media/panel.css',
  // Compiled host entry point (must exist after tsc -p ./)
  'out/extension.js',
  'out/TcpPanel.js',
  // Source files needed for debug + line-number correctness
  'src/TcpPanel.ts',
  'src/webview/main.ts',
  // Stub-DOM harness that pretest runs
  'scripts/stubdom-webview.js',
];

const REQUIRED_IN_PACKAGE = [
  // What the user actually receives when they install the .vsix
  'out/webview/main.js',
  'media/panel.css',
  'out/extension.js',
];

let failed = false;

// Step 1: on-disk checks (build is up to date)
console.log('Build artifact check:');
for (const f of REQUIRED_AT_BUILD) {
  const ok = fs.existsSync(f);
  console.log(`  ${ok ? 'OK ' : 'FAIL'} ${f}`);
  if (!ok) failed = true;
}

// Step 2: package contents check (vsce will ship them)
console.log('\nPackage contents check:');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const files = pkg.files || [];

function expandPattern(pattern) {
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    if (!fs.existsSync(base)) return [];
    const results = [];
    function walk(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else results.push(p.replace(/\\/g, '/'));
      }
    }
    walk(base);
    return results;
  }
  return fs.existsSync(pattern) ? [pattern] : [];
}

const packaged = [];
for (const f of files) packaged.push(...expandPattern(f));

for (const f of REQUIRED_IN_PACKAGE) {
  const ok = packaged.includes(f);
  console.log(`  ${ok ? 'OK ' : 'FAIL'} ${f}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('\nFAIL: package is missing required webview resources.');
  console.error('Run `npm run compile` then re-package before installing.');
  process.exit(1);
}

console.log('\nOK: all required build artifacts exist and will be packaged.');