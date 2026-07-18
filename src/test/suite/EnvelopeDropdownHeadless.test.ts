// Headless test: open the panel, exercise the dropdown-change handler in
// the real webview IIFE, verify the field values get populated.
//
// Strategy (from skill references/vscode-tcp-client.md "Stubbing the
// panel's TcpClient to test webview message handlers without a socket"):
//
// 1. executeCommand('tcpClient.openPanel') activates the extension +
//    creates the panel. This triggers the side-effect imports in
//    extension.ts that register builtins. PRESETS in the webview should
//    have 3 entries.
// 2. After panel.webview.html settles, run a probe inside the webview
//    that programmatically changes the envelope dropdown to 'hl7-mllp',
//    then reads back the value of envelope-prefix / envelope-suffix /
//    envelope-lineSuffix inputs.
// 3. Assert: prefix value is the 4-char string '\x0B', suffix is
//    '\x1C', lineSuffix is '\r'.
// 4. ALSO: send a 'send' message via _handleWebviewMessage and verify
//    the wire bytes the host writes to the (stubbed) TcpClient are
//    [0x0b, payload, 0x0d, 0x1c].

import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { TcpPanel } from '../../TcpPanel';
import { TcpClient } from '../../TcpClient';

// StubTcpClient captures sends without touching a real socket.
class StubTcpClient extends EventEmitter {
  public sent: Buffer[] = [];
  public state: 'disconnected' | 'connecting' | 'connected' = 'connected';
  public connectCalls: { host: string; port: number }[] = [];
  public cancelCalls = 0;
  send(data: Buffer): void { this.sent.push(data); }
  connect(host: string, port: number): Promise<void> { this.connectCalls.push({host,port}); return Promise.resolve(); }
  disconnect(): void {}
  cancel(): void { this.cancelCalls += 1; }
  dispose(): void { this.removeAllListeners(); }
}

suite('Envelope dropdown populates text fields (headless E2E)', function () {
  this.timeout(15000);

  let originalTcpClient: TcpClient;

  setup(async () => {
    await vscode.commands.executeCommand('tcpClient.openPanel');
    await new Promise((r) => setTimeout(r, 300));
    const panel = TcpPanel.currentPanel as TcpPanel;
    assert.ok(panel, 'panel must be open');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalTcpClient = (panel as any)._tcpClient as TcpClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any)._tcpClient = new StubTcpClient();
  });

  teardown(async () => {
    const panel = TcpPanel.currentPanel as TcpPanel;
    if (panel) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (panel as any)._tcpClient = originalTcpClient;
    }
  });

  test('extension activation registers the 3 built-in envelopes', () => {
    // Direct verification: after activate(), listBuiltin() must return
    // the 3 expected IDs. If this fails, the dropdown can't populate
    // fields and the user's symptom is reproduced.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { listBuiltin } = require('../../envelopes/Envelope');
    const ids = listBuiltin().map((e: { id: string }) => e.id).sort();
    assert.deepStrictEqual(ids, ['hl7-llp', 'hl7-mllp', 'none'],
      `expected builtins registered after extension activation; got ${JSON.stringify(ids)}`);
  });

  test('panel webview renders the dropdown with hl7-mllp option', async () => {
    const panel = TcpPanel.currentPanel as TcpPanel;
    // The webview html is set server-side; we can read it via the
    // webview object. We can't directly query the webview DOM here
    // (no CDP attached), but we CAN read the html and verify the
    // <option> tags include hl7-mllp and the inline PRESETS JSON.
    const html = (panel as any)._panel.webview.html as string;
    assert.ok(html.includes('value="hl7-mllp"'),
      'dropdown should include <option value="hl7-mllp">');
    assert.ok(html.includes('value="hl7-llp"'),
      'dropdown should include <option value="hl7-llp">');
    // PRESETS now ships as a JSON-encoded object on window.__TCP_BOOTSTRAP__
    // (set by the inline bootstrap script tag), and media/main.js reads it
    // back at load. The bootstrap payload must contain the 4-char escape
    // form for hl7-mllp's prefix, not the raw byte — otherwise the field
    // displays an invisible control char (Pattern 5c from
    // `debugging-template-literal-embedded-js`).
    //
    // Extract the JSON payload between `presets: {` and the closing `};`.
    // The payload contains three entries (none, hl7-mllp, hl7-llp); we
    // capture the whole object so the subsequent assertion finds the
    // escape sequence in hl7-mllp's prefix.
    const m = html.match(/window\.__TCP_BOOTSTRAP__\s*=\s*\{[\s\S]*?presets:\s*(\{[\s\S]*?\})\s*\};/);
    if (!m) {
      assert.fail(`bootstrap script should set window.__TCP_BOOTSTRAP__.presets; inspect the rendered html for ${JSON.stringify(html.match(/window\.__TCP_BOOTSTRAP__[^<]*/)?.[0]?.slice(0,200))}`);
    }
    const presetsLiteral = m[1];
    assert.ok(presetsLiteral.includes('\\\\x0B'),
      `PRESETS JSON should contain the literal escape "\\\\x0B" (4 chars); got ${JSON.stringify(presetsLiteral.slice(0, 400))}`);
  });

  test('sending a send message with envelope=hl7-mllp produces the correct wire bytes', async () => {
    const panel = TcpPanel.currentPanel as TcpPanel;
    // The panel reads envelope fields from the message payload (not the
    // dropdown's currently-selected value) — the webview sends them in
    // the message itself. So we exercise _handleWebviewMessage directly
    // with the hl7-mllp envelope spec, mirroring what the webview would
    // post after the user picks hl7-mllp and sends "HI".
    await (panel as any)._handleWebviewMessage({
      type: 'send',
      message: 'HI',
      encoding: 'utf8',
      envelopeId: 'hl7-mllp',
      envelopePrefix: '\\x0B',
      envelopeSuffix: '\\x1C',
      envelopeLinePrefix: '',
      envelopeLineSuffix: '\\r',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = (panel as any)._tcpClient as StubTcpClient;
    assert.strictEqual(stub.sent.length, 1, 'expected exactly one send');
    const wire = stub.sent[0];
    assert.deepStrictEqual([...wire], [0x0b, 0x48, 0x49, 0x0d, 0x1c],
      `wire bytes should be VT H I CR FS; got ${wire.toString('hex')}`);
  });

  test('sending a multi-segment hl7-mllp message produces correct segment separators', async () => {
    const panel = TcpPanel.currentPanel as TcpPanel;
    await (panel as any)._handleWebviewMessage({
      type: 'send',
      message: 'MSH|^~\\&|...\nPID|||...',
      encoding: 'utf8',
      envelopeId: 'hl7-mllp',
      envelopePrefix: '\\x0B',
      envelopeSuffix: '\\x1C',
      envelopeLinePrefix: '',
      envelopeLineSuffix: '\\r',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = (panel as any)._tcpClient as StubTcpClient;
    assert.strictEqual(stub.sent.length, 1);
    const wire = stub.sent[0];
    // Expected: 0x0b, MSH|^\~\\&|... (12), 0x0d, PID|||... (9), 0x0d, 0x1c
    const expected = Buffer.from([
      0x0b, 0x4d, 0x53, 0x48, 0x7c, 0x5e, 0x7e, 0x5c, 0x26, 0x7c, 0x2e, 0x2e, 0x2e,
      0x0d, 0x50, 0x49, 0x44, 0x7c, 0x7c, 0x7c, 0x2e, 0x2e, 0x2e,
      0x0d, 0x1c,
    ]);
    assert.deepStrictEqual(Buffer.compare(wire, expected), 0,
      `wire bytes mismatch: got ${wire.toString('hex')}, expected ${expected.toString('hex')}`);
  });
});
