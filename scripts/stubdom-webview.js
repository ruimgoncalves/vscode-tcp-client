#!/usr/bin/env node
/* Stub-DOM harness for out/webview/main.js
 *
 * The `lint:webview` guard (`check-webview-js.js`) only catches
 * *parse* errors via `node --check`. That misses a class of bugs
 * where the IIFE parses fine but throws at the first DOM lookup
 * or runtime check (e.g. `exports is not defined` when the bundle
 * was compiled as CommonJS and loaded as a browser script — the
 * 2026-07-18 v0.2.7-pre.1 regression).
 *
 * This script:
 *   1. Reads the compiled webview bundle.
 *   2. Builds a stub DOM with one stub per known element ID.
 *   3. Loads the bundle via `new Function(stripped)` (script-mode
 *      evaluation; the empty `export {}` is stripped because
 *      `new Function` evaluates as a script, not a module).
 *   4. Asserts that the bundle attaches listeners to the
 *      critical UI elements. If any expected listener is
 *      missing, the IIFE threw before reaching it — that
 *      means the panel is dead in the browser.
 *
 * Exit 0 = IIFE ran, listeners attached, no runtime errors.
 * Exit 1 = bundle is broken; do not ship.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const COMPILED_BUNDLE = path.join(__dirname, '..', 'out', 'webview', 'main.js');

// Elements the webview bundle expects to find via getElementById.
// If any of these is missing from the bundle's stubbed DOM, the
// IIFE will either throw at lookup time (post-ES2020 refactor)
// or fall through gracefully (the panelButtons IIFE explicitly
// bails when its required elements aren't present — that's a
// SEPARATE failure mode we want to detect by checking the
// critical listeners).
const REQUIRED_ELEMENT_IDS = [
  'server', 'connectBtn', 'dot', 'encoding', 'envelope',
  'envelope-prefix', 'envelope-suffix', 'envelope-linePrefix', 'envelope-lineSuffix',
  'envelope-reset-prefix', 'envelope-reset-suffix', 'envelope-reset-linePrefix', 'envelope-reset-lineSuffix',
  'envelope-notice', 'msg', 'sendBtn', 'clearBtn', 'log',
  'varsBody', 'newVarName', 'newVarValue', 'addVarBtn',
  'helpBtn', 'helpBackdrop', 'helpCloseBtn', 'livePreviewToggle',
  'escapeTable', 'varsTable',
  // Save / Delete envelope buttons (the 2026-07-18 PR feature).
  // If any of these is missing, the Save/Delete UI is dead.
  'envelope-save-btn', 'envelope-delete-btn',
  'savePresetDialog', 'savePresetLabel', 'savePresetForm', 'savePresetCancel',
  'deletePresetDialog', 'deletePresetMessage', 'deletePresetForm', 'deletePresetCancel',
];

// Critical listener checks. Each entry: [elementId, eventName, why-it-matters]
// If any of these listeners is missing post-execution, the panel is
// broken even if the IIFE didn't throw — silent failure mode.
const CRITICAL_LISTENERS = [
  ['connectBtn',     'click',     'Connect button'],
  ['sendBtn',        'click',     'Send button'],
  ['envelope',       'change',    'Envelope dropdown'],
  ['helpBtn',        'click',     'Help modal button'],
  ['envelope-save-btn',   'click',     'Save preset button'],
  ['envelope-delete-btn', 'click',     'Delete preset button'],
  ['savePresetDialog',    'close',     'Save dialog close handler'],
  ['deletePresetDialog',  'close',     'Delete dialog close handler'],
];

function makeInput(id) {
  const el = {
    _value: '',
    hidden: false,
    title: '',
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    selectionStart: 0,
    selectionEnd: 0,
    options: [],
    selectedIndex: 0,
    firstChild: null,
    dataset: {},
    addEventListener: () => {},
    appendChild: (child) => { child.parentNode = el; el.firstChild = child; return child; },
    removeChild: () => {},
    dispatchEvent: () => true,
    focus: () => {},
    setAttribute: (k, v) => { el[k] = v; },
    getAttribute: () => null,
    showModal: () => { el._open = true; },
    close: (rv) => { el._open = false; el.returnValue = rv || ''; },
    querySelectorAll: () => [],
    scrollTop: 0,
    scrollHeight: 0,
  };
  Object.defineProperty(el, 'value', {
    get: () => el._value,
    set: (v) => { el._value = v; },
  });
  return el;
}

function runStubDOM() {
  if (!fs.existsSync(COMPILED_BUNDLE)) {
    console.error(`FAIL: ${COMPILED_BUNDLE} not found. Did you run \`npm run compile\`?`);
    process.exit(1);
  }

  const listeners = {};
  const elements = {};
  for (const id of REQUIRED_ELEMENT_IDS) {
    elements[id] = makeInput(id);
    // Capture addEventListener per-element so we can verify what got wired.
    elements[id].addEventListener = (e, fn) => { listeners[`${id}:${e}`] = fn; };
  }

  global.document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => {
      const e = makeInput('dyn');
      e.tagName = tag.toUpperCase();
      return e;
    },
    createTextNode: (text) => ({ nodeType: 3, data: text, parentNode: null }),
    addEventListener: (e, fn) => { listeners[`document:${e}`] = fn; },
  };

  global.window = {
    __TCP_BOOTSTRAP__: {
      presets: {
        'none':     { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' },
        'hl7-mllp': { prefix: '\\x0B', suffix: '\\x1C\\r', linePrefix: '', lineSuffix: '' },
        'hl7-llp':  { prefix: '\\x0B', suffix: '\\x0D', linePrefix: '', lineSuffix: '' },
      },
    },
    addEventListener: (e, fn) => { listeners[`window:${e}`] = fn; },
  };

  global.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => ({}),
    setState: () => {},
  });

  const script = fs.readFileSync(COMPILED_BUNDLE, 'utf8');

  // Strip the empty `export {}` tsc emits for `declare global` to work.
  // new Function() evaluates as a script, not a module, so module syntax
  // would SyntaxError — strip just the empty-export line.
  const stripped = script.replace(/^export\s*\{\s*\};\s*$/m, '');

  try {
    new Function(stripped)();
  } catch (e) {
    console.error('FAIL: webview IIFE threw at runtime.');
    console.error(`  ${e.message}`);
    const stack = (e.stack || '').split('\n').slice(0, 3);
    for (const line of stack) console.error(`  ${line.trim()}`);
    console.error('\nMost common cause: tsc compiled the bundle as CommonJS (extends parent');
    console.error('tsconfig with "module": "commonjs") and the browser has no `exports` global.');
    console.error('Fix: set "module": "es2020" in tsconfig.webview.json.');
    process.exit(1);
  }

  // Verify all critical listeners were attached.
  const missing = [];
  for (const [id, event, why] of CRITICAL_LISTENERS) {
    if (!listeners[`${id}:${event}`]) {
      missing.push(`  - #${id} "${event}" (${why})`);
    }
  }

  if (missing.length > 0) {
    console.error('FAIL: webview bundle ran but critical listeners did NOT attach:');
    for (const line of missing) console.error(line);
    console.error('\nThe IIFE may have returned early (e.g. the panelButtons IIFE bails');
    console.error('when its required elements are missing — that means the Save/Delete');
    console.error('buttons are wired in the wrong file or missing IDs in the HTML.');
    process.exit(1);
  }

  const totalListeners = Object.keys(listeners).length;
  console.log(`OK: webview bundle runs cleanly. ${totalListeners} listeners attached, all critical ones present.`);
  process.exit(0);
}

runStubDOM();