import * as vscode from 'vscode';
import { TcpClient, ConnectionState } from './TcpClient';
import { encodeMessage, formatBytes, TextEncoding } from './MessageEncoder';
import { listBuiltin, wrap } from './envelopes/Envelope';
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
    | 'cancelConnect'
    | 'send'
    | 'getState'
    | 'getVariables'
    | 'addVariable'
    | 'deleteVariable'
    | 'persistMessage'
    | 'getPersistedMessage'
    | 'getSyntaxHelp';
  server?: string;
  message?: string;
  encoding?: string;
  envelopeId?: string;
  envelopePrefix?: string;
  envelopeSuffix?: string;
  envelopeLinePrefix?: string;
  envelopeLineSuffix?: string;
  name?: string;
  value?: string;
}

/** A user-defined variable entry from `tcpClient.variables.custom`. */
export interface UserVariable {
  name: string;
  value: string;
}

/**
 * Minimal timestamp formatter used for the syntax-help modal's live
 * preview. Supports the tokens YYYY MM DD HH mm ss sss. We don't need
 * timezone-aware formatting here — this is just a quick preview.
 */
export function formatTimestampPreview(date: Date, format: string): string {
  const p2 = (n: number): string => (n < 10 ? '0' + n : '' + n);
  const p3 = (n: number): string => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);
  const tokens: Record<string, string> = {
    YYYY: '' + date.getFullYear(),
    MM:   p2(date.getMonth() + 1),
    DD:   p2(date.getDate()),
    HH:   p2(date.getHours()),
    mm:   p2(date.getMinutes()),
    ss:   p2(date.getSeconds()),
    sss:  p3(date.getMilliseconds()),
  };
  // Order tokens longest-first so `sss` is consumed before `ss`, and
  // `mm` before `m` if we ever add a single-letter token.
  return format.replace(/YYYY|MM|DD|HH|mm|sss|ss/g, (t) => tokens[t]);
}

/**
 * Reads the current user-defined variables from configuration. Returns
 * an empty array when the setting is missing or malformed.
 */
export function readUserVariables(): UserVariable[] {
  const cfg = vscode.workspace.getConfiguration('tcpClient');
  const raw = cfg.get<unknown>('variables.custom');
  if (!Array.isArray(raw)) { return []; }
  const out: UserVariable[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'name' in entry && 'value' in entry) {
      const e = entry as { name: unknown; value: unknown };
      if (typeof e.name === 'string' && typeof e.value === 'string') {
        out.push({ name: e.name, value: e.value });
      }
    }
  }
  return out;
}

/** Builds the payload returned by the `getSyntaxHelp` handler. Exposed
 *  (module-scope) so tests can verify the shape without a real webview. */
export function buildSyntaxHelpPayload(): {
  type: 'syntaxHelp';
  escapes: { seq: string; meaning: string }[];
  builtins: { syntax: string; description: string; preview: string }[];
  userVars: UserVariable[];
} {
  const now = new Date();
  return {
    type: 'syntaxHelp',
    escapes: [
      { seq: '\\xHH', meaning: 'Raw byte (hex), e.g. \\xFF' },
      { seq: '\\n',   meaning: 'Newline (0x0A)' },
      { seq: '\\r',   meaning: 'Carriage return (0x0D)' },
      { seq: '\\t',   meaning: 'Tab (0x09)' },
      { seq: '\\\\',  meaning: 'Literal backslash' },
      { seq: '\\0',   meaning: 'Null byte (0x00)' },
      { seq: '\\{',   meaning: 'Literal open brace (lets you send {{name}} text)' },
      { seq: '\\}',   meaning: 'Literal close brace' },
    ],
    builtins: [
      { syntax: '{{timestamp}}',         description: 'Current UTC time, default format from tcpClient.variables.timestampFormat', preview: formatTimestampPreview(now, 'YYYY-MM-DD HH:mm:ss') },
      { syntax: '{{timestamp|FORMAT}}',  description: 'Time with FORMAT (YYYY MM DD HH mm ss sss)',                                preview: formatTimestampPreview(now, 'YYYY-MM-DD HH:mm:ss') },
      { syntax: '{{seq}}',               description: 'Per-session counter, 1, 2, 3...',                                            preview: '(session-only)' },
      { syntax: '{{uuid}}',              description: 'Fresh RFC 4122 v4 UUID',                                                      preview: '(unique per substitution)' },
    ],
    userVars: readUserVariables(),
  };
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
      case 'cancelConnect':
        // User clicked the Connect button while it was showing the
        // "Cancel" label (see setUiState's connecting branch). Tear down
        // the in-flight socket and reject the pending connect promise.
        // Safe to call when the client isn't connecting — `cancel()` is
        // a no-op in that case.
        this._tcpClient.cancel();
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
          // The UI sends the envelope spec directly (prefix/suffix/linePrefix/lineSuffix
          // from the always-visible editor). We trust the user's bytes; parse errors
          // surface as exceptions caught below.
          buf = wrap(buf, {
            prefix: msg.envelopePrefix ?? '',
            suffix: msg.envelopeSuffix ?? '',
            linePrefix: msg.envelopeLinePrefix ?? '',
            lineSuffix: msg.envelopeLineSuffix ?? '',
          });
          this._tcpClient.send(buf);
          this._lastSendTime = Date.now();
          // Advance the seq counter only on a successful send. Failures
          // (encoding error, socket error, invalid escape sequences in the
          // envelope spec) must NOT skip a number; the user's next attempt
          // should get the next
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
      case 'getSyntaxHelp':
        this._panel.webview.postMessage(buildSyntaxHelpPayload());
        break;
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
    // immediately, even before any async message round-trip. The list
    // contains only built-ins; user envelopes are no longer configurable
    // via settings.json (the always-visible fields in the UI cover that).
    const envelopeOptions = listBuiltin()
      .map((e) => `<option value="${escapeHtmlAttr(e.id)}">${escapeHtmlAttr(e.label)}</option>`)
      .join('');
    // The envelope fields in the UI prefill from the *currently selected*
    // preset, so the server-rendered HTML shows the right placeholders on
    // first paint without waiting for a client-side bootstrap round-trip.
    const initialPreset = listBuiltin().find((e) => e.id === 'none') ?? listBuiltin()[0];
    const presetPrefix = initialPreset ? initialPreset.spec.prefix : '';
    const presetSuffix = initialPreset ? initialPreset.spec.suffix : '';
    const presetLinePrefix = initialPreset ? initialPreset.spec.linePrefix : '';
    const presetLineSuffix = initialPreset ? initialPreset.spec.lineSuffix : '';
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

  /* Header row with title + help button */
  .header-row {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
    margin-bottom: 2px;
  }
  .header-title { font-weight: 600; font-size: 13px; }
  .help-btn {
    width: 24px; height: 24px; padding: 0; border-radius: 50%;
    font-size: 13px; font-weight: 700; line-height: 1;
    background: #f5c518; color: #1a1a1a;
    border: 1px solid #c9a012;
    opacity: .85;
  }
  .help-btn:hover {
    opacity: 1;
    background: #ffd633;
    border-color: #b89010;
  }
  .help-btn:focus { outline: 2px solid #ffd633; outline-offset: 1px; }

  /* Envelope editor: always-visible 4-field grid below the preset dropdown */
  .envelope-notice {
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border));
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 2px;
    margin: -2px 0 4px 0;
  }
  .envelope-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 10px;
    margin-left: 90px;       /* matches label column width of .row */
    margin-bottom: 8px;
  }
  @media (max-width: 520px) {
    .envelope-fields { grid-template-columns: 1fr; margin-left: 0; }
  }
  .env-field { display: flex; flex-direction: column; gap: 2px; }
  .env-field label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .env-input-wrap { position: relative; }
  .env-field input {
    width: 100%;
    height: 24px;
    padding: 2px 24px 2px 6px;       /* right padding reserves space for the reset button */
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
  }
  .env-reset {
    position: absolute;
    right: 2px; top: 2px;
    width: 18px; height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    border-radius: 2px;
  }
  .env-reset:hover { background: var(--vscode-button-secondaryHoverBackground); color: var(--vscode-foreground); }
  .env-reset[hidden] { display: none; }

  /* Syntax help modal */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    animation: fade-in 150ms ease-out;
  }
  .modal-backdrop[hidden] { display: none; }
  .modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
    border-radius: 4px;
    padding: 16px 20px;
    max-width: 720px; max-height: 70vh;
    width: 100%;
    overflow: hidden;
    position: relative;
    display: flex; flex-direction: column; gap: 10px;
    animation: slide-up 150ms ease-out;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slide-up { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .modal h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .modal-close {
    position: absolute; top: 8px; right: 8px;
    width: 24px; height: 24px; padding: 0; border-radius: 2px;
    font-size: 16px; line-height: 1;
  }
  .modal-body {
    display: flex; gap: 16px; overflow: hidden; flex: 1;
  }
  .help-section {
    flex: 1; display: flex; flex-direction: column; gap: 8px;
    overflow-y: auto; min-width: 0;
  }
  .help-section h3 {
    margin: 0; font-size: 11px; color: var(--vscode-descriptionForeground);
    text-transform: uppercase; letter-spacing: .04em;
  }
  .preview-toggle {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; color: var(--vscode-descriptionForeground);
    cursor: pointer;
  }
  .help-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
  }
  .help-table th {
    text-align: left; padding: 4px 6px;
    color: var(--vscode-descriptionForeground);
    font-weight: normal; font-size: 11px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
  }
  .help-table td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.15));
    vertical-align: top;
  }
  .help-table tr.help-row { cursor: pointer; }
  .help-table tr.help-row:hover td { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
  .help-table code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
    padding: 1px 4px; border-radius: 2px;
  }
  .preview-arrow {
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
</style>
</head>
<body>

<div class="header-row">
  <span class="header-title">TCP Client</span>
  <button class="sec help-btn" id="helpBtn" title="Syntax help (escape sequences and variables)">?</button>
</div>

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

<div id="envelope-notice" class="envelope-notice" hidden></div>

<div id="envelope-fields" class="envelope-fields">
  <div class="env-field">
    <label for="envelope-prefix">Prefix</label>
    <div class="env-input-wrap">
      <input id="envelope-prefix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetPrefix)}">
      <button id="envelope-reset-prefix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset prefix" hidden>↺</button>
    </div>
  </div>
  <div class="env-field">
    <label for="envelope-suffix">Suffix</label>
    <div class="env-input-wrap">
      <input id="envelope-suffix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetSuffix)}">
      <button id="envelope-reset-suffix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset suffix" hidden>↺</button>
    </div>
  </div>
  <div class="env-field">
    <label for="envelope-linePrefix">Line Prefix</label>
    <div class="env-input-wrap">
      <input id="envelope-linePrefix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetLinePrefix)}">
      <button id="envelope-reset-linePrefix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset line prefix" hidden>↺</button>
    </div>
  </div>
  <div class="env-field">
    <label for="envelope-lineSuffix">Line Suffix</label>
    <div class="env-input-wrap">
      <input id="envelope-lineSuffix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetLineSuffix)}">
      <button id="envelope-reset-lineSuffix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset line suffix" hidden>↺</button>
    </div>
  </div>
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

<div id="helpBackdrop" class="modal-backdrop" hidden>
  <div class="modal" role="dialog" aria-labelledby="helpTitle">
    <button class="sec modal-close" id="helpCloseBtn" aria-label="Close">&times;</button>
    <h2 id="helpTitle">Syntax help</h2>
    <div class="modal-body">
      <section class="help-section">
        <h3>Escape sequences</h3>
        <p class="hint">Click any row to paste it into the message.</p>
        <table id="escapeTable" class="help-table">
          <!-- populated by JS from the getSyntaxHelp response -->
        </table>
      </section>
      <section class="help-section">
        <h3>Variables</h3>
        <label class="preview-toggle">
          <input type="checkbox" id="livePreviewToggle"> Show live substitution preview
        </label>
        <table id="varsTable" class="help-table">
          <!-- populated by JS -->
        </table>
      </section>
    </div>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  var vscode    = acquireVsCodeApi();
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
  // Preset definitions injected from the extension host as JSON.
// (Replaced below by string-concat so the template-literal escape-twice
// problem doesn't mangle backslash sequences like \x0B.)
    var PRESETS = __PRESETS_PLACEHOLDER__;
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
      // The dropdown is server-rendered with built-ins only; no client-side
      // rebuild needed. (Previously this handler merged in custom envelopes
      // from settings.json — those are gone in 0.2.1; users edit bytes
      // directly via the always-visible fields.)
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
  // are server-rendered with built-ins only; no round-trip needed.
  vscode.postMessage({ type: 'getVariables' });
})();
</script>
</body>
</html>`.replace('__PRESETS_PLACEHOLDER__', JSON.stringify(
      Object.fromEntries(listBuiltin().map((e) => [e.id, e.spec]))
    ));
  }
}
