import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  substitute,
  lookup,
  formatTimestamp,
  listBuiltin,
  getAll,
  Variable,
  _registerBuiltin,
  _clearAllForTests,
  _loadBuiltinsForTests,
} from '../../variables/Variables';
// Side-effect import: registers the `timestamp` built-in at file load time.
// Tests that clear the registry in setup must call `_loadBuiltinsForTests()`
// to repopulate before exercising functions that depend on built-ins.
import '../../variables/builtins';
import { encodeMessage } from '../../MessageEncoder';
import { TcpPanel } from '../../TcpPanel';
import { TcpClient } from '../../TcpClient';
import { EventEmitter } from 'events';

/**
 * Helper: a fixed `Date` for deterministic timestamp assertions.
 * 2026-07-05T13:45:23.000Z (a memorable Sunday).
 */
const FIXED_NOW = new Date('2026-07-05T13:45:23.000Z');

/**
 * Helper: capture console.warn for one call. Returns `[output, restore]`.
 * Uses a `process.stderr.write` probe because the extension-host console
 * may have non-writable properties — instead we hook `console.warn` and
 * also verify the message hits stdout/stderr in mocha's output.
 */
function captureWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  // Some VS Code test hosts proxy console.warn through non-writable
  // descriptors. Use defineProperty to bypass.
  try {
    Object.defineProperty(console, 'warn', {
      value: (msg: string) => { messages.push(msg); },
      configurable: true,
      writable: true,
    });
  } catch {
    // Fallback: assume writable.
    (console as unknown as { warn: typeof console.warn }).warn =
      (msg: string) => { messages.push(msg); };
  }
  return {
    messages,
    restore: () => {
      try {
        Object.defineProperty(console, 'warn', { value: original, configurable: true, writable: true });
      } catch {
        (console as unknown as { warn: typeof console.warn }).warn = original;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// substitute()
// ---------------------------------------------------------------------------

suite('Variables – substitute', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('{{name}} with a custom variable is replaced with the value', () => {
    const custom: Variable[] = [
      { name: 'user.name', value: 'ryu', builtin: false },
    ];
    assert.strictEqual(
      substitute('Hello {{user.name}}!', custom, FIXED_NOW),
      'Hello ryu!'
    );
  });

  test('{{timestamp}} is replaced with the current ISO 8601 timestamp', () => {
    const vars = listBuiltin();  // [timestamp]
    const result = substitute('at {{timestamp}}', vars, FIXED_NOW);
    assert.strictEqual(result, 'at 2026-07-05T13:45:23.000Z');
  });

  test('{{timestamp}} with a custom format uses that format', async () => {
    // v2: the pipe form `{{timestamp|FMT}}` overrides the live setting
    // for this single reference. The live setting is left untouched here
    // (the v1-style override-by-setting still works in the dedicated
    // `tcpClient.variables.timestampFormat setting is applied` test).
    const vars = listBuiltin()
    const result = substitute('{{timestamp|YYYY/MM/DD}}', vars, FIXED_NOW)
    assert.strictEqual(result, '2026/07/05')
  });

  test('unknown variable is left as {{name}} and a console.warn is emitted', () => {
    const { messages, restore } = captureWarn();
    try {
      const result = substitute('Hello {{nope}}!', [], FIXED_NOW);
      assert.strictEqual(result, 'Hello {{nope}}!');
      assert.ok(
        messages.some((w) => /Unknown variable: nope/.test(w)),
        `expected an "Unknown variable: nope" warning, got: ${JSON.stringify(messages)}`
      );
    } finally {
      restore();
    }
  });

  test('\\{\\{name}} round-trips to literal {{name}} (each brace escaped)', () => {
    // The CORRECT way to send literal {{name}} in a message: escape each brace.
    // Encoder converts each \{ to a literal { byte, giving us the text {{name}}
    // for substitute to see. substitute finds no `name` variable, leaves the
    // reference unchanged (with a warn), and the output is {{name}} literal.
    const input = '\\{\\{name}}';
    const encoded = encodeMessage(input, 'utf8').toString('utf8');
    assert.strictEqual(encoded, '{{name}}');
    assert.strictEqual(
      substitute(encoded, [], FIXED_NOW),
      '{{name}}'
    );
  });

  test('no recursive resolution: substitution happens once', () => {
    // A custom variable whose VALUE itself contains `{{x}}` should NOT
    // trigger a second substitution pass.
    const custom: Variable[] = [
      { name: 'outer', value: '{{inner}}', builtin: false },
      { name: 'inner', value: 'resolved', builtin: false },
    ];
    const result = substitute('{{outer}}', custom, FIXED_NOW);
    assert.strictEqual(result, '{{inner}}');
  });

  test('empty variable list: {{anything}} is left as-is', () => {
    assert.strictEqual(
      substitute('keep {{anything}} here', [], FIXED_NOW),
      'keep {{anything}} here'
    );
  });
});

// ---------------------------------------------------------------------------
// lookup()
// ---------------------------------------------------------------------------

suite('Variables – lookup', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('returns undefined for unknown names', () => {
    const all: Variable[] = [
      { name: 'known', value: 'k', builtin: false },
    ];
    assert.strictEqual(lookup('unknown', all), undefined);
  });

  test('returns the variable for known names', () => {
    const v: Variable = { name: 'known', value: 'k', builtin: false };
    const all: Variable[] = [v, { name: 'other', value: 'o', builtin: false }];
    const got = lookup('known', all);
    assert.ok(got, 'expected a hit');
    assert.strictEqual(got!.name, 'known');
    assert.strictEqual(got!.value, 'k');
  });
});

// ---------------------------------------------------------------------------
// MessageEncoder – escape extension for \{ and \}
// ---------------------------------------------------------------------------

suite('MessageEncoder – escape extension (brace escapes)', () => {

  test('\\{ produces byte 0x7B', () => {
    assert.deepStrictEqual([...encodeMessage('\\{', 'utf8')], [0x7b]);
  });

  test('\\} produces byte 0x7D', () => {
    assert.deepStrictEqual([...encodeMessage('\\}', 'utf8')], [0x7d]);
  });

  test('\\{\\{ produces bytes 0x7B 0x7B (two escaped braces, not a reference)', () => {
    assert.deepStrictEqual([...encodeMessage('\\{\\{', 'utf8')], [0x7b, 0x7b]);
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp() — minimal token coverage
// ---------------------------------------------------------------------------

suite('formatTimestamp', () => {

  test('default format produces ISO 8601 with milliseconds and Z suffix', () => {
    assert.strictEqual(
      formatTimestamp(FIXED_NOW, 'YYYY-MM-DDTHH:mm:ss.sssZ'),
      '2026-07-05T13:45:23.000Z'
    );
  });

  test('custom format YYYY/MM/DD renders correctly', () => {
    assert.strictEqual(formatTimestamp(FIXED_NOW, 'YYYY/MM/DD'), '2026/07/05');
  });

  test('unsupported token falls back to default with a console.warn', () => {
    const { messages, restore } = captureWarn();
    try {
      const result = formatTimestamp(FIXED_NOW, 'Q');
      assert.strictEqual(result, '2026-07-05T13:45:23.000Z');
      assert.ok(
        messages.some((w) => /Unsupported timestamp format token/.test(w)),
        `expected a fallback warning, got: ${JSON.stringify(messages)}`
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Live configuration — proves the package.json schema entries are wired up
// and `Variables.ts` reads them at substitution time.
// ---------------------------------------------------------------------------

suite('Variables – live configuration', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('getCustom reads tcpClient.variables.custom from settings and substitute uses it', async () => {
    // Set the custom variables setting
    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.custom',
      [{ name: 'user.name', value: 'ryu' }, { name: 'host', value: 'server-01' }],
      vscode.ConfigurationTarget.Global
    )

    // Re-read; getCustom must pick up the new value
    const all = getAll()
    const result = substitute('Hello {{user.name}} from {{host}}', all, FIXED_NOW)
    assert.strictEqual(result, 'Hello ryu from server-01')

    // Clean up
    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.custom',
      [],
      vscode.ConfigurationTarget.Global
    )
  })

  test('tcpClient.variables.timestampFormat setting is applied to {{timestamp}}', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.timestampFormat',
      'YYYY/MM/DD',
      vscode.ConfigurationTarget.Global
    )

    const all = getAll()
    const result = substitute('{{timestamp}}', all, FIXED_NOW)
    assert.strictEqual(result, '2026/07/05')

    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.timestampFormat',
      undefined,  // reset to default
      vscode.ConfigurationTarget.Global
    )
  })
})

// ---------------------------------------------------------------------------
// TcpPanel.send pipeline — substitution must happen BEFORE encode+wrap so the
// bytes written to the socket contain the substituted value, not the
// {{name}} reference. We open the real panel, swap its TcpClient for a
// capturing stub, drive _handleWebviewMessage directly, and inspect the
// buffer the panel would have written to the socket.
// ---------------------------------------------------------------------------

/**
 * Stub TcpClient that pretends to be connected and captures every Buffer
 * passed to `send()`. Mirrors the EventEmitter surface TcpPanel listens on.
 */
class StubTcpClient extends EventEmitter {
  public sent: Buffer[] = [];
  public state: 'disconnected' | 'connecting' | 'connected' = 'connected';
  // The TcpClient.send signature is `send(data: Buffer): void`.
  send(data: Buffer): void { this.sent.push(data); }
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void { /* no-op */ }
  dispose(): void { this.removeAllListeners(); }
}

suite('TcpPanel.send – variable substitution before encode+wrap', function () {
  // Allow time for the panel to initialise on load.
  this.timeout(5000);

  let panel: TcpPanel;
  let stub: StubTcpClient;
  let originalTcpClient: TcpClient;

  setup(async () => {
    // Open the panel; createOrShow is idempotent for an already-open panel.
    await vscode.commands.executeCommand('tcpClient.openPanel');
    // Give the panel a moment to instantiate and set currentPanel.
    await new Promise((r) => setTimeout(r, 200));
    panel = TcpPanel.currentPanel as TcpPanel;
    assert.ok(panel, 'TcpPanel.currentPanel should be set after openPanel command');

    // Swap the real TcpClient for a stub that captures what would be
    // written to the socket. The panel's `_tcpClient` is private; reach
    // in via bracket notation to install the stub for the duration of
    // the test, and restore the original in teardown.
    stub = new StubTcpClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalTcpClient = (panel as any)._tcpClient as TcpClient;
    (panel as any)._tcpClient = stub;
  });

  teardown(async () => {
    if (panel && originalTcpClient) {
      (panel as any)._tcpClient = originalTcpClient;
    }
    // Reset the setting so the test is hermetic.
    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.custom',
      [],
      vscode.ConfigurationTarget.Global
    );
  });

  test('panel.send substitutes {{name}} BEFORE the bytes hit the socket', async () => {
    // Set a custom variable in the same settings the live read path uses.
    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.custom',
      [{ name: 'user.name', value: 'ryu' }],
      vscode.ConfigurationTarget.Global
    );

    // Drive the panel's send path with a {{user.name}} reference.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any)._handleWebviewMessage({
      type: 'send',
      message: 'Hello {{user.name}}!',
      encoding: 'utf8',
      envelope: 'none',
    });

    assert.strictEqual(stub.sent.length, 1, 'panel should have sent exactly one buffer');
    const sent = stub.sent[0];
    assert.strictEqual(
      sent.toString('utf8'),
      'Hello ryu!',
      'bytes on the socket must contain the substituted value, not the {{name}} reference'
    );
  });

  test('{{seq}} is substituted using the panel\'s seq counter, incremented on each send', async () => {
    // The seq counter is shared across tests in this suite (the panel
    // is reopened once, not per-test). Reset it to a known value at
    // the start of this test so the assertions don't depend on what
    // ran before.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any)._seq = 1;

    // Send three messages in quick succession. Each one should
    // capture the current _seq (1, 2, 3), and after each send the
    // counter should advance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any)._handleWebviewMessage({
      type: 'send',
      message: 'seq={{seq}}',
      encoding: 'utf8',
      envelope: 'none',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(
      (panel as any)._seq,
      2,
      'after first send the seq counter should be 2'
    );
    assert.strictEqual(stub.sent[stub.sent.length - 1].toString('utf8'), 'seq=1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any)._handleWebviewMessage({
      type: 'send',
      message: 'seq={{seq}}',
      encoding: 'utf8',
      envelope: 'none',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(
      (panel as any)._seq,
      3,
      'after second send the seq counter should be 3'
    );
    assert.strictEqual(stub.sent[stub.sent.length - 1].toString('utf8'), 'seq=2');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any)._handleWebviewMessage({
      type: 'send',
      message: 'seq={{seq}}',
      encoding: 'utf8',
      envelope: 'none',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(
      (panel as any)._seq,
      4,
      'after third send the seq counter should be 4'
    );
    assert.strictEqual(stub.sent[stub.sent.length - 1].toString('utf8'), 'seq=3');

    // The first three captured buffers (this test's three sends, since
    // the previous test added one too — confirm via the last three) hold
    // seq=1, seq=2, seq=3 in order.
    const tail = stub.sent.slice(-3).map((b) => b.toString('utf8'));
    assert.deepStrictEqual(tail, ['seq=1', 'seq=2', 'seq=3']);
  });

  // NOTE: globalState-driven "message text persists across panel
  // close+reopen" is intentionally not unit-tested here. globalState
  // is per-extension-context, and the panel created in setup() above
  // shares that context — there's no clean way to dispose+reopen in
  // isolation without invasive globals. The `.hermes-plan-variables-pipe.md`
  // manual smoke test covers this end-to-end.
});

// ---------------------------------------------------------------------------
// Variables v2 — pipe syntax, seq, uuid, epoch tokens. All behaviour
// described in `.hermes-plan-variables-pipe.md` (Task A).
// ---------------------------------------------------------------------------

suite('Variables – v2 pipe syntax', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('{{timestamp|format}} with custom format overrides the setting', () => {
    const vars = listBuiltin();
    const result = substitute('{{timestamp|YYYY-MM-DD}}', vars, FIXED_NOW);
    assert.strictEqual(result, '2026-07-05');
  });

  test('{{timestamp|format}} with format containing epoch token X', () => {
    const vars = listBuiltin();
    const result = substitute('{{timestamp|X}}', vars, FIXED_NOW);
    assert.strictEqual(
      result,
      Math.floor(FIXED_NOW.getTime() / 1000).toString()
    );
  });

  test('{{timestamp|format}} with format containing epoch ms token x', () => {
    const vars = listBuiltin();
    const result = substitute('{{timestamp|x}}', vars, FIXED_NOW);
    assert.strictEqual(result, FIXED_NOW.getTime().toString());
  });

  test('{{seq}} returns the seq from state', () => {
    const vars = listBuiltin();
    const result = substitute('seq={{seq}}', vars, FIXED_NOW, { seq: 7 });
    assert.strictEqual(result, 'seq=7');
  });

  test('{{seq}} without state falls back to 1 with a warn', () => {
    const { messages, restore } = captureWarn();
    try {
      const vars = listBuiltin();
      const result = substitute('seq={{seq}}', vars, FIXED_NOW, {});
      assert.strictEqual(result, 'seq=1');
      assert.ok(
        messages.some((w) => /seq/i.test(w)),
        `expected a "seq" warning, got: ${JSON.stringify(messages)}`
      );
    } finally {
      restore();
    }
  });

  test("{{seq|anything}} ignores the pipe and still returns seq", () => {
    const vars = listBuiltin();
    const result = substitute('{{seq|foo}}', vars, FIXED_NOW, { seq: 42 });
    assert.strictEqual(result, '42');
  });

  test('{{uuid}} produces a valid UUID v4', () => {
    const vars = listBuiltin();
    const result = substitute('{{uuid}}', vars, FIXED_NOW);
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result),
      `expected a UUID v4, got: ${JSON.stringify(result)}`
    );
  });

  test("{{uuid|anything}} ignores the pipe and still returns a UUID", () => {
    const vars = listBuiltin();
    const result = substitute('{{uuid|foo}}', vars, FIXED_NOW);
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result),
      `expected a UUID v4, got: ${JSON.stringify(result)}`
    );
  });

  test("{{user.name|foo}} silently strips the pipe and substitutes the value", () => {
    const custom: Variable[] = [
      { name: 'user.name', value: 'ryu', builtin: false },
    ];
    const result = substitute('{{user.name|foo}}', custom, FIXED_NOW);
    assert.strictEqual(result, 'ryu');
  });

  test("{{unknown|foo}} unknown with pipe leaves the whole reference verbatim with a warn", () => {
    const { messages, restore } = captureWarn();
    try {
      const result = substitute('{{unknown|foo}}', [], FIXED_NOW);
      assert.strictEqual(result, '{{unknown|foo}}');
      assert.ok(
        messages.some((w) => /Unknown variable: unknown/.test(w)),
        `expected an "Unknown variable: unknown" warning, got: ${JSON.stringify(messages)}`
      );
    } finally {
      restore();
    }
  });

  test('formatTimestamp with X token returns epoch seconds', () => {
    assert.strictEqual(
      formatTimestamp(FIXED_NOW, 'X'),
      Math.floor(FIXED_NOW.getTime() / 1000).toString()
    );
  });

  test('formatTimestamp with x token returns epoch milliseconds', () => {
    assert.strictEqual(
      formatTimestamp(FIXED_NOW, 'x'),
      FIXED_NOW.getTime().toString()
    );
  });

  test('formatTimestamp with mixed tokens including X works', () => {
    assert.strictEqual(
      formatTimestamp(FIXED_NOW, 'YYYY-MM-DD X'),
      '2026-07-05 ' + Math.floor(FIXED_NOW.getTime() / 1000).toString()
    );
  });
});
