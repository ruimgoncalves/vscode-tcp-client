/* TCP Client panel main script
 *
 * Loaded as an external resource via asWebviewUri() per the official VS
 * Code webview guide (https://code.visualstudio.com/api/extension-guides/webview):
 * "It is a best practice to extract all inline styles and scripts to
 * external files so that they can be properly loaded without relaxing
 * the content security policy."
 *
 * Runtime data arrives via `window.__TCP_BOOTSTRAP__`, set by a small
 * inline `<script nonce>` in the HTML template (see _getHtmlForWebview).
 * Using a nonce-tagged inline bootstrap is the standard escape-hatch
 * for shipping complex data into an external webview script while
 * keeping CSP strict (no 'unsafe-inline'). See the
 * `injecting-data-into-webview-js` skill reference for the trade-off.
 *
 * Two IIFEs share this file:
 *   1. The main panel IIFE (originally inline in TcpPanel.ts).
 *   2. The envelope Save/Delete button IIFE (originally inline in
 *      panelButtons.ts as a string export).
 *
 * They share a single `<script src>` load and run sequentially on
 * DOMContentLoaded (well, script-execution-order, since `defer` is
 * implicit when the script is at the end of `<body>`).
 */

(function () {
  var vscode    = acquireVsCodeApi();
  var bootstrap = window.__TCP_BOOTSTRAP__ || {};
  var PRESETS   = bootstrap.presets || {};
  var serverEl  = document.getElementById('server');
  var connectEl = document.getElementById('connectBtn');
  var dotEl     = document.getElementById('dot');
  var encEl     = document.getElementById('encoding');
  var envEl     = document.getElementById('envelope');
  var envFields = {
    prefix:     document.getElementById('envelope-prefix'),
    suffix:     document.getElementById('envelope-suffix'),
    linePrefix: document.getElementById('envelope-linePrefix'),
    lineSuffix: document.getElementById('envelope-lineSuffix'),
  };
  var envResets = {
    prefix:     document.getElementById('envelope-reset-prefix'),
    suffix:     document.getElementById('envelope-reset-suffix'),
    linePrefix: document.getElementById('envelope-reset-linePrefix'),
    lineSuffix: document.getElementById('envelope-reset-lineSuffix'),
  };
  var envNotice = document.getElementById('envelope-notice');
  var msgEl     = document.getElementById('msg');
  var sendEl    = document.getElementById('sendBtn');
  var clearEl   = document.getElementById('clearBtn');
  var logEl     = document.getElementById('log');
  var varsBodyEl = document.getElementById('varsBody');
  var newVarNameEl  = document.getElementById('newVarName');
  var newVarValueEl = document.getElementById('newVarValue');
  var addVarBtnEl   = document.getElementById('addVarBtn');
  var helpBtn        = document.getElementById('helpBtn');
  var helpBackdrop   = document.getElementById('helpBackdrop');
  var helpCloseBtn   = document.getElementById('helpCloseBtn');
  var livePreviewToggle = document.getElementById('livePreviewToggle');
  var escapeTable    = document.getElementById('escapeTable');
  var varsTable      = document.getElementById('varsTable');
  var connState = 'disconnected';
  // Holds the most recent variables snapshot from the extension.
  var varsState = { custom: [] };

  // Cache the cheat-sheet data so the live-preview toggle doesn't refetch
  var helpData = { escapes: [], builtins: [], userVars: [] };

  // Restore session-scoped preferences from the webview state
  // (vscode.setState survives hide/show of the panel within a VS Code
  // session, but dies with the webview on restart — fine for transient
  // dropdown selections).
  //
  // The message text is intentionally NOT restored here: it comes from
  // extensionContext.globalState via a getPersistedMessage round-trip
  // below, so it survives VS Code restarts.
  var saved = vscode.getState() || {};
  if (saved.server)   { serverEl.value = saved.server; }
  if (saved.encoding) { encEl.value    = saved.encoding; }
  if (saved.envelope) { envEl.value    = saved.envelope; }
  // Restore the envelope spec (per-field overrides) if the previous session
  // had any. The dropdown alone doesn't capture modifications.
  if (saved.envelopePrefix     !== undefined) { envFields.prefix.value     = saved.envelopePrefix; }
  if (saved.envelopeSuffix     !== undefined) { envFields.suffix.value     = saved.envelopeSuffix; }
  if (saved.envelopeLinePrefix !== undefined) { envFields.linePrefix.value = saved.envelopeLinePrefix; }
  if (saved.envelopeLineSuffix !== undefined) { envFields.lineSuffix.value = saved.envelopeLineSuffix; }

  function persistPrefs() {
    vscode.setState({
      server: serverEl.value,
      encoding: encEl.value,
      envelope: envEl.value,
      envelopePrefix:     envFields.prefix.value,
      envelopeSuffix:     envFields.suffix.value,
      envelopeLinePrefix: envFields.linePrefix.value,
      envelopeLineSuffix: envFields.lineSuffix.value,
    });
  }
  serverEl.addEventListener('input', persistPrefs);
  encEl.addEventListener('change', persistPrefs);
  envEl.addEventListener('change', persistPrefs);

  // ---------------------------------------------------------------------
  // Envelope editor: prefilling, modified-state, reset, inline notice
  // ---------------------------------------------------------------------

  function presetFor(id) {
    return PRESETS[id] || PRESETS['none'];
  }

  function currentPreset() {
    return presetFor(envEl.value || 'none');
  }

  function isFieldModified(field) {
    return envFields[field].value !== currentPreset()[field];
  }

  function refreshResetButtons() {
    envResets.prefix.hidden     = !isFieldModified('prefix');
    envResets.suffix.hidden     = !isFieldModified('suffix');
    envResets.linePrefix.hidden = !isFieldModified('linePrefix');
    envResets.lineSuffix.hidden = !isFieldModified('lineSuffix');
  }

  function showPresetNotice(text) {
    if (!envNotice) { return; }
    envNotice.textContent = text;
    envNotice.hidden = false;
    if (envNotice._timer) { clearTimeout(envNotice._timer); }
    envNotice._timer = setTimeout(function () { envNotice.hidden = true; }, 3000);
  }

  function fieldsMatchPreset() {
    var p = currentPreset();
    return envFields.prefix.value     === p.prefix
        && envFields.suffix.value     === p.suffix
        && envFields.linePrefix.value === p.linePrefix
        && envFields.lineSuffix.value === p.lineSuffix;
  }

  function applyPreset(id, opts) {
    var p = presetFor(id);
    envFields.prefix.value     = p.prefix;
    envFields.suffix.value     = p.suffix;
    envFields.linePrefix.value = p.linePrefix;
    envFields.lineSuffix.value = p.lineSuffix;
    refreshResetButtons();
    if (opts && opts.notice && !fieldsMatchPreset()) {
      var labels = {
        'none':     'None (raw)',
        'hl7-mllp': 'HL7 v2 (MLLP framing)',
        'hl7-llp':  'HL7 v2 (raw LLP)',
      };
      showPresetNotice('Replaced with ' + (labels[id] || id) + ' preset.');
    }
  }

  // Switching the dropdown auto-fills the fields. We skip the notice if the
  // user just re-picks the same preset or if the fields already match.
  envEl.addEventListener('change', function () {
    var wasModified = !fieldsMatchPreset();
    applyPreset(envEl.value, { notice: true });
    if (wasModified) {
      persistPrefs();
    } else {
      persistPrefs();
    }
  });

  // Editing a field toggles its reset button (hidden when equal to preset).
  ['prefix', 'suffix', 'linePrefix', 'lineSuffix'].forEach(function (f) {
    envFields[f].addEventListener('input', function () {
      envResets[f].hidden = !isFieldModified(f);
      persistPrefs();
    });
  });

  // Per-field reset ↺ buttons: revert to the current preset's default.
  ['prefix', 'suffix', 'linePrefix', 'lineSuffix'].forEach(function (f) {
    envResets[f].addEventListener('click', function () {
      envFields[f].value = currentPreset()[f];
      envResets[f].hidden = true;
      persistPrefs();
    });
  });

  // After restoring persisted state, sync reset-button visibility.
  refreshResetButtons();

  // Ask the extension for the last persisted message so it survives VS
  // Code restarts. The reply (see 'persistedMessage' handler below)
  // populates the textarea on load.
  vscode.postMessage({ type: 'getPersistedMessage' });

  function setUiState(s) {
    connState = s;
    connectEl.dataset.state = s;
    dotEl.dataset.state = s;
    if (s === 'disconnected') {
      connectEl.textContent = 'Connect';
      connectEl.disabled = false;
      sendEl.disabled = true;
    } else if (s === 'connecting') {
      // Keep the button enabled so the user can click it to cancel.
      // Switching the label from "Connecting…" to "Cancel" signals
      // the affordance; the click handler routes the click to
      // { type: 'cancelConnect' } instead of starting a new connect.
      connectEl.textContent = 'Cancel';
      connectEl.disabled = false;
      sendEl.disabled = true;
    } else {
      connectEl.textContent = 'Disconnect';
      connectEl.disabled = false;
      sendEl.disabled = false;
    }
  }

  function ts() {
    var d = new Date();
    function p2(n) { return n < 10 ? '0'+n : ''+n; }
    function p3(n) { return n < 10 ? '00'+n : n < 100 ? '0'+n : ''+n; }
    return '['+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds())+'.'+p3(d.getMilliseconds())+']';
  }

  function appendLog(cls, icon, text, meta) {
    var e  = document.createElement('div'); e.className = 'e ' + cls;
    var t  = document.createElement('span'); t.className = 'ts'; t.textContent = ts();
    var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon;
    var tx = document.createElement('span'); tx.className = 'tx';
    /*
     * Render embedded line breaks (the two-character escape backslash-n)
     * in multi-line protocol output (HL7 segments, NRPE, etc.) as actual
     * line breaks. XSS-safe via textContent / createTextNode (no innerHTML).
     *
     * Why block comment not line comment: a JS line comment ends at the
     * next source newline, and this block intentionally discusses literal
     * escape sequences that look like JS string literals. Writing it as
     * line comments would truncate the embedded JS at every newline and
     * break the IIFE before any listener could attach.
     *
     * Split target: the literal two-character string backslash + n, which
     * is what formatBytes emits for byte 0x0A.
     */
    var parts = text.split('\\n');
    for (var pi = 0; pi < parts.length; pi++) {
      if (pi > 0) { tx.appendChild(document.createElement('br')); }
      tx.appendChild(document.createTextNode(parts[pi]));
    }
    e.appendChild(t); e.appendChild(ic); e.appendChild(tx);
    if (meta) {
      var m = document.createElement('span'); m.className = 'mt'; m.textContent = ' ' + meta;
      e.appendChild(m);
    }
    logEl.appendChild(e);
    logEl.scrollTop = logEl.scrollHeight;
  }

  connectEl.addEventListener('click', function () {
    if (connState === 'disconnected') {
      var s = serverEl.value.trim();
      if (!s) { return; }
      setUiState('connecting');
      vscode.postMessage({ type: 'connect', server: s });
    } else if (connState === 'connecting') {
      // The button is enabled while connecting (label = "Cancel") so the
      // user can abort a hung connect (firewall drop, half-open). The
      // extension host's connect attempt will resolve back to the
      // 'disconnected' state when the cancel rejection propagates.
      vscode.postMessage({ type: 'cancelConnect' });
    } else if (connState === 'connected') {
      vscode.postMessage({ type: 'disconnect' });
    }
  });

  function doSend() {
    if (connState !== 'connected') { return; }
    var text = msgEl.value;
    if (!text) { return; }
    vscode.postMessage({
      type: 'send',
      message: text,
      encoding: encEl.value,
      envelopeId: envEl.value || 'none',
      envelopePrefix:     envFields.prefix.value,
      envelopeSuffix:     envFields.suffix.value,
      envelopeLinePrefix: envFields.linePrefix.value,
      envelopeLineSuffix: envFields.lineSuffix.value,
    });
  }

  sendEl.addEventListener('click', doSend);
  msgEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doSend(); }
  });
  clearEl.addEventListener('click', function () { logEl.innerHTML = ''; });

  // -------------------------------------------------------------------------
  // Variables section
  // -------------------------------------------------------------------------
  function renderVars() {
    // Custom variable list only — built-in variables (timestamp, seq, uuid)
    // are documented in the message textarea placeholder, not listed here,
    // because they're not user-editable.
    varsBodyEl.innerHTML = '';
    if (varsState.custom.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'var-empty';
      empty.textContent = '(no user variables — add one below)';
      varsBodyEl.appendChild(empty);
    } else {
      for (var i = 0; i < varsState.custom.length; i++) {
        var v = varsState.custom[i];
        var row = document.createElement('div');
        row.className = 'var-row';
        var nm = document.createElement('span');
        nm.className = 'var-name'; nm.textContent = v.name;
        var vv = document.createElement('span');
        vv.className = 'var-value'; vv.textContent = v.value;
        vv.title = v.value;  // full value on hover for long values
        var del = document.createElement('button');
        del.className = 'sec var-del'; del.textContent = '\u00d7';
        del.title = 'Delete ' + v.name;
        del.addEventListener('click', (function (name) {
          return function () {
            vscode.postMessage({ type: 'deleteVariable', name: name });
          };
        })(v.name));
        row.appendChild(nm); row.appendChild(vv); row.appendChild(del);
        varsBodyEl.appendChild(row);
      }
    }
  }

  // -----------------------------------------------------------------
  // Syntax help modal
  // -----------------------------------------------------------------
  function openHelp() {
    // Fetch fresh data each time so user vars reflect the latest settings
    vscode.postMessage({ type: 'getSyntaxHelp' });
    helpBackdrop.hidden = false;
  }
  function closeHelp() {
    helpBackdrop.hidden = true;
  }
  helpBtn.addEventListener('click', openHelp);
  helpCloseBtn.addEventListener('click', closeHelp);
  helpBackdrop.addEventListener('click', function (e) {
    if (e.target === helpBackdrop) { closeHelp(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !helpBackdrop.hidden) { closeHelp(); }
  });
  livePreviewToggle.addEventListener('change', renderVarsTable);

  function makeHelpRow(td1Content, td2Content, onClick) {
    var tr = document.createElement('tr');
    tr.className = 'help-row';
    tr.title = 'Click to paste into the message';
    var c1 = document.createElement('td');
    c1.appendChild(td1Content);
    var c2 = document.createElement('td');
    if (typeof td2Content === 'string') { c2.textContent = td2Content; }
    else { c2.appendChild(td2Content); }
    tr.appendChild(c1); tr.appendChild(c2);
    tr.addEventListener('click', onClick);
    return tr;
  }
  function makeCode(text) {
    var code = document.createElement('code');
    code.textContent = text;
    return code;
  }

  function renderEscapeTable() {
    escapeTable.innerHTML = '';
    var htr = document.createElement('tr');
    var h1 = document.createElement('th'); h1.textContent = 'Sequence';
    var h2 = document.createElement('th'); h2.textContent = 'Meaning';
    htr.appendChild(h1); htr.appendChild(h2);
    escapeTable.appendChild(htr);
    for (var i = 0; i < helpData.escapes.length; i++) {
      var e = helpData.escapes[i];
      escapeTable.appendChild(makeHelpRow(makeCode(e.seq), e.meaning, (function (text) {
        return function () { pasteIntoMessage(text); closeHelp(); };
      })(e.seq)));
    }
  }

  function renderVarsTable() {
    varsTable.innerHTML = '';
    var htr = document.createElement('tr');
    var h1 = document.createElement('th'); h1.textContent = 'Syntax';
    var h2 = document.createElement('th'); h2.textContent = 'Description';
    htr.appendChild(h1); htr.appendChild(h2);
    varsTable.appendChild(htr);

    var i, tr;
    for (i = 0; i < helpData.builtins.length; i++) {
      var b = helpData.builtins[i];
      var desc;
      if (livePreviewToggle.checked && b.preview) {
        desc = document.createElement('span');
        desc.textContent = b.description;
        var arrow = document.createElement('span');
        arrow.className = 'preview-arrow';
        arrow.textContent = '\u2192 ' + b.preview;
        desc.appendChild(arrow);
      } else {
        desc = document.createTextNode(b.description);
      }
      varsTable.appendChild(makeHelpRow(makeCode(b.syntax), desc, (function (text) {
        return function () { pasteIntoMessage(text); closeHelp(); };
      })(b.syntax)));
    }

    if (helpData.userVars.length === 0) {
      tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 2;
      td.style.color = 'var(--vscode-descriptionForeground)';
      td.style.fontStyle = 'italic';
      td.textContent = '(no user variables defined)';
      tr.appendChild(td);
      varsTable.appendChild(tr);
    } else {
      for (var j = 0; j < helpData.userVars.length; j++) {
        var uv = helpData.userVars[j];
        var name = '{{' + uv.name + '}}';
        var desc2;
        if (livePreviewToggle.checked) {
          desc2 = document.createElement('span');
          desc2.textContent = 'User variable';
          var arrow2 = document.createElement('span');
          arrow2.className = 'preview-arrow';
          arrow2.textContent = '\u2192 ' + uv.value;
          desc2.appendChild(arrow2);
        } else {
          desc2 = document.createTextNode('User variable');
        }
        varsTable.appendChild(makeHelpRow(makeCode(name), desc2, (function (text) {
          return function () { pasteIntoMessage(text); closeHelp(); };
        })(name)));
      }
    }
  }

  addVarBtnEl.addEventListener('click', function () {
    var name = newVarNameEl.value.trim();
    var value = newVarValueEl.value;
    if (!name) { return; }  // empty inputs are rejected silently
    vscode.postMessage({ type: 'addVariable', name: name, value: value });
    newVarNameEl.value = '';
    newVarValueEl.value = '';
  });
  // Pressing Enter in the value field also submits the form.
  newVarValueEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addVarBtnEl.click(); }
  });
  newVarNameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addVarBtnEl.click(); }
  });

  function pasteIntoMessage(text) {
    var start = msgEl.selectionStart || 0;
    var end   = msgEl.selectionEnd || 0;
    msgEl.value = msgEl.value.substring(0, start) + text + msgEl.value.substring(end);
    var newPos = start + text.length;
    msgEl.selectionStart = msgEl.selectionEnd = newPos;
    msgEl.focus();
    persist();
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (m.type === 'stateChange') {
      var prev = connState;
      setUiState(m.state);
      if (m.state === 'connected' && prev !== 'connected') {
        appendLog('info', '\u26a1', 'Connected to ' + m.server);
      } else if (m.state === 'disconnected' && prev === 'connected') {
        appendLog('info', '\u2715', 'Disconnected');
      }
    } else if (m.type === 'sent') {
      appendLog('sent', '\u25b6', m.display, '(' + m.bytes + ' bytes)');
    } else if (m.type === 'received') {
      var meta = m.responseTime != null
        ? '(' + m.responseTime + ' ms, ' + m.bytes + ' bytes)'
        : '(' + m.bytes + ' bytes)';
      appendLog('recv', '\u25c4', m.display, meta);
    } else if (m.type === 'error') {
      setUiState('disconnected');
      appendLog('err', '\u26a0', m.message);
    } else if (m.type === 'envelopes') {
      // Rebuild the <select id="envelope"> client-side from the host's
      // authoritative list. Triggered by: panel open (via getEnvelopes
      // request), settings.json edit (via ConfigurationTarget listener),
      // and the in-panel Save/Delete buttons.
      //
      // SECURITY: labels come from user-edited settings.json. Build the
      // <option> elements via DOM APIs (createElement + textContent) so
      // a crafted label containing double-quotes or angle brackets
      // cannot escape the attribute or inject HTML. Earlier server-rendered
      // code used escapeHtmlAttr on the label; the client-side rebuild
      // uses DOM creation as the direct equivalent (bypasses the HTML
      // parser entirely).
      if (m.list && envEl) {
        while (envEl.firstChild) { envEl.removeChild(envEl.firstChild); }
        m.list.forEach(function (e) {
          var opt = document.createElement('option');
          opt.value = e.id;
          opt.textContent = e.label;   // textContent escapes, no HTML interpretation
          envEl.appendChild(opt);
        });
      }
      if (m.selectedId && envEl) {
        envEl.value = m.selectedId;
      }
      // The Delete button's enabled state depends on the new selection.
      // Re-fire the change handler so it picks up the new value.
      if (envEl) {
        envEl.dispatchEvent(new Event('change'));
      }
    } else if (m.type === 'envelopeError') {
      appendLog('err', '\u26a0', 'Envelope: ' + (m.reason || 'unknown error'));
    } else if (m.type === 'variables') {
      varsState = { custom: m.custom || [] };
      renderVars();
    } else if (m.type === 'persistedMessage') {
      // Populate the textarea with the last-saved message text on load.
      // We only honour the reply once; subsequent edits live in
      // globalState via the persistMessage input handler below.
      if (!msgEl.value) {
        msgEl.value = m.message || '';
      }
    } else if (m.type === 'syntaxHelp') {
      helpData.escapes  = m.escapes || [];
      helpData.builtins = m.builtins || [];
      helpData.userVars = m.userVars || [];
      renderEscapeTable();
      renderVarsTable();
    }
  });

  // Persist the message text on every input event. Stored in
  // extensionContext.globalState on the extension host so it survives
  // VS Code restarts. Fire-and-forget on the extension side.
  msgEl.addEventListener('input', function () {
    vscode.postMessage({ type: 'persistMessage', message: msgEl.value });
  });

  // Sync state on load (handles panel restore after VS Code restart)
  vscode.postMessage({ type: 'getState' });
  // Fetch the current variables state (custom list, format, live timestamp
  // value) so the Variables section is populated immediately. Envelopes
  // are now driven by the Save/Delete buttons (hostHandlers.ts); the
  // host sends back an 'envelopes' message with the current list, the
  // client-side handler in this IIFE rebuilds the <select>.
  vscode.postMessage({ type: 'getVariables' });
  vscode.postMessage({ type: 'getEnvelopes' });
})();

// ---------------------------------------------------------------------------
// Envelope Save / Delete buttons IIFE
// (Originally exported as a string from src/envelopes/panelButtons.ts;
// inlined here as part of the external script extraction so the panel
// loads via a single <script src> rather than two.)
//
// ID conventions (must stay in sync with the inline HTML in
// `TcpPanel._getHtmlForWebview`):
//   - Envelope <select>: #envelope
//   - Save button:       #envelope-save-btn
//   - Delete button:     #envelope-delete-btn
//   - Save dialog:       #savePresetDialog (+ #savePresetLabel, #savePresetForm, #savePresetCancel)
//   - Delete dialog:     #deletePresetDialog (+ #deletePresetMessage, #deletePresetForm, #deletePresetCancel)
// ---------------------------------------------------------------------------
(function () {
  var vscode = acquireVsCodeApi();
  var BUILTIN_IDS = ['none', 'hl7-mllp', 'hl7-llp'];

  var envelopeSelect = document.getElementById('envelope');
  var saveBtn       = document.getElementById('envelope-save-btn');
  var deleteBtn     = document.getElementById('envelope-delete-btn');
  var saveDialog    = document.getElementById('savePresetDialog');
  var deleteDialog  = document.getElementById('deletePresetDialog');
  var saveLabel     = document.getElementById('savePresetLabel');
  var saveCancel    = document.getElementById('savePresetCancel');
  var deleteCancel  = document.getElementById('deletePresetCancel');
  var deleteMessage = document.getElementById('deletePresetMessage');
  var prefixField       = document.getElementById('envelope-prefix');
  var suffixField       = document.getElementById('envelope-suffix');
  var linePrefixField   = document.getElementById('envelope-linePrefix');
  var lineSuffixField   = document.getElementById('envelope-lineSuffix');

  // If any element is missing (partial embed during refactor), bail
  // rather than letting the IIFE throw a null deref that takes down
  // the whole panel script with it.
  if (!envelopeSelect || !saveBtn || !deleteBtn || !saveDialog ||
      !deleteDialog || !saveLabel || !saveCancel || !deleteCancel || !deleteMessage) {
    return;
  }

  function isCustomSelected() {
    return BUILTIN_IDS.indexOf(envelopeSelect.value) === -1;
  }

  function refreshDeleteButton() {
    deleteBtn.disabled = !isCustomSelected();
  }

  refreshDeleteButton();
  envelopeSelect.addEventListener('change', refreshDeleteButton);

  saveBtn.addEventListener('click', function () {
    saveLabel.value = '';
    saveDialog.showModal();
    saveLabel.focus();
  });

  saveCancel.addEventListener('click', function () {
    saveDialog.close('cancel');
  });

  saveDialog.addEventListener('close', function () {
    if (saveDialog.returnValue === 'cancel') { return; }
    var label = saveLabel.value.trim();
    if (!label) { return; }
    vscode.postMessage({
      type: 'saveEnvelope',
      label: label,
      prefix:     prefixField     ? prefixField.value     : '',
      suffix:     suffixField     ? suffixField.value     : '',
      linePrefix: linePrefixField ? linePrefixField.value : '',
      lineSuffix: lineSuffixField ? lineSuffixField.value : ''
    });
  });

  deleteBtn.addEventListener('click', function () {
    if (!isCustomSelected()) { return; }
    var opt = envelopeSelect.options[envelopeSelect.selectedIndex];
    var label = opt ? opt.text : envelopeSelect.value;
    deleteMessage.textContent = 'Delete the preset "' + label + '"?';
    deleteDialog.showModal();
  });

  deleteCancel.addEventListener('click', function () {
    deleteDialog.close('cancel');
  });

  deleteDialog.addEventListener('close', function () {
    if (deleteDialog.returnValue === 'cancel') { return; }
    vscode.postMessage({
      type: 'deleteEnvelope',
      id: envelopeSelect.value
    });
  });
})();