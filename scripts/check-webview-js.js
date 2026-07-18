#!/usr/bin/env node
// CI guard for vscode-tcp-client: ensure the webview's embedded JS parses
// cleanly under Node. Pattern 1 from `debugging-template-literal-embedded-js`:
// TS does not see inside template-literal JS comments, so a stray newline
// inside a `//` comment breaks the embedded IIFE and the whole webview
// silently fails to attach event listeners. The user's symptom is
// "UI is non-responsive, clicks do nothing, dropdowns don't update" —
// no console error, because the JS never even runs.
//
// Run after `npm run compile` in CI:
//   "lint:webview": "node scripts/check-webview-js.js"

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const compiledJs = path.join(__dirname, '..', 'out', 'TcpPanel.js');

if (!fs.existsSync(compiledJs)) {
  console.error('Compiled JS not found:', compiledJs);
  console.error('Run `npm run compile` first.');
  process.exit(1);
}

const html = (() => {
  // Stub vscode + invoke the actual _getHtmlForWebview through the
  // class prototype, so we get the post-substitution HTML exactly as
  // VS Code would receive it.
  const Module = require('module');
  const origLoad = Module._load;
  const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p, toString: () => p, path: p, scheme: 'file' }) },
    window: {
      createWebviewPanel: () => ({
        webview: { html: '', postMessage: () => {} },
        onDidDispose: () => ({ dispose: () => {} }),
        reveal: () => {}, dispose: () => {},
      }),
      registerWebviewPanelSerializer: () => ({ dispose: () => {} }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (_k, dflt) => dflt, update: async () => undefined,
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
    commands: {
      executeCommand: async () => undefined,
      registerCommand: () => ({ dispose: () => {} }),
    },
    ExtensionContext: class {},
    ViewColumn: { One: 1, Two: 2, Active: -1 },
  };
  Module._load = function (request, parent, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, parent, ...rest);
  };
  // Load extension.js so the builtins side-effect import fires.
  const extEntry = path.join(__dirname, '..', 'out', 'extension.js');
  require(extEntry);
  const TcpPanelModule = require(compiledJs);
  const TcpPanel = TcpPanelModule.TcpPanel || TcpPanelModule.default;
  const method = TcpPanel.prototype._getHtmlForWebview
              || TcpPanel.prototype.getHtmlForWebview;
  const fakeWebview = { cspSource: 'vscode-webview://test', options: {} };
  return method.call(TcpPanel, fakeWebview);
})();

const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
if (!m) { console.error('no <script> tag in rendered html'); process.exit(1); }
const scriptBody = m[1];

const tmp = '/tmp/vscode-tcp-client-webview-check.js';
fs.writeFileSync(tmp, scriptBody);

try {
  execSync(`node --check ${tmp}`, { stdio: 'pipe' });
  console.log(`Webview JS OK — ${scriptBody.length} chars`);
} catch (e) {
  console.error('Webview JS SYNTAX ERROR:');
  console.error(e.stderr.toString());
  console.error(`Wrote failing script to ${tmp} for inspection`);
  process.exit(1);
}
