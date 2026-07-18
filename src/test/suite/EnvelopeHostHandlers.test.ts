import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  sanitizeId,
  uniqueId,
  readCustomEnvelopes,
  handleSaveEnvelope,
  handleDeleteEnvelope,
  buildEnvelopeListForWebview,
  BUILTIN_IDS,
} from '../../envelopes/hostHandlers';
import { _clearAllForTests, _loadBuiltinsForTests } from '../../envelopes/Envelope';
import {
  maybePrefillHL7Envelopes,
  prefillHL7EnvelopesCommand,
  HL7_PRESETS,
  HL7_PREFILL_FLAG_KEY,
} from '../../envelopes/prefill';

// Minimal ExtensionContext stub — `maybePrefillHL7Envelopes` reads only
// `globalState.get` and `globalState.update`. The in-memory store below
// is enough to test the gate + idempotency semantics.
function makeFakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        return store.has(key) ? (store.get(key) as T) : defaultValue;
      },
      update: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

suite('EnvelopeHostHandlers – id utilities', () => {
  // id utilities only; read/build + save/delete + concurrent live
  // in their own suites further down.
  test('sanitizeId lowercases and replaces non-id chars', () => {
    assert.strictEqual(sanitizeId('Hello World'), 'hello-world');
    assert.strictEqual(sanitizeId('STX/ETX framed!'), 'stx-etx-framed');
    assert.strictEqual(sanitizeId('  spaced  out  '), 'spaced-out');
    assert.strictEqual(sanitizeId('already-valid'), 'already-valid');
  });

  test('sanitizeId returns empty string for label with no alphanumeric chars', () => {
    assert.strictEqual(sanitizeId('!!!'), '');
    assert.strictEqual(sanitizeId('   '), '');
    assert.strictEqual(sanitizeId('---'), '');
    assert.strictEqual(sanitizeId(''), '');
  });

  test('sanitizeId collapses runs of non-id chars into single dash', () => {
    assert.strictEqual(sanitizeId('a    b'), 'a-b');
    assert.strictEqual(sanitizeId('a!!!b???c'), 'a-b-c');
  });

  test('uniqueId returns base when unused', () => {
    assert.strictEqual(uniqueId('hl7', new Set(['other'])), 'hl7');
    assert.strictEqual(uniqueId('hl7', new Set()), 'hl7');
  });

  test('uniqueId appends -2, -3 on collision', () => {
    const used = new Set(['hl7', 'hl7-2']);
    assert.strictEqual(uniqueId('hl7', used), 'hl7-3');
  });
});

suite('EnvelopeHostHandlers – read/build', () => {
  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
  });

  test('readCustomEnvelopes returns empty array when setting is missing', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', undefined, vscode.ConfigurationTarget.Global
    );
    assert.deepStrictEqual(readCustomEnvelopes(), []);
  });

  test('buildEnvelopeListForWebview includes built-ins + custom in order', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [{ id: 'my-preset', label: 'My Preset' }], vscode.ConfigurationTarget.Global
    );
    const list = buildEnvelopeListForWebview();
    assert.deepStrictEqual(list.map((e) => e.id), ['none', 'hl7-mllp', 'hl7-llp', 'my-preset']);
  });
});

suite('EnvelopeHostHandlers – handleSaveEnvelope', () => {
  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
  });

  test('writes a new envelope and returns it', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    const result = await handleSaveEnvelope({
      label: 'STX/ETX',
      prefix: '\\x02',
      suffix: '\\x03',
      linePrefix: '',
      lineSuffix: '',
    });
    assert.ok(result.envelope, 'should return an envelope');
    assert.strictEqual(result.envelope!.id, 'stx-etx');
    assert.strictEqual(result.envelope!.label, 'STX/ETX');
    assert.strictEqual(result.envelope!.prefix, '\\x02');
    // Persisted to settings:
    const stored = readCustomEnvelopes();
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].id, 'stx-etx');
  });

  test('rejects empty label', async () => {
    const result = await handleSaveEnvelope({
      label: '   ', prefix: '', suffix: '', linePrefix: '', lineSuffix: '',
    });
    assert.strictEqual(result.envelope, null);
    assert.match(result.reason!, /cannot be empty|letter or digit/);
  });

  test('rejects label with no alphanumeric chars (empty sanitized id)', async () => {
    const result = await handleSaveEnvelope({
      label: '!!!', prefix: '', suffix: '', linePrefix: '', lineSuffix: '',
    });
    assert.strictEqual(result.envelope, null);
    assert.match(result.reason!, /letter or digit/);
  });

  test('generates unique id on collision with existing custom', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [{ id: 'stx-etx', label: 'STX/ETX' }], vscode.ConfigurationTarget.Global
    );
    const result = await handleSaveEnvelope({
      label: 'STX/ETX', prefix: '', suffix: '', linePrefix: '', lineSuffix: '',
    });
    assert.ok(result.envelope);
    assert.strictEqual(result.envelope!.id, 'stx-etx-2');
  });

  test('rejects built-in id collision (no shadowing via Save)', async () => {
    // Plan: built-in collisions reject with feedback, not rename.
    // The user's intent to shadow a built-in gets a clear error rather
    // than a renamed preset they didn't ask for.
    const result = await handleSaveEnvelope({
      label: 'hl7-mllp', prefix: '', suffix: '', linePrefix: '', lineSuffix: '',
    });
    assert.strictEqual(result.envelope, null);
    assert.match(result.reason!, /built-in envelope id/);
    // Settings unchanged:
    const stored = readCustomEnvelopes();
    assert.strictEqual(stored.length, 0);
  });

  test('preserves the raw escape-sequence strings the user typed', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    const result = await handleSaveEnvelope({
      label: 'Raw bytes',
      prefix: '\\x0B\\x0B',   // 4 + 4 = 8 chars (the user-typed form)
      suffix: '\\x1C',
      linePrefix: '',
      lineSuffix: '\\r',
    });
    assert.ok(result.envelope);
    assert.strictEqual(result.envelope!.prefix, '\\x0B\\x0B');
    assert.strictEqual(result.envelope!.suffix, '\\x1C');
    assert.strictEqual(result.envelope!.lineSuffix, '\\r');
  });
});

suite('EnvelopeHostHandlers – handleDeleteEnvelope', () => {
  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
  });

  test('removes the envelope by id', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom',
      [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      vscode.ConfigurationTarget.Global
    );
    const result = await handleDeleteEnvelope('a');
    assert.strictEqual(result.deleted, true);
    const stored = readCustomEnvelopes();
    assert.deepStrictEqual(stored.map((e) => e.id), ['b']);
  });

  test('refuses to delete built-in envelopes', async () => {
    for (const id of BUILTIN_IDS) {
      const result = await handleDeleteEnvelope(id);
      assert.strictEqual(result.deleted, false, `should refuse ${id}`);
      assert.match(result.reason!, /Built-in/);
    }
  });

  test('returns deleted=false when id not found', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [{ id: 'a', label: 'A' }], vscode.ConfigurationTarget.Global
    );
    const result = await handleDeleteEnvelope('nonexistent');
    assert.strictEqual(result.deleted, false);
    assert.match(result.reason!, /not found|No custom/);
  });

  test('rejects empty id', async () => {
    const result = await handleDeleteEnvelope('');
    assert.strictEqual(result.deleted, false);
  });
});

suite('Prefill – maybePrefillHL7Envelopes', () => {
  teardown(async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
  });

  test('first call appends both HL7 presets and sets the flag', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    const ctx = makeFakeContext();
    const result = await maybePrefillHL7Envelopes(ctx);
    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.added, 2);
    const stored = readCustomEnvelopes();
    assert.deepStrictEqual(
      stored.map((e) => e.id).sort(),
      ['hl7-llp', 'hl7-mllp']
    );
    // Flag set:
    assert.strictEqual(ctx.globalState.get(HL7_PREFILL_FLAG_KEY), true);
  });

  test('second call is a no-op (flag gates idempotency)', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    const ctx = makeFakeContext();
    await maybePrefillHL7Envelopes(ctx);
    const result2 = await maybePrefillHL7Envelopes(ctx);
    assert.strictEqual(result2.ran, false);
    assert.strictEqual(result2.added, 0);
    // Still exactly two HL7 entries — the second call didn't append a duplicate.
    const stored = readCustomEnvelopes();
    assert.strictEqual(stored.length, 2);
  });

  test('does not duplicate presets the user already added by hand', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom',
      [{ id: 'hl7-mllp', label: 'My custom HL7', prefix: '\\x0B', suffix: '\\x1C', lineSuffix: '\\r' }],
      vscode.ConfigurationTarget.Global
    );
    const ctx = makeFakeContext();
    const result = await maybePrefillHL7Envelopes(ctx);
    assert.strictEqual(result.ran, true);
    // hl7-mllp was already there, hl7-llp is new:
    assert.strictEqual(result.added, 1);
    const stored = readCustomEnvelopes();
    assert.strictEqual(stored.length, 2);
    assert.strictEqual(stored.find((e) => e.id === 'hl7-mllp')!.label, 'My custom HL7');
  });
});

suite('Prefill – prefillHL7EnvelopesCommand', () => {
  teardown(async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
  });

  test('appends HL7 presets when none present', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    const result = await prefillHL7EnvelopesCommand();
    assert.strictEqual(result.replaced, 0);
    assert.strictEqual(result.total, 2);
    const stored = readCustomEnvelopes();
    assert.strictEqual(stored.length, 2);
  });

  test('replaces existing HL7 entries with the canonical preset definitions', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom',
      [
        { id: 'hl7-mllp', label: 'My tweaked HL7', prefix: '', suffix: '\\x1C', lineSuffix: '\\n' },
        { id: 'mine', label: 'My custom', prefix: '\\x02', suffix: '\\x03' },
      ],
      vscode.ConfigurationTarget.Global
    );
    const result = await prefillHL7EnvelopesCommand();
    assert.strictEqual(result.replaced, 1);
    assert.strictEqual(result.total, 3);   // mine + hl7-mllp + hl7-llp
    const stored = readCustomEnvelopes();
    // The hl7-mllp entry now matches the canonical preset:
    assert.strictEqual(stored.find((e) => e.id === 'hl7-mllp')!.label, 'HL7 v2 (MLLP framing)');
    assert.strictEqual(stored.find((e) => e.id === 'hl7-mllp')!.prefix, '\\x0B');
    // The user's non-HL7 entry is preserved untouched:
    const mine = stored.find((e) => e.id === 'mine');
    assert.ok(mine);
    assert.strictEqual(mine!.label, 'My custom');
    assert.strictEqual(mine!.prefix, '\\x02');
  });

  test('does not affect the globalState flag', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    const ctx = makeFakeContext();
    await prefillHL7EnvelopesCommand();
    // Manual command is independent of the auto-prefill flag.
    assert.strictEqual(ctx.globalState.get(HL7_PREFILL_FLAG_KEY), undefined);
    // ... and a subsequent auto-prefill still runs:
    const auto = await maybePrefillHL7Envelopes(ctx);
    assert.strictEqual(auto.ran, true);
    assert.strictEqual(auto.added, 0);   // HL7 already there from manual call
  });

  test('HL7_PRESETS exports exactly the two built-ins', () => {
    assert.deepStrictEqual(
      HL7_PRESETS.map((p) => p.id).sort(),
      ['hl7-llp', 'hl7-mllp']
    );
  });
});

suite('EnvelopeHostHandlers – concurrent writes', () => {
  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
  });

  test('rapid concurrent saves with distinct labels both land', async () => {
    await vscode.workspace.getConfiguration('tcpClient').update(
      'envelopes.custom', [], vscode.ConfigurationTarget.Global
    );
    // Without the Promise-chain serialization, these two reads see the
    // same baseline, both compute a non-colliding id, and the second
    // write clobbers the first. With the chain, they're serialized:
    // the second reads the first's output and appends.
    const [a, b] = await Promise.all([
      handleSaveEnvelope({ label: 'Alpha', prefix: '', suffix: '', linePrefix: '', lineSuffix: '' }),
      handleSaveEnvelope({ label: 'Beta',  prefix: '', suffix: '', linePrefix: '', lineSuffix: '' }),
    ]);
    assert.ok(a.envelope, 'alpha should succeed');
    assert.ok(b.envelope, 'beta should succeed');
    const stored = readCustomEnvelopes();
    const storedIds = stored.map((e) => e.id).sort();
    assert.deepStrictEqual(storedIds, ['alpha', 'beta']);
  });
});