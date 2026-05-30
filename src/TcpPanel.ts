import * as vscode from 'vscode';
import { TcpClient, ConnectionState } from './TcpClient';
import { encodeMessage, formatBytes, TextEncoding } from './MessageEncoder';

interface WebviewMessage {
  type: 'connect' | 'disconnect' | 'send' | 'getState';
  server?: string;
  message?: string;
  encoding?: string;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export class TcpPanel {
  static currentPanel: TcpPanel | undefined;
  static readonly viewType = 'tcpClient';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _tcpClient: TcpClient;
  private readonly _disposables: vscode.Disposable[] = [];
  private _server = '';
  private _lastSendTime: number | null = null;

  static createOrShow(extensionUri: vscode.Uri): void {
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
    TcpPanel.currentPanel = new TcpPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
    this._panel = panel;
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
          const buf = encodeMessage(msg.message ?? '', msg.encoding as TextEncoding ?? 'utf8');
          this._tcpClient.send(buf);
          this._lastSendTime = Date.now();
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
    }
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

<div class="msg-wrap">
  <div class="row">
    <span class="sec-label">Message</span>
  </div>
  <textarea id="msg" placeholder="Type message...&#10;Escape sequences: \\xHH (raw byte), \\n \\r \\t (control), \\\\ (backslash)"></textarea>
  <div class="row">
    <span class="hint">Ctrl+Enter to send</span>
    <button id="sendBtn" disabled>Send</button>
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
  var msgEl     = document.getElementById('msg');
  var sendEl    = document.getElementById('sendBtn');
  var clearEl   = document.getElementById('clearBtn');
  var logEl     = document.getElementById('log');
  var connState = 'disconnected';

  // Restore persisted state from previous session
  var saved = vscode.getState() || {};
  if (saved.server)   { serverEl.value = saved.server; }
  if (saved.encoding) { encEl.value    = saved.encoding; }
  if (saved.message)  { msgEl.value    = saved.message; }

  function persist() {
    vscode.setState({ server: serverEl.value, encoding: encEl.value, message: msgEl.value });
  }
  serverEl.addEventListener('input', persist);
  encEl.addEventListener('change', persist);
  msgEl.addEventListener('input', persist);

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
    vscode.postMessage({ type: 'send', message: text, encoding: encEl.value });
  }

  sendEl.addEventListener('click', doSend);
  msgEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doSend(); }
  });
  clearEl.addEventListener('click', function () { logEl.innerHTML = ''; });

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
    }
  });

  // Sync state on load (handles panel restore after VS Code restart)
  vscode.postMessage({ type: 'getState' });
})();
</script>
</body>
</html>`;
  }
}
