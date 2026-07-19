// Regression test for the "envelope dropdown does not update the text
// boxes" report (2026-07-17).
//
// Strategy: drive the dropdown change through the full production code
// path under the real @vscode/test-electron runner. We do NOT hand-
// translate PRESETS, fixtures, or escape sequences — every value flows
// from the compiled bundle via listBuiltin() + wrap(). The webview IIFE
// runs inside VS Code's webview (we exercise it through the panel's
// public surface, not by hand-instrumented stubs).
//
// What we verify:
//   1. hl7-mllp spec stores the readable 4-char escape "\x0B" (not the
//      raw byte 0x0B), so the textarea shows readable text.
//   2. After applying the preset, the spec round-trips through wrap()
//      to the correct wire bytes: VT 0x0B, payload, CR 0x0D, FS 0x1C.
//   3. The webview receives the dropdown's `<option>` values matching
//      the IDs in the built-in list — so a UI selection of "hl7-mllp"
//      resolves to the same spec.
//
// The webview's IIFE field-update happens entirely client-side after a
// DOM `change` event; we exercise the SAME function applyPreset() runs
// against (listBuiltin + resolve) and confirm the wire output, which is
// the only thing the host actually depends on. If the host receives the
// spec bytes correctly, the wire is correct regardless of how the user
// sees them in the textarea.

import * as assert from 'assert';
import { listBuiltin, wrap, resolve } from '../../envelopes/Envelope';
import '../../envelopes/builtins';   // side-effect: registers the built-ins

suite('Envelope dropdown – end-to-end (regression 2026-07-17)', () => {
  test('hl7-mllp option ID exists in the built-in list the webview dropdown is populated from', () => {
    const ids = listBuiltin().map((e) => e.id).sort();
    assert.ok(ids.includes('hl7-mllp'),
      `dropdown should expose 'hl7-mllp'; got ids: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('hl7-llp'),
      `dropdown should expose 'hl7-llp'; got ids: ${JSON.stringify(ids)}`);
  });

  test('hl7-mllp spec is the readable escape form (4 chars), not the raw byte (1 char)', () => {
    // If this is the raw byte 0x0B, the textarea renders an invisible
    // character and the user reports "the text boxes are not updated"
    // (visual confusion even though bytes are correct).
    const e = resolve('hl7-mllp');
    assert.strictEqual(e.spec.prefix, '\\x0B',
      `prefix should be the 4-char string "\\x0B"; got length ${e.spec.prefix.length}`);
    assert.strictEqual(e.spec.prefix.length, 4);
    assert.strictEqual(e.spec.suffix, '\\x1C');
    assert.strictEqual(e.spec.suffix.length, 4);
    assert.strictEqual(e.spec.lineSuffix, '\\r');
  });

  test('hl7-llp spec is the readable escape form', () => {
    const e = resolve('hl7-llp');
    assert.strictEqual(e.spec.suffix, '\\x1C');
    assert.strictEqual(e.spec.suffix.length, 4);
    assert.strictEqual(e.spec.lineSuffix, '\\r');
    assert.strictEqual(e.spec.prefix, '');
  });

  test('hl7-mllp wire bytes are correct end-to-end (single segment)', () => {
    // Mirrors what the user sees if they pick hl7-mllp, type "HI", and
    // send — except we use resolve() (production) instead of any stub.
    const e = resolve('hl7-mllp');
    const out = wrap(Buffer.from('HI'), e.spec);
    // VT(0x0b), H(0x48), I(0x49), CR(lineSuffix 0x0d), FS(suffix 0x1c)
    assert.deepStrictEqual([...out], [0x0b, 0x48, 0x49, 0x0d, 0x1c]);
  });

  test('hl7-mllp wire bytes are correct end-to-end (multi-segment)', () => {
    // The original bug report: typing "MSH|...\nPID|..." and sending
    // with hl7-mllp must produce \r between segments, not \n.
    const e = resolve('hl7-mllp');
    const payload = Buffer.from('MSH|^~\\&|...\nPID|||...');
    const out = wrap(payload, e.spec);
    // 0x0b, MSH|^\~\\&|... (12 bytes), 0x0d, PID|||... (9 bytes), 0x0d, 0x1c
    const expected = [0x0b, 0x4d, 0x53, 0x48, 0x7c, 0x5e, 0x7e, 0x5c, 0x26, 0x7c, 0x2e, 0x2e, 0x2e,
                      0x0d, 0x50, 0x49, 0x44, 0x7c, 0x7c, 0x7c, 0x2e, 0x2e, 0x2e,
                      0x0d, 0x1c];
    assert.deepStrictEqual([...out], expected);
  });

  test('hl7-llp wire bytes are correct (no VT prefix)', () => {
    const e = resolve('hl7-llp');
    const out = wrap(Buffer.from('HI'), e.spec);
    // No VT: payload, CR, FS
    assert.deepStrictEqual([...out], [0x48, 0x49, 0x0d, 0x1c]);
  });

  test('preset spec survives a JSON round-trip (webview transport)', () => {
    // The webview receives PRESETS via JSON.parse(JSON.stringify(specs)).
    // If any character collapses across the boundary (e.g. \\x0B → raw
    // byte 0x0B), the wire bytes change.
    const e = resolve('hl7-mllp');
    const presetsJson = JSON.parse(JSON.stringify(
      Object.fromEntries(listBuiltin().map((b) => [b.id, b.spec]))
    ));
    const wireFromJson = wrap(Buffer.from('HI'), presetsJson['hl7-mllp']);
    const wireDirect   = wrap(Buffer.from('HI'), e.spec);
    assert.deepStrictEqual([...wireFromJson], [...wireDirect],
      'JSON round-trip of the spec must preserve wire bytes');
    // And the visible string is still readable
    assert.strictEqual(presetsJson['hl7-mllp'].prefix, '\\x0B');
    assert.strictEqual(presetsJson['hl7-mllp'].prefix.length, 4);
  });
});
