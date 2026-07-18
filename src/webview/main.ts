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

// Force this file to be treated as a module so we can use the
// `declare global` augmentation for `Window.__TCP_BOOTSTRAP__`.
// Without an `export {}` (or any import/export), the file is parsed
// as a legacy script and `declare global` is rejected with TS2669.
// The empty export is intentional and has zero runtime cost.
export {};

/**
 * The shape of the bootstrap payload the extension host injects via a
 * nonce-tagged inline `<script>` before this external script loads.
 * Defined as a type alias (not interface) so it composes cleanly with
 * the `Window` global augmentation below.
 */
type TcpBootstrap = {
  presets: Record<string, {
    prefix: string;
    suffix: string;
    linePrefix: string;
    lineSuffix: string;
  }>;
};

declare global {
  interface Window {
    __TCP_BOOTSTRAP__?: TcpBootstrap;
  }

  // `acquireVsCodeApi()` and the `WebviewApi` interface are NOT in
  // lib.dom — they're VS Code's webview sandbox injection. Declare
  // them locally so the webview bundle stays self-contained (no
  // @types/vscode dependency for the webview-side code, and no
  // Node globals via @types/node either, per tsconfig.webview.json
  // `types: []`).
  function acquireVsCodeApi(): WebviewApi;

  interface WebviewApi {
    getState(): unknown;
    setState(state: unknown): void;
    postMessage(message: unknown): void;
  }
}

(function (): void {
  const vscode: WebviewApi = acquireVsCodeApi();
  const bootstrap: TcpBootstrap = window.__TCP_BOOTSTRAP__ ?? { presets: {} };
  const PRESETS: TcpBootstrap['presets'] = bootstrap.presets ?? {};

  const serverEl = document.getElementById('server') as HTMLInputElement;
  const connectEl = document.getElementById('connectBtn') as HTMLButtonElement;
  const dotEl = document.getElementById('dot') as HTMLElement;
  const encEl = document.getElementById('encoding') as HTMLSelectElement;
  const envEl = document.getElementById('envelope') as HTMLSelectElement;
  const envFields: Record<'prefix' | 'suffix' | 'linePrefix' | 'lineSuffix', HTMLInputElement> = {
    prefix:     document.getElementById('envelope-prefix') as HTMLInputElement,
    suffix:     document.getElementById('envelope-suffix') as HTMLInputElement,
    linePrefix: document.getElementById('envelope-linePrefix') as HTMLInputElement,
    lineSuffix: document.getElementById('envelope-lineSuffix') as HTMLInputElement,
  };
  const envResets: Record<'prefix' | 'suffix' | 'linePrefix' | 'lineSuffix', HTMLButtonElement> = {
    prefix:     document.getElementById('envelope-reset-prefix') as HTMLButtonElement,
    suffix:     document.getElementById('envelope-reset-suffix') as HTMLButtonElement,
    linePrefix: document.getElementById('envelope-reset-linePrefix') as HTMLButtonElement,
    lineSuffix: document.getElementById('envelope-reset-lineSuffix') as HTMLButtonElement,
  };
  const envNotice = document.getElementById('envelope-notice') as HTMLElement;
  const msgEl = document.getElementById('msg') as HTMLTextAreaElement;
  const sendEl = document.getElementById('sendBtn') as HTMLButtonElement;
  const clearEl = document.getElementById('clearBtn') as HTMLButtonElement;
  const logEl = document.getElementById('log') as HTMLElement;
  const varsBodyEl = document.getElementById('varsBody') as HTMLElement;
  const newVarNameEl = document.getElementById('newVarName') as HTMLInputElement;
  const newVarValueEl = document.getElementById('newVarValue') as HTMLInputElement;
  const addVarBtnEl = document.getElementById('addVarBtn') as HTMLButtonElement;
  const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
  const helpBackdrop = document.getElementById('helpBackdrop') as HTMLElement;
  const helpCloseBtn = document.getElementById('helpCloseBtn') as HTMLButtonElement;
  const livePreviewToggle = document.getElementById('livePreviewToggle') as HTMLInputElement;
  const escapeTable = document.getElementById('escapeTable') as HTMLElement;
  const varsTable = document.getElementById('varsTable') as HTMLElement;
  let connState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  // Holds the most recent variables snapshot from the extension.
  const varsState: { custom: { name: string; value: string }[] } = { custom: [] };

  // Cache the cheat-sheet data so the live-preview toggle doesn't refetch
  const helpData: { escapes: { seq: string; meaning: string }[]; builtins: { syntax: string; description: string; preview?: string }[]; userVars: { name: string; value: string }[] } = { escapes: [], builtins: [], userVars: [] };

  // Restore session-scoped preferences from the webview state
  // (vscode.setState survives hide/show of the panel within a VS Code
  // session, but dies with the webview on restart — fine for transient
  // dropdown selections).
  //
  // The message text is intentionally NOT restored here: it comes from
  // extensionContext.globalState via a getPersistedMessage round-trip
  // below, so it survives VS Code restarts.
  const saved = (vscode.getState() ?? {}) as Record<string, string | undefined>;
  if (saved.server)   { serverEl.value = saved.server; }
  if (saved.encoding) { encEl.value    = saved.encoding; }
  if (saved.envelope) { envEl.value    = saved.envelope; }
  // Restore the envelope spec (per-field overrides) if the previous session
  // had any. The dropdown alone doesn't capture modifications.
  if (saved.envelopePrefix     !== undefined) { envFields.prefix.value     = saved.envelopePrefix; }
  if (saved.envelopeSuffix     !== undefined) { envFields.suffix.value     = saved.envelopeSuffix; }
  if (saved.envelopeLinePrefix !== undefined) { envFields.linePrefix.value = saved.envelopeLinePrefix; }
  if (saved.envelopeLineSuffix !== undefined) { envFields.lineSuffix.value = saved.envelopeLineSuffix; }

  function persistPrefs(): void {
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

  function presetFor(id: string): TcpBootstrap['presets'][string] {
    return PRESETS[id] ?? PRESETS['none'] ?? { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' };
  }

  function currentPreset(): TcpBootstrap['presets'][string] {
    return presetFor(envEl.value || 'none');
  }

  function isFieldModified(field: keyof typeof envFields): boolean {
    return envFields[field].value !== currentPreset()[field];
  }

  function refreshResetButtons(): void {
    envResets.prefix.hidden     = !isFieldModified('prefix');
    envResets.suffix.hidden     = !isFieldModified('suffix');
    envResets.linePrefix.hidden = !isFieldModified('linePrefix');
    envResets.lineSuffix.hidden = !isFieldModified('lineSuffix');
  }

  function showPresetNotice(text: string): void {
    if (!envNotice) { return; }
    envNotice.textContent = text;
    envNotice.hidden = false;
    if ((envNotice as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer) {
      clearTimeout((envNotice as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer);
    }
    (envNotice as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer = setTimeout(() => { envNotice.hidden = true; }, 3000);
  }

  function fieldsMatchPreset(): boolean {
    const p = currentPreset();
    return envFields.prefix.value     === p.prefix
        && envFields.suffix.value     === p.suffix
        && envFields.linePrefix.value === p.linePrefix
        && envFields.lineSuffix.value === p.lineSuffix;
  }

  function applyPreset(id: string, opts?: { notice?: boolean }): void {
    const p = presetFor(id);
    envFields.prefix.value     = p.prefix;
    envFields.suffix.value     = p.suffix;
    envFields.linePrefix.value = p.linePrefix;
    envFields.lineSuffix.value = p.lineSuffix;
    refreshResetButtons();
    if (opts && opts.notice && !fieldsMatchPreset()) {
      const labels: Record<string, string> = {
        'none':     'None (raw)',
        'hl7-mllp': 'HL7 v2 (MLLP framing)',
        'hl7-llp':  'HL7 v2 (raw LLP)',
      };
      showPresetNotice('Replaced with ' + (labels[id] ?? id) + ' preset.');
    }
  }

  // Switching the dropdown auto-fills the fields. We skip the notice if the
  // user just re-picks the same preset or if the fields already match.
  envEl.addEventListener('change', () => {
    const wasModified = !fieldsMatchPreset();
    applyPreset(envEl.value, { notice: true });
    if (wasModified) {
      persistPrefs();
    } else {
      persistPrefs();
    }
  });

  // Editing a field toggles its reset button (hidden when equal to preset).
  (['prefix', 'suffix', 'linePrefix', 'lineSuffix'] as const).forEach((f) => {
    envFields[f].addEventListener('input', () => {
      envResets[f].hidden = !isFieldModified(f);
      persistPrefs();
    });
  });

  // Per-field reset ↺ buttons: revert to the current preset's default.
  (['prefix', 'suffix', 'linePrefix', 'lineSuffix'] as const).forEach((f) => {
    envResets[f].addEventListener('click', () => {
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

  function setUiState(s: 'disconnected' | 'connecting' | 'connected'): void {
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

  function ts(): string {
    const d = new Date();
    const p2 = (n: number): string => n < 10 ? '0'+n : ''+n;
    const p3 = (n: number): string => n < 10 ? '00'+n : n < 100 ? '0'+n : ''+n;
    return '['+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds())+'.'+p3(d.getMilliseconds())+']';
  }

  function appendLog(cls: string, icon: string, text: string, meta?: string): void {
    const e  = document.createElement('div'); e.className = 'e ' + cls;
    const t  = document.createElement('span'); t.className = 'ts'; t.textContent = ts();
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon;
    const tx = document.createElement('span'); tx.className = 'tx';
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
    const parts = text.split('\\n');
    for (let pi = 0; pi < parts.length; pi++) {
      if (pi > 0) { tx.appendChild(document.createElement('br')); }
      tx.appendChild(document.createTextNode(parts[pi]));
    }
    e.appendChild(t); e.appendChild(ic); e.appendChild(tx);
    if (meta) {
      const m = document.createElement('span'); m.className = 'mt'; m.textContent = ' ' + meta;
      e.appendChild(m);
    }
    logEl.appendChild(e);
    logEl.scrollTop = logEl.scrollHeight;
  }

  connectEl.addEventListener('click', () => {
    if (connState === 'disconnected') {
      const s = serverEl.value.trim();
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

  function doSend(): void {
    if (connState !== 'connected') { return; }
    const text = msgEl.value;
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
  msgEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doSend(); }
  });
  clearEl.addEventListener('click', () => { logEl.innerHTML = ''; });

  // -------------------------------------------------------------------------
  // Variables section
  // -------------------------------------------------------------------------
  function renderVars(): void {
    // Custom variable list only — built-in variables (timestamp, seq, uuid)
    // are documented in the message textarea placeholder, not listed here,
    // because they're not user-editable.
    varsBodyEl.innerHTML = '';
    if (varsState.custom.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'var-empty';
      empty.textContent = '(no user variables — add one below)';
      varsBodyEl.appendChild(empty);
    } else {
      for (let i = 0; i < varsState.custom.length; i++) {
        const v = varsState.custom[i];
        const row = document.createElement('div');
        row.className = 'var-row';
        const nm = document.createElement('span');
        nm.className = 'var-name'; nm.textContent = v.name;
        const vv = document.createElement('span');
        vv.className = 'var-value'; vv.textContent = v.value;
        vv.title = v.value;  // full value on hover for long values
        const del = document.createElement('button');
        del.className = 'sec var-del'; del.textContent = '\u00d7';
        del.title = 'Delete ' + v.name;
        del.addEventListener('click', ((name: string) => {
          return () => {
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
  function openHelp(): void {
    // Fetch fresh data each time so user vars reflect the latest settings
    vscode.postMessage({ type: 'getSyntaxHelp' });
    helpBackdrop.hidden = false;
  }
  function closeHelp(): void {
    helpBackdrop.hidden = true;
  }
  helpBtn.addEventListener('click', openHelp);
  helpCloseBtn.addEventListener('click', closeHelp);
  helpBackdrop.addEventListener('click', (e) => {
    if (e.target === helpBackdrop) { closeHelp(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpBackdrop.hidden) { closeHelp(); }
  });
  livePreviewToggle.addEventListener('change', renderVarsTable);

  function makeHelpRow(td1Content: HTMLElement, td2Content: string | Node, onClick: () => void): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = 'help-row';
    tr.title = 'Click to paste into the message';
    const c1 = document.createElement('td');
    c1.appendChild(td1Content);
    const c2 = document.createElement('td');
    if (typeof td2Content === 'string') { c2.textContent = td2Content; }
    else { c2.appendChild(td2Content); }
    tr.appendChild(c1); tr.appendChild(c2);
    tr.addEventListener('click', onClick);
    return tr;
  }
  function makeCode(text: string): HTMLElement {
    const code = document.createElement('code');
    code.textContent = text;
    return code;
  }

  function renderEscapeTable(): void {
    escapeTable.innerHTML = '';
    const htr = document.createElement('tr');
    const h1 = document.createElement('th'); h1.textContent = 'Sequence';
    const h2 = document.createElement('th'); h2.textContent = 'Meaning';
    htr.appendChild(h1); htr.appendChild(h2);
    escapeTable.appendChild(htr);
    for (let i = 0; i < helpData.escapes.length; i++) {
      const e = helpData.escapes[i];
      escapeTable.appendChild(makeHelpRow(makeCode(e.seq), e.meaning, ((text: string) => {
        return () => { pasteIntoMessage(text); closeHelp(); };
      })(e.seq)));
    }
  }

  function renderVarsTable(): void {
    varsTable.innerHTML = '';
    const htr = document.createElement('tr');
    const h1 = document.createElement('th'); h1.textContent = 'Syntax';
    const h2 = document.createElement('th'); h2.textContent = 'Description';
    htr.appendChild(h1); htr.appendChild(h2);
    varsTable.appendChild(htr);

    let tr: HTMLTableRowElement;
    for (let i = 0; i < helpData.builtins.length; i++) {
      const b = helpData.builtins[i];
      let desc: Node;
      if (livePreviewToggle.checked && b.preview) {
        desc = document.createElement('span');
        desc.textContent = b.description;
        const arrow = document.createElement('span');
        arrow.className = 'preview-arrow';
        arrow.textContent = '\u2192 ' + b.preview;
        desc.appendChild(arrow);
      } else {
        desc = document.createTextNode(b.description);
      }
      varsTable.appendChild(makeHelpRow(makeCode(b.syntax), desc, ((text: string) => {
        return () => { pasteIntoMessage(text); closeHelp(); };
      })(b.syntax)));
    }

    if (helpData.userVars.length === 0) {
      tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2;
      td.style.color = 'var(--vscode-descriptionForeground)';
      td.style.fontStyle = 'italic';
      td.textContent = '(no user variables defined)';
      tr.appendChild(td);
      varsTable.appendChild(tr);
    } else {
      for (let j = 0; j < helpData.userVars.length; j++) {
        const uv = helpData.userVars[j];
        const name = '{{' + uv.name + '}}';
        let desc2: Node;
        if (livePreviewToggle.checked) {
          desc2 = document.createElement('span');
          desc2.textContent = 'User variable';
          const arrow2 = document.createElement('span');
          arrow2.className = 'preview-arrow';
          arrow2.textContent = '\u2192 ' + uv.value;
          desc2.appendChild(arrow2);
        } else {
          desc2 = document.createTextNode('User variable');
        }
        varsTable.appendChild(makeHelpRow(makeCode(name), desc2, ((text: string) => {
          return () => { pasteIntoMessage(text); closeHelp(); };
        })(name)));
      }
    }
  }

  addVarBtnEl.addEventListener('click', () => {
    const name = newVarNameEl.value.trim();
    const value = newVarValueEl.value;
    if (!name) { return; }  // empty inputs are rejected silently
    vscode.postMessage({ type: 'addVariable', name: name, value: value });
    newVarNameEl.value = '';
    newVarValueEl.value = '';
  });
  // Pressing Enter in the value field also submits the form.
  newVarValueEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addVarBtnEl.click(); }
  });
  newVarNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addVarBtnEl.click(); }
  });

  function pasteIntoMessage(text: string): void {
    const start = msgEl.selectionStart || 0;
    const end   = msgEl.selectionEnd || 0;
    msgEl.value = msgEl.value.substring(0, start) + text + msgEl.value.substring(end);
    const newPos = start + text.length;
    msgEl.selectionStart = msgEl.selectionEnd = newPos;
    msgEl.focus();
    persistPrefs();
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as {
      type: string;
      state?: 'disconnected' | 'connecting' | 'connected';
      server?: string;
      display?: string;
      bytes?: number;
      responseTime?: number | null;
      message?: string;
      reason?: string;
      custom?: { name: string; value: string }[];
      list?: { id: string; label: string }[];
      selectedId?: string;
      escapes?: { seq: string; meaning: string }[];
      builtins?: { syntax: string; description: string; preview?: string }[];
      userVars?: { name: string; value: string }[];
    };
    if (m.type === 'stateChange') {
      const prev = connState;
      setUiState(m.state ?? 'disconnected');
      if (m.state === 'connected' && prev !== 'connected') {
        appendLog('info', '\u26a1', 'Connected to ' + (m.server ?? ''));
      } else if (m.state === 'disconnected' && prev === 'connected') {
        appendLog('info', '\u2715', 'Disconnected');
      }
    } else if (m.type === 'sent') {
      appendLog('sent', '\u25b6', m.display ?? '', '(' + (m.bytes ?? 0) + ' bytes)');
    } else if (m.type === 'received') {
      const meta = m.responseTime != null
        ? '(' + m.responseTime + ' ms, ' + (m.bytes ?? 0) + ' bytes)'
        : '(' + (m.bytes ?? 0) + ' bytes)';
      appendLog('recv', '\u25c4', m.display ?? '', meta);
    } else if (m.type === 'error') {
      setUiState('disconnected');
      appendLog('err', '\u26a0', m.message ?? '');
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
        m.list.forEach((e) => {
          const opt = document.createElement('option');
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
      varsState.custom = m.custom ?? [];
      renderVars();
    } else if (m.type === 'persistedMessage') {
      // Populate the textarea with the last-saved message text on load.
      // We only honour the reply once; subsequent edits live in
      // globalState via the persistMessage input handler below.
      if (!msgEl.value) {
        msgEl.value = m.message || '';
      }
    } else if (m.type === 'syntaxHelp') {
      helpData.escapes  = m.escapes ?? [];
      helpData.builtins = m.builtins ?? [];
      helpData.userVars = m.userVars ?? [];
      renderEscapeTable();
      renderVarsTable();
    }
  });

  // Persist the message text on every input event. Stored in
  // extensionContext.globalState on the extension host so it survives
  // VS Code restarts. Fire-and-forget on the extension side.
  msgEl.addEventListener('input', () => {
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
(function (): void {
  const vscode: WebviewApi = acquireVsCodeApi();
  const BUILTIN_IDS: string[] = ['none', 'hl7-mllp', 'hl7-llp'];

  const envelopeSelect = document.getElementById('envelope') as HTMLSelectElement | null;
  const saveBtn       = document.getElementById('envelope-save-btn') as HTMLButtonElement | null;
  const deleteBtn     = document.getElementById('envelope-delete-btn') as HTMLButtonElement | null;
  const saveDialog    = document.getElementById('savePresetDialog') as HTMLDialogElement | null;
  const deleteDialog  = document.getElementById('deletePresetDialog') as HTMLDialogElement | null;
  const saveLabel     = document.getElementById('savePresetLabel') as HTMLInputElement | null;
  const saveCancel    = document.getElementById('savePresetCancel') as HTMLButtonElement | null;
  const deleteCancel  = document.getElementById('deletePresetCancel') as HTMLButtonElement | null;
  const deleteMessage = document.getElementById('deletePresetMessage') as HTMLElement | null;
  const prefixField       = document.getElementById('envelope-prefix') as HTMLInputElement | null;
  const suffixField       = document.getElementById('envelope-suffix') as HTMLInputElement | null;
  const linePrefixField   = document.getElementById('envelope-linePrefix') as HTMLInputElement | null;
  const lineSuffixField   = document.getElementById('envelope-lineSuffix') as HTMLInputElement | null;

  // If any element is missing (partial embed during refactor), bail
  // rather than letting the IIFE throw a null deref that takes down
  // the whole panel script with it.
  if (!envelopeSelect || !saveBtn || !deleteBtn || !saveDialog ||
      !deleteDialog || !saveLabel || !saveCancel || !deleteCancel || !deleteMessage) {
    return;
  }

  function isCustomSelected(): boolean {
    return BUILTIN_IDS.indexOf(envelopeSelect!.value) === -1;
  }

  function refreshDeleteButton(): void {
    deleteBtn!.disabled = !isCustomSelected();
  }

  refreshDeleteButton();
  envelopeSelect.addEventListener('change', refreshDeleteButton);

  saveBtn.addEventListener('click', () => {
    saveLabel!.value = '';
    saveDialog!.showModal();
    saveLabel!.focus();
  });

  saveCancel.addEventListener('click', () => {
    saveDialog!.close('cancel');
  });

  saveDialog.addEventListener('close', () => {
    if (saveDialog!.returnValue === 'cancel') { return; }
    const label = saveLabel!.value.trim();
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

  deleteBtn.addEventListener('click', () => {
    if (!isCustomSelected()) { return; }
    const opt = envelopeSelect!.options[envelopeSelect!.selectedIndex];
    const label = opt ? opt.text : envelopeSelect!.value;
    deleteMessage!.textContent = 'Delete the preset "' + label + '"?';
    deleteDialog!.showModal();
  });

  deleteCancel.addEventListener('click', () => {
    deleteDialog!.close('cancel');
  });

  deleteDialog.addEventListener('close', () => {
    if (deleteDialog!.returnValue === 'cancel') { return; }
    vscode.postMessage({
      type: 'deleteEnvelope',
      id: envelopeSelect!.value
    });
  });
})();
