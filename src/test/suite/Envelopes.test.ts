import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  wrap,
  register,
  get,
  list,
  listBuiltin,
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
});

suite('Envelope – registry (register / get / list)', () => {

  setup(() => { _clearAllForTests(); });
  teardown(() => { _clearAllForTests(); });

  test('register + get round-trip', () => {
    const env: Envelope = {
      id: 'custom-1',
      label: 'Custom One',
      spec: { prefix: '\\xAA', suffix: '\\xBB', linePrefix: '', lineSuffix: '' },
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

  test('hl7-mllp builtin spec has VT prefix, FS suffix, and \\r lineSuffix', () => {
    _clearAllForTests();
    _loadBuiltinsForTests();
    const e = listBuiltin().find((x) => x.id === 'hl7-mllp');
    assert.ok(e, 'hl7-mllp should be a built-in');
    assert.strictEqual(e!.spec.prefix, '\\x0B');
    assert.strictEqual(e!.spec.suffix, '\\x1C');
    assert.strictEqual(e!.spec.lineSuffix, '\\r');
  });

  test('hl7-llp builtin spec has FS suffix and \\r lineSuffix (no VT prefix)', () => {
    _clearAllForTests();
    _loadBuiltinsForTests();
    const e = listBuiltin().find((x) => x.id === 'hl7-llp');
    assert.ok(e, 'hl7-llp should be a built-in');
    assert.strictEqual(e!.spec.prefix, '');
    assert.strictEqual(e!.spec.suffix, '\\x1C');
    assert.strictEqual(e!.spec.lineSuffix, '\\r');
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

  test('resolve(hl7-mllp) returns the MLLP envelope with VT/FS framing and \\r segment terminator', () => {
    const e = resolve('hl7-mllp');
    assert.strictEqual(e.id, 'hl7-mllp');
    const out = wrap(Buffer.from('HI'), e.spec);
    // VT, payload, CR (lineSuffix), FS (suffix) — no synthetic \n for single-line payloads
    assert.deepStrictEqual([...out], [VT, 0x48, 0x49, CR, FS]);
  });

  test('resolve(hl7-llp) returns the LLP envelope with FS suffix and \\r segment terminator', () => {
    const e = resolve('hl7-llp');
    assert.strictEqual(e.id, 'hl7-llp');
    const out = wrap(Buffer.from('HI'), e.spec);
    // payload, CR (lineSuffix), FS (suffix) — no leading VT, no synthetic \n
    assert.deepStrictEqual([...out], [0x48, 0x49, CR, FS]);
  });

  test('resolve(does-not-exist) throws', () => {
    assert.throws(() => resolve('does-not-exist'), /Unknown envelope id: does-not-exist/);
  });
});

suite('Envelope – getAll (built-ins only, no settings source)', () => {

  setup(() => { _clearAllForTests(); _loadBuiltinsForTests(); });

  test('returns only built-in envelopes', () => {
    const all = listBuiltin();
    const ids = all.map((e) => e.id).sort();
    assert.deepStrictEqual(ids, ['hl7-llp', 'hl7-mllp', 'none']);
  });

  test('listBuiltin returns the three standard presets', () => {
    assert.strictEqual(listBuiltin().length, 3);
    const mllp = listBuiltin().find((e) => e.id === 'hl7-mllp');
    assert.ok(mllp);
    assert.strictEqual(mllp.spec.prefix, '\\x0B');
    assert.strictEqual(mllp.spec.suffix, '\\x1C');
    assert.strictEqual(mllp.spec.lineSuffix, '\\r');
  });

  test('resolve("none") returns a passthrough envelope', () => {
    const e = resolve('none');
    assert.strictEqual(e.id, 'none');
    assert.deepStrictEqual(e.spec, { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' });
  });

  test('resolve("hl7-mllp") returns the MLLP envelope', () => {
    const e = resolve('hl7-mllp');
    assert.strictEqual(e.spec.prefix, '\\x0B');
    assert.strictEqual(e.spec.suffix, '\\x1C');
    assert.strictEqual(e.spec.lineSuffix, '\\r');
  });

  test('resolve throws on unknown id (no settings fallback)', () => {
    assert.throws(() => resolve('not-a-real-envelope'), /Unknown envelope id/);
  });
});

suite('Envelope – wrap with arbitrary spec (UI-driven)', () => {

  test('wraps with all four fields populated', () => {
    const payload = Buffer.from('hi');
    const out = wrap(payload, {
      prefix: '\\x0B',
      suffix: '\\x1C\\r',
      linePrefix: '>',
      lineSuffix: '<',
    });
    // Single-line payload: outer wrap of [prefix, >, payload, <, suffix]
    assert.deepStrictEqual([...out], [0x0B, 0x3e, 0x68, 0x69, 0x3c, 0x1c, 0x0d]);
  });

  test('empty fields produce byte-identical output to no envelope', () => {
    const payload = Buffer.from('hello');
    const out = wrap(payload, { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' });
    assert.deepStrictEqual(out, payload);
  });

  test('only linePrefix set: per-line wrap with no outer', () => {
    const payload = Buffer.from('a\nb');
    const out = wrap(payload, { prefix: '', suffix: '', linePrefix: '>', lineSuffix: '' });
    // >a>b — no synthetic \n between wrapped lines; user must include it in payload if wanted
    assert.deepStrictEqual([...out], [0x3e, 0x61, 0x3e, 0x62]);
  });
});

suite('Envelope – wrap with linePrefix/lineSuffix', () => {

  test('linePrefix=""/lineSuffix="" is identical to wrapping once (default)', () => {
    const payload = Buffer.from('line1\nline2\nline3');
    const out = wrap(payload, spec({ prefix: 'P', suffix: 'S' }));
    // No line wrap; whole payload is wrapped once.
    assert.deepStrictEqual([...out], [0x50, ...payload, 0x53]);
  });

  test('linePrefix prepends to every line', () => {
    const payload = Buffer.from('line1\nline2\nline3');
    const out = wrap(payload, spec({ linePrefix: '>' }));
    // >line1>line2>line3 — no synthetic \n between wrapped lines
    assert.deepStrictEqual(
      [...out],
      [0x3e, 0x6c, 0x69, 0x6e, 0x65, 0x31,
              0x3e, 0x6c, 0x69, 0x6e, 0x65, 0x32,
              0x3e, 0x6c, 0x69, 0x6e, 0x65, 0x33]
    );
  });

  test('lineSuffix appends to every line', () => {
    const payload = Buffer.from('a\nb');
    const out = wrap(payload, spec({ lineSuffix: '\\r' }));
    // a\rb\r — no synthetic \n between lines; lineSuffix is the per-line terminator
    assert.deepStrictEqual([...out], [0x61, 0x0d, 0x62, 0x0d]);
  });

  test('combined linePrefix and lineSuffix on every line', () => {
    const payload = Buffer.from('a\nb');
    const out = wrap(payload, spec({ linePrefix: '[', lineSuffix: ']' }));
    // [a][b] — no synthetic \n between lines
    assert.deepStrictEqual([...out], [0x5b, 0x61, 0x5d, 0x5b, 0x62, 0x5d]);
  });

  test('empty payload returns just prefix+suffix', () => {
    const out = wrap(Buffer.alloc(0), spec({ prefix: 'P', suffix: 'S' }));
    assert.deepStrictEqual([...out], [0x50, 0x53]);
  });

  test('trailing newline produces a trailing wrapped empty line', () => {
    const payload = Buffer.from('a\nb\n');
    const out = wrap(payload, spec({ linePrefix: '>' }));
    // >a>b> — three wrapped lines ('a', 'b', and the trailing empty),
    // no synthetic \n between them
    assert.deepStrictEqual(
      [...out],
      [0x3e, 0x61, 0x3e, 0x62, 0x3e]
    );
  });

  test('NRPE-style: combined outer STX/ETX and line prefix/suffix', () => {
    const payload = Buffer.from('LOAD\nCPU\nMEM');
    const out = wrap(payload, spec({
      prefix: '\\x02',          // STX
      suffix: '\\x03',          // ETX
      linePrefix: '>',
      lineSuffix: '<',
    }));
    // Outer STX wraps the whole message; per-line `>` / `<` between STX and
    // ETX; no synthetic \n between wrapped lines (the user's lineSuffix is
    // the per-line terminator). So:
    //   STX >LOAD< >CPU< >MEM< ETX
    // STX=0x02, ETX=0x03, >=0x3e, <=0x3c
    assert.deepStrictEqual(
      [...out],
      [0x02, 0x3e, 0x4c, 0x4f, 0x41, 0x44, 0x3c,
             0x3e, 0x43, 0x50, 0x55, 0x3c,
             0x3e, 0x4d, 0x45, 0x4d, 0x3c, 0x03]
    );
  });

  test('hl7-mllp with multi-line payload produces \\r-terminated segments and \\x1C suffix', () => {
    // User-reported regression: typing "MSH|...\nPID|..." in the textarea
    // and sending with the hl7-mllp envelope must produce \r between segments
    // (not \n), with \x0B at the start and \x1C at the end.
    const payload = Buffer.from('MSH|^~\\&|...\nPID|||...');
    const out = wrap(payload, spec({
      prefix: '\\x0B',
      suffix: '\\x1C',
      linePrefix: '',
      lineSuffix: '\\r',
    }));
    // VT, MSH|..., CR, PID|..., CR, FS
    // MSH|^~\&|... = 12 bytes  (M S H | ^ ~ \ & | . . .)
    // PID|||...     =  9 bytes  (P I D | | | . . .)
    // 1 + 12 + 1 + 9 + 1 + 1 = 25 bytes total
    assert.deepStrictEqual(
      [...out],
      [0x0B,
       0x4d, 0x53, 0x48, 0x7c, 0x5e, 0x7e, 0x5c, 0x26, 0x7c, 0x2e, 0x2e, 0x2e,
       0x0d,
       0x50, 0x49, 0x44, 0x7c, 0x7c, 0x7c, 0x2e, 0x2e, 0x2e,
       0x0d,
       0x1c]
    );
  });

  test('wrap with lineSuffix="\\r" and no internal \\n appends "\\r" once at the end', () => {
    // Single-line case: there's no \n in the payload, so the lineSuffix is
    // still applied exactly once at the end of the line, before the outer
    // suffix bytes.
    const payload = Buffer.from('MSH|^~\\&|...');
    const out = wrap(payload, spec({
      prefix: '\\x0B',
      suffix: '\\x1C',
      linePrefix: '',
      lineSuffix: '\\r',
    }));
    // VT, MSH|..., CR, FS
    assert.deepStrictEqual(
      [...out],
      [0x0B,
       0x4d, 0x53, 0x48, 0x7c, 0x5e, 0x7e, 0x5c, 0x26, 0x7c, 0x2e, 0x2e, 0x2e,
       0x0d,
       0x1c]
    );
  });
});
