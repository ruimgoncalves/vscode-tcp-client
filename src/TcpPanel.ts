import * as vscode from 'vscode';
import { TcpClient, ConnectionState } from './TcpClient';
import { encodeMessage, formatBytes, TextEncoding } from './MessageEncoder';
import { getAll as getAllEnvelopes, listBuiltin, wrap } from './envelopes/Envelope';
import { renderPanelHtml } from './PanelHtml';
import {
  registerEnvelopeHostHandlers,
  subscribeEnvelopeConfigChanges,
} from './envelopes/hostHandlers';
import {
  getAll as getAllVariables,
  getCustom as getCustomVariables,
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
 * preview. Uses UTC to match Variables.formatTimestamp and the help text.
 * Supports the tokens YYYY MM DD HH mm ss sss.
 */
export function formatTimestampPreview(date: Date, format: string): string {
  const p2 = (n: number): string => (n < 10 ? '0' + n : '' + n);
  const p3 = (n: number): string => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);
  const tokens: Record<string, string> = {
    YYYY: '' + date.getUTCFullYear(),
    MM:   p2(date.getUTCMonth() + 1),
    DD:   p2(date.getUTCDate()),
    HH:   p2(date.getUTCHours()),
    mm:   p2(date.getUTCMinutes()),
    ss:   p2(date.getUTCSeconds()),
    sss:  p3(date.getUTCMilliseconds()),
  };
  // Order tokens longest-first so `sss` is consumed before `ss`, and
  // `mm` before `m` if we ever add a single-letter token.
  return format.replace(/YYYY|MM|DD|HH|mm|sss|ss/g, (t) => tokens[t]);
}

/**
 * Reads user-defined variables through the canonical Variables parser and
 * strips runtime-only fields for the syntax-help payload. Malformed entries
 * follow `getCustom()` semantics: empty/invalid names are skipped and a
 * missing or non-string value is represented as an empty string.
 */
export function readUserVariables(): UserVariable[] {
  return getCustomVariables().map(({ name, value }) => ({ name, value }));
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

export class TcpPanel {
  static currentPanel: TcpPanel | undefined;
  static readonly viewType = 'tcpClient';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _tcpClient: TcpClient;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _ctx: vscode.ExtensionContext;
  private readonly _extensionUri: vscode.Uri;
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Allow the webview to load external CSS/JS from media/panel.css
        // and out/webview/main.js. Without this, asWebviewUri() produces a URL
        // the webview cannot fetch (CSP + webview sandbox blocks anything
        // not in localResourceRoots).
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          // Webview JS lives under out/webview/ now (compiled from
          // src/webview/main.ts via tsconfig.webview.json).
          vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
        ],
      }
    );
    TcpPanel.currentPanel = new TcpPanel(panel, extensionUri, extensionContext);
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri, extensionContext: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = _extensionUri;
    this._ctx = extensionContext;
    this._tcpClient = new TcpClient();
    this._panel.webview.html = this._getHtmlForWebview(panel.webview);

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleWebviewMessage(msg),
      null,
      this._disposables
    );

    // Envelope Save / Delete IPC handlers (independent listener — they
    // own their own message types and don't need to share the
    // _handleWebviewMessage switch).
    this._disposables.push(registerEnvelopeHostHandlers(this._panel));
    // External settings.json edits (hand-edit, Settings UI, another
    // extension) broadcast a fresh envelope list to the webview so the
    // dropdown stays in sync without the user reopening the panel.
    this._disposables.push(subscribeEnvelopeConfigChanges(this._panel));

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
    // Each settings-backed registry is read once for a consistent render.
    const envelopes = getAllEnvelopes();
    const builtins = listBuiltin();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.css'));
    const mainScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'main.js'));

    return renderPanelHtml({
      nonce,
      cspSource: webview.cspSource,
      styleUri: styleUri.toString(),
      mainScriptUri: mainScriptUri.toString(),
      envelopes,
      builtins,
    });
  }
}
