import * as vscode from 'vscode';
import { TcpClient, ConnectionState } from './TcpClient';
import { encodeMessage, formatBytes, TextEncoding } from './MessageEncoder';
import { getAll, resolve, wrap, Envelope } from './envelopes/Envelope';
import {
  getAll as getAllVariables,
  substitute,
  Variable,
  VariableDef,
} from './variables/Variables';
// formatTimestamp + DEFAULT_TIMESTAMP_FORMAT dropped in v2: the format
// input + live timestamp display moved out of the webview (format lives
// in the message text via {{timestamp|FMT}} — see Task A).

interface WebviewMessage {
  type:
    | 'connect'
    | 'disconnect'
    | 'send'
    | 'getState'
    | 'getEnvelopes'
    | 'getVariables'
    | 'addVariable'
    | 'deleteVariable'
    | 'persistMessage'
    | 'getPersistedMessage';
  server?: string;
  message?: string;
  encoding?: string;
  envelope?: string;
  name?: string;
  value?: string;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** HTML-escape attribute values embedded into the webview template. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class TcpPanel {
  static currentPanel: TcpPanel | undefined;
  static readonly viewType = 'tcpClient';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _tcpClient: TcpClient;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _ctx: vscode.ExtensionContext;
  private _server = '';
  private _lastSendTime: number | null = null;
  // Per-panel sequence counter. Starts at 1 when the panel is created
  // and increments by 1 after each successful tcpClient.send() call.
  // {{seq}} is substituted with the current value, then the counter
  // advances for the next send. Resets on every panel open because
  // TcpPanel.currentPanel is replaced when a new instance is built.
  private _seq: number = 1;

  static createOrShow(extensionUri: vscode.Uri, extensionContext: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (TcpPanel.currentPanel) {
      TcpPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TcpPanel.viewType,
      'TCP Client',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    TcpPanel.currentPanel = new TcpPanel(panel, extensionUri, extensionContext);
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri, extensionContext: vscode.ExtensionContext) {
    this._panel = panel;
    this._ctx = extensionContext;
    this._tcpClient = new TcpClient();
    this._panel.webview.html = this._getHtmlForWebview(panel.webview);

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleWebviewMessage(msg),
      null,
      this._disposables
    );

    this._tcpClient.on('stateChange', (state: ConnectionState) => {
      this._panel.webview.postMessage({ type: 'stateChange', state, server: this._server });
    });

    this._tcpClient.on('data', (chunk: Buffer) => {
      let responseTime: number | null = null;
      if (this._lastSendTime !== null) {
        responseTime = Date.now() - this._lastSendTime;
        this._lastSendTime = null;
      }
      this._panel.webview.postMessage({
        type: 'received',
        display: formatBytes(chunk),
        bytes: chunk.length,
        responseTime,
      });
    });

    this._tcpClient.on('error', (err: Error) => {
      this._panel.webview.postMessage({ type: 'error', message: err.message });
    });

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private async _handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'connect': {
        const addr = msg.server ?? '';
        const lastColon = addr.lastIndexOf(':');
        const host = addr.slice(0, lastColon);
        const port = parseInt(addr.slice(lastColon + 1), 10);
        if (!host || isNaN(port) || port < 1 || port > 65535) {
          this._panel.webview.postMessage({ type: 'error', message: 'Invalid address. Expected host:port (e.g. localhost:9000).' });
          break;
        }
        this._server = addr;
        try {
          await this._tcpClient.connect(host, port);
        } catch (err: unknown) {
          this._panel.webview.postMessage({ type: 'error', message: (err as Error).message });
        }
        break;
      }
      case 'disconnect':
        this._tcpClient.disconnect();
        break;
      case 'send': {
        try {
          // Resolve {{name}} references BEFORE encoding so the bytes
          // written to the socket contain the substituted values. The
          // response log therefore shows what was actually sent.
          // {{seq}} draws from the panel's per-session counter, which
          // is read here and advanced below after the send succeeds.
          const substituted = substitute(msg.message ?? '', getAllVariables(), new Date(), { seq: this._seq });
          let buf = encodeMessage(substituted, msg.encoding as TextEncoding ?? 'utf8');
          // Resolve the requested envelope and wrap the payload. An unknown
          // id is treated as an error: post it to the webview and skip the
          // send so the user can correct the dropdown before retrying.
          const envId = msg.envelope ?? 'none';
          let envelope: Envelope;
          try {
            envelope = resolve(envId);
          } catch (err: unknown) {
            this._panel.webview.postMessage({ type: 'error', message: (err as Error).message });
            break;
          }
          buf = wrap(buf, envelope.spec);
          this._tcpClient.send(buf);
          this._lastSendTime = Date.now();
          // Advance the seq counter only on a successful send. Failures
          // (envelope resolution, encoding error, socket error) must NOT
          // skip a number; the user's next attempt should get the next
          // value, not "fill in" the skipped one.
          this._seq += 1;
          this._panel.webview.postMessage({
            type: 'sent',
            display: formatBytes(buf),
            bytes: buf.length,
          });
        } catch (err: unknown) {
          this._panel.webview.postMessage({ type: 'error', message: (err as Error).message });
        }
        break;
      }
      case 'getState':
        this._panel.webview.postMessage({
          type: 'stateChange',
          state: this._tcpClient.state,
          server: this._server,
        });
        break;
      case 'getPersistedMessage':
        // Send the last-saved message text back to the webview so it
        // can restore the textarea on panel open. The webview requests
        // this explicitly (rather than reading from vscode.getState())
        // because globalState lives on the extension host, not in the
        // webview context.
        this._panel.webview.postMessage({
          type: 'persistedMessage',
          message: this._ctx.globalState.get<string>('message', ''),
        });
        break;
      case 'persistMessage':
        // Fire-and-forget: input events are frequent and globalState.update
        // is cheap, but `void` swallows the Thenable cleanly. An empty
        // string is a valid persisted state (user-cleared textarea).
        void this._ctx.globalState.update('message', msg.message ?? '');
        break;
      case 'getEnvelopes':
        this._panel.webview.postMessage({
          type: 'envelopes',
          envelopes: getAll().map((e) => ({ id: e.id, label: e.label })),
        });
        break;
      case 'getVariables':
        this._sendVariablesState();
        break;
      case 'addVariable': {
        const name = (msg.name ?? '').trim();
        const value = msg.value ?? '';
        if (!name) {
          this._panel.webview.postMessage({ type: 'error', message: 'Variable name cannot be empty.' });
          break;
        }
        // Reject duplicates against both existing custom variables and
        // built-ins (e.g. `timestamp`). `getAllVariables()` returns
        // built-ins first, then custom — one lookup covers both.
        const all = getAllVariables();
        if (all.some((v) => v.name === name)) {
          this._panel.webview.postMessage({
            type: 'error',
            message: `Variable "${name}" already exists.`,
          });
          break;
        }
        const current = vscode.workspace
          .getConfiguration('tcpClient')
          .get<VariableDef[]>('variables.custom', []);
        const next = Array.isArray(current) ? current.slice() : [];
        next.push({ name, value });
        await vscode.workspace.getConfiguration('tcpClient').update(
          'variables.custom',
          next,
          vscode.ConfigurationTarget.Global
        );
        this._sendVariablesState();
        break;
      }
      case 'deleteVariable': {
        const name = msg.name ?? '';
        if (!name) { break; }
        // Built-in variables are not removable from the UI; the webview
        // doesn't render a delete button for them, but defend here too.
        const current = vscode.workspace
          .getConfiguration('tcpClient')
          .get<VariableDef[]>('variables.custom', []);
        if (!Array.isArray(current)) { break; }
        const next = current.filter((v) => v && v.name !== name);
        if (next.length === current.length) { break; }  // not found
        await vscode.workspace.getConfiguration('tcpClient').update(
          'variables.custom',
          next,
          vscode.ConfigurationTarget.Global
        );
        this._sendVariablesState();
        break;
      }
    }
  }

  /**
   * Push the current custom-variable list to the webview. Called on
   * panel load and after every successful add/delete so the UI stays
   * in sync with settings.json.
   */
  private _sendVariablesState(): void {
    const all = getAllVariables();
    const custom = all.filter((v: Variable) => !v.builtin).map((v: Variable) => ({
      name: v.name,
      value: v.value,
    }));
    this._panel.webview.postMessage({
      type: 'variables',
      custom,
    });
  }

  dispose(): void {
    TcpPanel.currentPanel = undefined;
    this._tcpClient.dispose();
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }

  // ---------------------------------------------------------------------------
  // Webview HTML
  // ---------------------------------------------------------------------------

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    // Render the envelope options server-side so the dropdown is populated
    // immediately, even before any async message round-trip. Custom envelopes
    // from settings.json are also included because getAll() reads from the
    // configuration scope synchronously.
    const envelopeOptions = getAll()
      .map((e) => `<option value="${escapeHtmlAttr(e.id)}">${escapeHtmlAttr(e.label)}</option>`)
      .join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TCP Client</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 14px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; height: 100vh; gap: 10px; overflow: hidden;
  }
  .row { display: flex; align-items: center; gap: 8px; }
  label {
    font-size: 11px; color: var(--vscode-descriptionForeground);
    text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; min-width: 60px;
  }
  input[type="text"], select, textarea {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 8px; border-radius: 2px; outline: none;
    font-family: inherit; font-size: inherit;
  }
  input[type="text"]:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  #server { flex: 1; }
  button {
    padding: 4px 14px; border: none; border-radius: 2px; cursor: pointer;
    font-family: inherit; font-size: inherit; white-space: nowrap;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.sec {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.sec:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }

  /* Connect button colour by state */
  #connectBtn[data-state="connecting"] { opacity: .75; }
  #connectBtn[data-state="connected"]  { background: #c0392b; color: #fff; }

  /* Status indicator dot */
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #888; }
  .dot[data-state="connecting"] { background: #e9a700; animation: blink .8s step-end infinite; }
  .dot[data-state="connected"]  { background: #4ec9b0; }
  @keyframes blink { 50% { opacity: 0; } }

  .sec-label {
    font-size: 11px; color: var(--vscode-descriptionForeground);
    text-transform: uppercase; letter-spacing: .04em; flex: 1;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
    padding-bottom: 3px;
  }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; }

  /* Message area */
  .msg-wrap { display: flex; flex-direction: column; gap: 6px; }
  textarea#msg {
    width: 100%; height: 80px; resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }

  /* Log area */
  .log-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 6px; }
  #log {
    flex: 1; overflow-y: auto;
    background: var(--vscode-terminal-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
    border-radius: 2px; padding: 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }
  .e { display: flex; gap: 6px; margin-bottom: 1px; line-height: 1.5; align-items: baseline; }
  .e .ts   { color: var(--vscode-descriptionForeground); font-size: .82em; flex-shrink: 0; }
  .e .ic   { flex-shrink: 0; }
  .e .tx   { word-break: break-all; }
  .e .mt   { color: var(--vscode-descriptionForeground); font-size: .85em; flex-shrink: 0; }
  .e.sent .ic { color: #4fc3f7; }
  .e.recv .ic { color: #81c784; }
  .e.info .ic { color: var(--vscode-descriptionForeground); }
  .e.err  .ic, .e.err .tx { color: #f44747; }

  /* Variables section */
  .vars-wrap {
    display: flex; flex-direction: column; gap: 6px;
    max-height: 220px; flex-shrink: 0;
  }
  .vars-body { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
  .var-row {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 4px; border-radius: 2px;
  }
  .var-row.builtin { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.07)); }
  .var-row .var-name {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    font-weight: 600; flex-shrink: 0; min-width: 80px;
  }
  .var-row .var-value {
    flex: 1; min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .var-row .var-del {
    flex-shrink: 0; padding: 2px 8px; font-size: 11px;
  }
  .var-empty {
    color: var(--vscode-descriptionForeground);
    font-size: 11px; font-style: italic; padding: 4px;
  }
  .var-add {
    display: flex; align-items: center; gap: 6px; margin-top: 2px;
  }
  .var-add input { flex: 1; min-width: 0; }
  .var-add input.name { flex: 0 0 100px; }
  .var-add button { flex-shrink: 0; }
</style>
</head>
<body>

<div class="row">
  <label for="server">Server</label>
  <input id="server" type="text" value="localhost:9000" placeholder="host:port" spellcheck="false" autocomplete="off">
  <div class="dot" id="dot" data-state="disconnected"></div>
  <button id="connectBtn" data-state="disconnected">Connect</button>
</div>

<div class="row">
  <label for="encoding">Encoding</label>
  <select id="encoding">
    <option value="utf8">UTF-8</option>
    <option value="ascii">ASCII</option>
    <option value="latin1">Latin-1 (ISO-8859-1)</option>
    <option value="utf16le">UTF-16 LE</option>
  </select>
</div>

<div class="row">
  <label for="envelope">Envelope</label>
  <select id="envelope">
    ${envelopeOptions}
  </select>
</div>

<div class="msg-wrap">
  <div class="row">
    <span class="sec-label">Message</span>
  </div>
  <textarea id="msg" placeholder="Type message... Use {{name}} for your variables, {{timestamp|format}} for time, {{seq}} for sequence, {{uuid}} for unique id."></textarea>
  <div class="row">
    <button id="sendBtn" disabled>Send</button>
  </div>
</div>

<div class="vars-wrap">
  <div class="row">
    <span class="sec-label">Variables</span>
  </div>
  <div id="varsBody" class="vars-body"></div>
  <div class="var-add">
    <input id="newVarName" class="name" type="text" spellcheck="false" autocomplete="off" placeholder="name">
    <input id="newVarValue" type="text" spellcheck="false" autocomplete="off" placeholder="value">
    <button class="sec" id="addVarBtn">Add</button>
  </div>
</div>

<div class="log-wrap">
  <div class="row">
    <span class="sec-label">Response Log</span>
    <button class="sec" id="clearBtn">Clear</button>
  </div>
  <div id="log"></div>
</div>

<script nonce="${nonce}">
(function () {
  var vscode    = acquireVsCodeApi();
  var serverEl  = document.getElementById('server');
  var connectEl = document.getElementById('connectBtn');
  var dotEl     = document.getElementById('dot');
  var encEl     = document.getElementById('encoding');
  var envEl     = document.getElementById('envelope');
  var msgEl     = document.getElementById('msg');
  var sendEl    = document.getElementById('sendBtn');
  var clearEl   = document.getElementById('clearBtn');
  var logEl     = document.getElementById('log');
  var varsBodyEl = document.getElementById('varsBody');
  var newVarNameEl  = document.getElementById('newVarName');
  var newVarValueEl = document.getElementById('newVarValue');
  var addVarBtnEl   = document.getElementById('addVarBtn');
  var connState = 'disconnected';
  // Holds the most recent variables snapshot from the extension.
  var varsState = { custom: [] };

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

  function persistPrefs() {
    vscode.setState({ server: serverEl.value, encoding: encEl.value, envelope: envEl.value });
  }
  serverEl.addEventListener('input', persistPrefs);
  encEl.addEventListener('change', persistPrefs);
  envEl.addEventListener('change', persistPrefs);
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
      connectEl.textContent = 'Connecting\u2026';
      connectEl.disabled = true;
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
    var tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = text;
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
    } else if (connState === 'connected') {
      vscode.postMessage({ type: 'disconnect' });
    }
  });

  function doSend() {
    if (connState !== 'connected') { return; }
    var text = msgEl.value;
    if (!text) { return; }
    vscode.postMessage({ type: 'send', message: text, encoding: encEl.value, envelope: envEl.value || 'none' });
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
      // Refresh the dropdown so that custom envelopes added in
      // settings.json between sessions become available. Preserve the
      // currently selected id if it's still in the new list; otherwise
      // fall back to 'none'.
      var prev = envEl.value;
      envEl.innerHTML = '';
      var found = false;
      for (var i = 0; i < m.envelopes.length; i++) {
        var opt = document.createElement('option');
        opt.value = m.envelopes[i].id;
        opt.textContent = m.envelopes[i].label;
        envEl.appendChild(opt);
        if (m.envelopes[i].id === prev) { found = true; }
      }
      if (found) {
        envEl.value = prev;
      } else {
        envEl.value = 'none';
        persistPrefs();
      }
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
  // Also fetch the envelope list, in case the user added new custom
  // envelopes in settings.json since the panel was last opened. The
  // server-rendered HTML already shows the list, but this picks up
  // changes made between sessions.
  vscode.postMessage({ type: 'getEnvelopes' });
  // And fetch the current variables state (custom list, format, live
  // timestamp value) so the Variables section is populated immediately.
  vscode.postMessage({ type: 'getVariables' });
})();
</script>
</body>
</html>`;
  }
}
