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
    // Override the live tcpClient.variables.timestampFormat setting —
    // substitute() reads this setting fresh on every call (Task 1 commit 2e13504),
    // so the user-configured format takes precedence over the seed built-in format.
    await vscode.workspace.getConfiguration('tcpClient').update(
      'variables.timestampFormat',
      'YYYY/MM/DD',
      vscode.ConfigurationTarget.Global
    )
    try {
      const vars = listBuiltin()
      const result = substitute('{{timestamp}}', vars, FIXED_NOW)
      assert.strictEqual(result, '2026/07/05')
    } finally {
      // Reset to default so subsequent tests are unaffected.
      await vscode.workspace.getConfiguration('tcpClient').update(
        'variables.timestampFormat',
        undefined,
        vscode.ConfigurationTarget.Global
      )
    }
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
});
