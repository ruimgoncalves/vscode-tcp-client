/* Verify the bundle has only ONE call to acquireVsCodeApi().
 *
 * VS Code only allows one call per webview session — calling twice
 * throws, taking the second IIFE down before listeners attach
 * (this is the bug that broke Save/Delete silently). The fix hoists
 * the call to module scope and shares the reference across both
 * IIFEs in the file.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(path.join(__dirname, 'out', 'webview', 'main.js'), 'utf8');

// Strip the leading empty `export {};` so the script-mode evaluation
// doesn't choke on module syntax (the stripdom-webview.js harness
// does the same). Then count how many times the function is CALLED.
// Matches `acquireVsCodeApi()` with a balanced paren pair — naive
// but enough for our purposes (the call site is unique).
const callMatches = script.match(/acquireVsCodeApi\s*\(\s*\)/g) || [];
console.log(`acquireVsCodeApi() calls in bundle: ${callMatches.length}`);
if (callMatches.length !== 1) {
  console.error(`FAIL: expected exactly 1 call to acquireVsCodeApi() in the bundle, found ${callMatches.length}.`);
  console.error('Multiple calls will throw on the second invocation per VS Code docs.');
  process.exit(1);
}
console.log('OK: bundle has exactly one acquireVsCodeApi() call — shared across IIFEs.');
