// Regression test for the "envelope fields don't update" + "Help button
// does nothing" reports (2026-07-17). Verifies that the spec values
// stored in builtins are the readable escape form (\x0B, not the raw
// byte 0x0B) — which is what determines what the user sees in the
// text fields after picking a preset.

import * as assert from 'assert';
import { listBuiltin, wrap } from '../../envelopes/Envelope';
// Importing builtins has the side effect of registering them, but only
// when the extension is activated (extension.ts imports it). In the
// unit test runner that's also true. As a belt-and-braces guarantee
// we'll import it here too.
import '../../envelopes/builtins';

suite('Envelope builtins – displayable form (regression 2026-07-17)', () => {
  test('hl7-mllp spec stores the literal escape sequence \\x0B (4 chars), not the raw byte 0x0B (1 char)', () => {
    const e = listBuiltin().find((x) => x.id === 'hl7-mllp');
    assert.ok(e, 'hl7-mllp should be a built-in');
    // The spec MUST be the readable escape form so the text field shows
    // "\x0B" (4 readable chars), not a single invisible byte.
    assert.strictEqual(e!.spec.prefix, '\\x0B',
      `prefix should be the 4-char string "\\x0B" so the field is readable; got length ${e!.spec.prefix.length}`);
    assert.strictEqual(e!.spec.prefix.length, 4,
      `prefix should have length 4 (the escape sequence); got ${e!.spec.prefix.length}`);
    assert.strictEqual(e!.spec.suffix, '\\x1C');
    assert.strictEqual(e!.spec.suffix.length, 4);
    assert.strictEqual(e!.spec.lineSuffix, '\\r');
  });

  test('hl7-llp spec also uses the escape form for its FS suffix', () => {
    const e = listBuiltin().find((x) => x.id === 'hl7-llp');
    assert.ok(e, 'hl7-llp should be a built-in');
    assert.strictEqual(e!.spec.suffix, '\\x1C');
    assert.strictEqual(e!.spec.suffix.length, 4);
  });

  test('the readable spec still produces the correct wire bytes after wrap()', () => {
    // Even though the field shows the 4-char escape, the host's wrap()
    // must still produce the right wire bytes (VT 0x0B, FS 0x1C, CR 0x0D).
    const e = listBuiltin().find((x) => x.id === 'hl7-mllp')!;
    const out = wrap(Buffer.from('HI'), e.spec);
    assert.deepStrictEqual([...out], [0x0b, 0x48, 0x49, 0x0d, 0x1c]);
  });

  test('full hl7-mllp multi-line wire bytes are correct end-to-end', () => {
    const e = listBuiltin().find((x) => x.id === 'hl7-mllp')!;
    const payload = Buffer.from('MSH|^~\\&|...\nPID|||...');
    const out = wrap(payload, e.spec);
    // 0b, MSH|^~\&|... (12), 0d, PID|||... (9), 0d, 1c
    const expected = [0x0b, 0x4d, 0x53, 0x48, 0x7c, 0x5e, 0x7e, 0x5c, 0x26, 0x7c, 0x2e, 0x2e, 0x2e,
                      0x0d, 0x50, 0x49, 0x44, 0x7c, 0x7c, 0x7c, 0x2e, 0x2e, 0x2e,
                      0x0d, 0x1c];
    assert.deepStrictEqual([...out], expected);
  });
});
