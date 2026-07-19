#!/usr/bin/env node
// CI guard for vscode-tcp-client: ensure the webview's compiled main.js
// parses cleanly under Node.
//
// History: this script originally extracted an inline IIFE from the
// compiled TcpPanel.js (Pattern 1 from
// `debugging-template-literal-embedded-js`). After the v0.2.7 refactor,
// the panel CSS lives in `media/panel.css` and the panel JS now lives in
// `src/webview/main.ts` (compiled to `out/webview/main.js` via
// `tsconfig.webview.json`). Both are loaded as proper external resources
// via `asWebviewUri()`. There is no embedded `<script>` body left to
// extract, so the guard simplifies to `node --check out/webview/main.js`.
//
// We keep the same command name (`node scripts/check-webview-js.js`) so
// the existing `lint:webview` script in package.json and the pretest
// hook continue to work without changes.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const mainJs = path.join(__dirname, '..', 'out', 'webview', 'main.js');

if (!fs.existsSync(mainJs)) {
  console.error('Webview JS not found:', mainJs);
  console.error('Did `npm run compile` run? It must invoke `tsc -p ./tsconfig.webview.json`.');
  process.exit(1);
}

// Surface the file size so CI logs give a quick sanity signal (the
// extracted-IIFE version reported "N IIFE(s), M chars"; the new shape
// reports one file).
const src = fs.readFileSync(mainJs, 'utf8');

try {
  execSync(`node --check ${mainJs}`, { stdio: 'pipe' });
  console.log(`Webview JS OK — ${src.length} chars (${mainJs})`);
} catch (e) {
  console.error('Webview JS SYNTAX ERROR in out/webview/main.js:');
  console.error(e.stderr.toString());
  process.exit(1);
}
