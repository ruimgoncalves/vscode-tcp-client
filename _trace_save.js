/* End-to-end Save flow trace with stub DOM. Verifies:
 *  - Save button click → dialog opens
 *  - Form submit → close handler fires
 *  - vscode.postMessage called with saveEnvelope
 *  - Host reply (envelopes list) → dropdown updates
 *
 * Crucially: this test runs against the COMPILED bundle (not source).
 * The HTML form submit path uses method="dialog" — the close event
 * fires after the dialog closes. The form's submit button has
 * value="default" so the dialog's returnValue becomes "default"
 * (NOT "cancel") and the close handler proceeds to post the message.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const listeners = {};
const elements = {};
const postedMessages = [];

const ids = [
  'server', 'connectBtn', 'dot', 'encoding', 'envelope',
  'envelope-prefix', 'envelope-suffix', 'envelope-linePrefix', 'envelope-lineSuffix',
  'envelope-reset-prefix', 'envelope-reset-suffix', 'envelope-reset-linePrefix', 'envelope-reset-lineSuffix',
  'envelope-notice', 'msg', 'sendBtn', 'clearBtn', 'log',
  'varsBody', 'newVarName', 'newVarValue', 'addVarBtn',
  'helpBtn', 'helpBackdrop', 'helpCloseBtn', 'livePreviewToggle',
  'escapeTable', 'varsTable',
  'envelope-save-btn', 'envelope-delete-btn',
  'savePresetDialog', 'savePresetLabel', 'savePresetForm', 'savePresetCancel',
  'deletePresetDialog', 'deletePresetMessage', 'deletePresetForm', 'deletePresetCancel',
];

function makeInput(id) {
  const el = {
    _value: '', _open: false, _returnValue: '',
    hidden: false, title: '', style: {}, className: '',
    textContent: '', innerHTML: '',
    selectionStart: 0, selectionEnd: 0,
    options: [], selectedIndex: 0,
    firstChild: null, dataset: {},
    addEventListener: (e, fn) => { listeners[`${id}:${e}`] = fn; },
    appendChild: (c) => { c.parentNode = el; el.firstChild = c; return c; },
    removeChild: (c) => { el.firstChild = null; return c; },
    dispatchEvent: () => true,
    focus: () => {},
    setAttribute: (k, v) => { el[k] = v; },
    getAttribute: () => null,
    showModal: () => { el._open = true; console.log(`    → dialog ${id}.showModal()`); },
    close: (rv) => {
      el._open = false;
      el._returnValue = rv || '';
      console.log(`    → dialog ${id}.close(${JSON.stringify(rv)})`);
      const close = listeners[`${id}:close`];
      if (close) {
        console.log(`    → firing ${id} close handler`);
        close({});
      }
    },
    querySelectorAll: () => [],
    scrollTop: 0, scrollHeight: 0,
  };
  Object.defineProperty(el, 'value', {
    get: () => el._value,
    set: (v) => { el._value = v; },
  });
  Object.defineProperty(el, 'returnValue', {
    get: () => el._returnValue,
    set: (v) => { el._returnValue = v; },
  });
  return el;
}

for (const id of ids) elements[id] = makeInput(id);

global.document = {
  getElementById: (id) => elements[id] || null,
  createElement: (tag) => {
    const e = makeInput('dyn');
    e.tagName = tag.toUpperCase();
    e.appendChild = (c) => { e.firstChild = c; return c; };
    return e;
  },
  createTextNode: (text) => ({ nodeType: 3, data: text, parentNode: null }),
  addEventListener: (e, fn) => { listeners[`document:${e}`] = fn; },
};

global.window = {
  __TCP_BOOTSTRAP__: {
    presets: {
      'none':           { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' },
      'hl7-mllp':       { prefix: '\\x0B', suffix: '\\x1C\\r', linePrefix: '', lineSuffix: '' },
      'hl7-llp':        { prefix: '\\x0B', suffix: '\\x0D', linePrefix: '', lineSuffix: '' },
      'hl7-mllp-copy':  { prefix: '\\x0B', suffix: '\\x1C\\r', linePrefix: '', lineSuffix: '' },
      'hl7-llp-copy':   { prefix: '\\x0B', suffix: '\\x0D', linePrefix: '', lineSuffix: '' },
    },
  },
  addEventListener: (e, fn) => { listeners[`window:${e}`] = fn; },
};

global.acquireVsCodeApi = () => ({
  postMessage: (msg) => {
    postedMessages.push(msg);
    console.log(`    → postMessage: ${JSON.stringify(msg)}`);
  },
  getState: () => ({}),
  setState: () => {},
});

const script = fs.readFileSync(path.join(__dirname, 'out', 'webview', 'main.js'), 'utf8');
const stripped = script.replace(/^export\s*\{\s*\};\s*$/m, '');

try { new Function(stripped)(); } catch (e) {
  console.error('IIFE THREW:', e.message);
  process.exit(1);
}

console.log('\n=== Simulating host reply with built-ins + 2 custom copies ===');
const envelopesReply = {
  type: 'envelopes',
  list: [
    { id: 'none',           label: 'None (raw)' },
    { id: 'hl7-mllp',       label: 'HL7 v2 (MLLP framing)' },
    { id: 'hl7-llp',        label: 'HL7 v2 (raw LLP, no VT)' },
    { id: 'hl7-mllp-copy',  label: 'HL7 v2 (MLLP framing) — editable copy' },
    { id: 'hl7-llp-copy',   label: 'HL7 v2 (raw LLP, no VT) — editable copy' },
  ],
  selectedId: 'hl7-mllp',
};
listeners['window:message']({ data: envelopesReply });
console.log(`  envelopeSelect.value: ${JSON.stringify(elements['envelope']._value)}`);
console.log(`  deleteBtn.disabled: ${elements['envelope-delete-btn'].disabled}`);
console.log(`  envelope options count: ${elements['envelope'].options.length}`);

console.log('\n=== Click Save button (handler at line 674) ===');
listeners['envelope-save-btn:click']({});

console.log('\n=== Simulate user typing label and clicking submit ===');
elements['savePresetLabel']._value = 'my-test-preset';
console.log(`  savePresetLabel.value: ${JSON.stringify(elements['savePresetLabel']._value)}`);
console.log(`  saveDialog.open: ${elements['savePresetDialog']._open}`);
// Click the savePresetConfirm button (the form's submit)
listeners['savePresetConfirm:click']({});

console.log('\n=== Verify saveEnvelope was posted ===');
const savePosted = postedMessages.find((m) => m.type === 'saveEnvelope');
if (savePosted) {
  console.log(`  ✓ saveEnvelope posted:`);
  console.log(`    label: ${JSON.stringify(savePosted.label)}`);
  console.log(`    prefix: ${JSON.stringify(savePosted.prefix)}`);
  console.log(`    suffix: ${JSON.stringify(savePosted.suffix)}`);
  console.log(`    linePrefix: ${JSON.stringify(savePosted.linePrefix)}`);
  console.log(`    lineSuffix: ${JSON.stringify(savePosted.lineSuffix)}`);
} else {
  console.log(`  ✗ saveEnvelope NOT posted — posted messages: ${JSON.stringify(postedMessages, null, 2)}`);
}

console.log('\n=== Simulate host reply with new envelope added ===');
const afterSave = {
  type: 'envelopes',
  list: [
    { id: 'none',           label: 'None (raw)' },
    { id: 'hl7-mllp',       label: 'HL7 v2 (MLLP framing)' },
    { id: 'hl7-llp',        label: 'HL7 v2 (raw LLP, no VT)' },
    { id: 'hl7-mllp-copy',  label: 'HL7 v2 (MLLP framing) — editable copy' },
    { id: 'hl7-llp-copy',   label: 'HL7 v2 (raw LLP, no VT) — editable copy' },
    { id: 'my-test-preset', label: 'my-test-preset' },
  ],
  selectedId: 'my-test-preset',
};
listeners['window:message']({ data: afterSave });
console.log(`  envelopeSelect.value: ${JSON.stringify(elements['envelope']._value)}`);
console.log(`  deleteBtn.disabled: ${elements['envelope-delete-btn'].disabled} (should be false)`);
console.log(`  envelope options count: ${elements['envelope'].options.length} (should be 6)`);