import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  wrap,
  register,
  get,
  list,
  listBuiltin,
  getCustom,
  getAll,
  resolve,
  Envelope,
  EnvelopeSpec,
  _registerBuiltin,
  _resetForTests,
  _clearAllForTests,
  _loadBuiltinsForTests,
} from '../../envelopes/Envelope';
// Importing for the side effect: registers none / hl7-mllp / hl7-llp builtins
// into the registry at file load time. Tests that clear the registry in
// setup must call `_loadBuiltinsForTests()` to repopulate before exercising
// functions that depend on built-ins.
import '../../envelopes/builtins';

/**
 * Custom-envelope test strategy
 * -----------------------------
 * `getCustom()` reads from `vscode.workspace.getConfiguration('tcpClient')`
 * via the standard VS Code configuration API. In the VS Code test runner
 * (`@vscode/test-electron`) we can write to the configuration scope, so
 * the test uses `config.update(..., ConfigurationTarget.Global)` to seed
 * and then clears it back to `[]` to avoid bleeding into other tests.
 *
 * The ConfigurationTarget is the global user settings. Tests that touch
 * this scope are isolated by the `setup`/`teardown` block, which always
 * resets to `[]` regardless of what the test set.
 */

const VT = 0x0b; // \x0B  — MLLP start byte
const FS = 0x1c; // \x1C  — MLLP end byte (file separator)
const CR = 0x0d; // \r    — MLLP end byte (carriage return)
const STX = 0x02; // \x02
const ETX = 0x03; // \x03

function spec(partial: Partial<EnvelopeSpec>): EnvelopeSpec {
  return {
    prefix: '',
    suffix: '',
    segmentSeparator: '',
    linePrefix: '',
    lineSuffix: '',
    ...partial,
  };
}

suite('Envelope – wrap', () => {

  test('empty prefix and suffix is identity', () => {
    const payload = Buffer.from('hello');
    const out = wrap(payload, spec({}));
    assert.deepStrictEqual([...out], [...payload]);
  });

  test('empty prefix and suffix with empty payload', () => {
    const out = wrap(Buffer.alloc(0), spec({}));
    assert.strictEqual(out.length, 0);
  });

  test('HL7 MLLP adds VT (0x0B) prefix and FS+CR (0x1C 0x0D) suffix', () => {
    const payload = Buffer.from('MSH|^~\\&|...');
    const out = wrap(payload, spec({ prefix: '\\x0B', suffix: '\\x1C\\r' }));
    assert.deepStrictEqual(
      [...out],
      [VT, ...payload, FS, CR]
    );
  });

  test('HL7 LLP (no VT) adds only FS+CR suffix', () => {
    const payload = Buffer.from('MSH|^~\\&|...');
    const out = wrap(payload, spec({ prefix: '', suffix: '\\x1C\\r' }));
    assert.deepStrictEqual(
      [...out],
      [...payload, FS, CR]
    );
  });

  test('custom envelope wraps with STX/ETX', () => {
    const payload = Buffer.from([0x10, 0x20, 0x30]);
    const out = wrap(payload, spec({ prefix: '\\x02', suffix: '\\x03' }));
    assert.deepStrictEqual(
      [...out],
      [STX, 0x10, 0x20, 0x30, ETX]
    );
  });

  test('wrap supports all escape-sequence forms in prefix/suffix', () => {
    const payload = Buffer.from('P');
    const out = wrap(payload, spec({ prefix: '\\n\\r\\t\\\\\\0\\x41', suffix: '' }));
    // \n  \r  \t  \\  \0  \x41  =  0A 0D 09 5C 00 41
    assert.deepStrictEqual([...out], [0x0a, 0x0d, 0x09, 0x5c, 0x00, 0x41, 0x50]);
  });

  test('segmentSeparator is informational only (not applied to payload)', () => {
    // User typed segments separated by \n; the segmentSeparator=\r field
    // should not transform the payload in v1.
    const payload = Buffer.from('A\nB\nC');
    const out = wrap(payload, spec({ segmentSeparator: '\\r' }));
    assert.deepStrictEqual([...out], [...payload]);
  });
});

suite('Envelope – registry (register / get / list)', () => {

  setup(() => { _clearAllForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('register + get round-trip', () => {
    const env: Envelope = {
      id: 'custom-1',
      label: 'Custom One',
      spec: { prefix: '\\xAA', suffix: '\\xBB', segmentSeparator: '', linePrefix: '', lineSuffix: '' },
    };
    register(env);
    const got = get('custom-1');
    assert.deepStrictEqual(got, env);
  });

  test('get returns undefined for unknown id', () => {
    assert.strictEqual(get('does-not-exist'), undefined);
  });

  test('list returns every registered envelope', () => {
    register({ id: 'a', label: 'A', spec: spec({}) });
    register({ id: 'b', label: 'B', spec: spec({}) });
    const ids = list().map((e) => e.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b']);
  });

  test('register overwrites existing entry with same id', () => {
    register({ id: 'dup', label: 'first', spec: spec({ prefix: 'A' }) });
    register({ id: 'dup', label: 'second', spec: spec({ prefix: 'B' }) });
    const got = get('dup');
    assert.ok(got);
    assert.strictEqual(got!.label, 'second');
  });

  test('listBuiltin reflects only builtins registered via _registerBuiltin', () => {
    _registerBuiltin({ id: 'builtin-1', label: 'B1', spec: spec({}) });
    register({ id: 'runtime-1', label: 'R1', spec: spec({}) });
    const ids = listBuiltin().map((e) => e.id);
    assert.deepStrictEqual(ids, ['builtin-1']);
    assert.ok(list().map((e) => e.id).includes('runtime-1'));
  });
});

suite('Envelope – builtins (none / hl7-mllp / hl7-llp)', () => {

  test('none / hl7-mllp / hl7-llp are registered as builtins', () => {
    // The side-effect import at the top of this file populates these at
    // module load time. Earlier suites in this file may have cleared the
    // registry; reload the builtins to make this test self-contained.
    _clearAllForTests();
    _loadBuiltinsForTests();
    const ids = listBuiltin().map((e) => e.id).sort();
    assert.deepStrictEqual(ids, ['hl7-llp', 'hl7-mllp', 'none']);
  });

  test('hl7-mllp builtin spec has VT prefix and FS+CR suffix', () => {
    _clearAllForTests();
    _loadBuiltinsForTests();
    const e = listBuiltin().find((x) => x.id === 'hl7-mllp');
    assert.ok(e, 'hl7-mllp should be a built-in');
    assert.strictEqual(e!.spec.prefix, '\\x0B');
    assert.strictEqual(e!.spec.suffix, '\\x1C\\r');
    assert.strictEqual(e!.spec.segmentSeparator, '\\r');
  });
});

suite('Envelope – resolve', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('resolve(none) returns the passthrough envelope', () => {
    const e = resolve('none');
    assert.strictEqual(e.id, 'none');
    assert.strictEqual(e.spec.prefix, '');
    assert.strictEqual(e.spec.suffix, '');
    // Verify behaviour: wrap is a no-op
    const out = wrap(Buffer.from('XYZ'), e.spec);
    assert.deepStrictEqual([...out], [0x58, 0x59, 0x5a]);
  });

  test('resolve(hl7-mllp) returns the MLLP envelope with VT/FS+CR framing', () => {
    const e = resolve('hl7-mllp');
    assert.strictEqual(e.id, 'hl7-mllp');
    const out = wrap(Buffer.from('HI'), e.spec);
    assert.deepStrictEqual([...out], [VT, 0x48, 0x49, FS, CR]);
  });

  test('resolve(hl7-llp) returns the LLP envelope with FS+CR suffix only', () => {
    const e = resolve('hl7-llp');
    assert.strictEqual(e.id, 'hl7-llp');
    const out = wrap(Buffer.from('HI'), e.spec);
    assert.deepStrictEqual([...out], [0x48, 0x49, FS, CR]);
  });

  test('resolve(does-not-exist) throws', () => {
    assert.throws(() => resolve('does-not-exist'), /Unknown envelope id: does-not-exist/);
  });
});

suite('Envelope – getCustom (reads VS Code configuration)', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });

  teardown(async () => {
    // Always restore the setting to its empty default so we don't pollute
    // other tests or the user's settings.
    await vscode.workspace
      .getConfiguration('tcpClient')
      .update('envelopes.custom', [], vscode.ConfigurationTarget.Global);
  });

  test('returns [] when no custom envelopes are configured', async () => {
    await vscode.workspace
      .getConfiguration('tcpClient')
      .update('envelopes.custom', [], vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(getCustom(), []);
  });

  test('reads a custom envelope from tcpClient.envelopes.custom', async () => {
    await vscode.workspace
      .getConfiguration('tcpClient')
      .update(
        'envelopes.custom',
        [
          {
            id: 'my-hl7',
            label: 'My HL7 Wrapper',
            prefix: '\\x0B',
            suffix: '\\x1C\\r',
            segmentSeparator: '\\r',
          },
        ],
        vscode.ConfigurationTarget.Global
      );
    const custom = getCustom();
    assert.strictEqual(custom.length, 1);
    assert.strictEqual(custom[0].id, 'my-hl7');
    assert.strictEqual(custom[0].label, 'My HL7 Wrapper');
    assert.strictEqual(custom[0].spec.prefix, '\\x0B');
    assert.strictEqual(custom[0].spec.suffix, '\\x1C\\r');
    assert.strictEqual(custom[0].spec.segmentSeparator, '\\r');
  });

  test('skips malformed entries (missing id or label)', async () => {
    await vscode.workspace
      .getConfiguration('tcpClient')
      .update(
        'envelopes.custom',
        [
          { id: 'ok', label: 'OK', prefix: 'P', suffix: 'S' },
          { id: 'no-label' as unknown as string /* label missing */ },
          { label: 'no-id' } as unknown as { id: string },
        ],
        vscode.ConfigurationTarget.Global
      );
    const ids = getCustom().map((e) => e.id);
    assert.deepStrictEqual(ids, ['ok']);
  });

  test('getAll returns builtins first then custom', async () => {
    await vscode.workspace
      .getConfiguration('tcpClient')
      .update(
        'envelopes.custom',
        [{ id: 'cust-1', label: 'Cust 1', prefix: '', suffix: '' }],
        vscode.ConfigurationTarget.Global
      );
    const all = getAll();
    const builtinIds = all.slice(0, listBuiltin().length).map((e) => e.id);
    const customIds = all.slice(listBuiltin().length).map((e) => e.id);
    // Builtins (from the side-effect import) are first
    assert.ok(builtinIds.includes('none'));
    assert.ok(builtinIds.includes('hl7-mllp'));
    // Custom comes after
    assert.ok(customIds.includes('cust-1'));
  });
});
