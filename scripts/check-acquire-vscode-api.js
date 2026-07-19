/* Verify the bundle has only ONE call to acquireVsCodeApi().
 *
 * VS Code only allows one call per webview session — calling twice
 * throws, taking the second IIFE down before listeners attach
 * (the bug that broke Save/Delete silently). The fix hoists the
 * call to module scope and shares the reference across both IIFEs.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(path.join(__dirname, '..', 'out', 'webview', 'main.js'), 'utf8');

// Strip line comments before line-number-aware matching. The naive
// regex above counted matches inside `// ...` comments; we walk the
// source more carefully here.
let inBlockComment = false;
let inLineComment = false;
const stripped = [];
for (let i = 0; i < script.length; i++) {
  const c = script[i];
  const next = script[i + 1];
  if (!inLineComment && c === '/' && next === '*') { inBlockComment = true; stripped.push(' '); stripped.push(' '); i++; continue; }
  if (inBlockComment && c === '*' && next === '/') { inBlockComment = false; stripped.push(' '); stripped.push(' '); i++; continue; }
  if (!inBlockComment && c === '/' && next === '/') { inLineComment = true; stripped.push(' '); stripped.push(' '); i++; continue; }
  if (inLineComment && c === '\n') { inLineComment = false; }
  stripped.push(inBlockComment || inLineComment ? ' ' : c);
}
const codeOnly = stripped.join('');

const callMatches = codeOnly.match(/acquireVsCodeApi\s*\(\s*\)/g) || [];
console.log(`acquireVsCodeApi() calls in bundle (excluding comments): ${callMatches.length}`);
if (callMatches.length !== 1) {
  console.error(`FAIL: expected exactly 1 call to acquireVsCodeApi() in the bundle, found ${callMatches.length}.`);
  console.error('Multiple calls will throw on the second invocation per VS Code docs.');
  process.exit(1);
}
console.log('OK: bundle has exactly one acquireVsCodeApi() call — shared across both IIFEs.');
