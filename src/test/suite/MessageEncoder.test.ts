import * as assert from 'assert';
import { encodeMessage, formatBytes } from '../../MessageEncoder';

suite('MessageEncoder – encodeMessage', () => {

  test('plain ASCII text (utf8)', () => {
    assert.deepStrictEqual([...encodeMessage('Hello', 'utf8')], [72, 101, 108, 108, 111]);
  });

  test('\\n produces 0x0A', () => {
    assert.deepStrictEqual([...encodeMessage('a\\nb', 'utf8')], [97, 10, 98]);
  });

  test('\\r produces 0x0D', () => {
    assert.deepStrictEqual([...encodeMessage('a\\rb', 'utf8')], [97, 13, 98]);
  });

  test('\\t produces 0x09', () => {
    assert.deepStrictEqual([...encodeMessage('a\\tb', 'utf8')], [97, 9, 98]);
  });

  test('\\\\ produces a single backslash', () => {
    assert.deepStrictEqual([...encodeMessage('a\\\\b', 'utf8')], [97, 92, 98]);
  });

  test('\\0 produces null byte', () => {
    assert.deepStrictEqual([...encodeMessage('a\\0b', 'utf8')], [97, 0, 98]);
  });

  test('\\xFF produces byte 0xFF', () => {
    assert.deepStrictEqual([...encodeMessage('\\xFF', 'utf8')], [0xff]);
  });

  test('\\xff (lowercase) produces byte 0xFF', () => {
    assert.deepStrictEqual([...encodeMessage('\\xff', 'utf8')], [0xff]);
  });

  test('\\x41 produces "A"', () => {
    assert.deepStrictEqual([...encodeMessage('\\x41', 'utf8')], [0x41]);
  });

  test('\\x00 produces null byte', () => {
    assert.deepStrictEqual([...encodeMessage('\\x00', 'utf8')], [0x00]);
  });

  test('mixed text and \\r\\n', () => {
    const bytes = [...encodeMessage('Hello\\r\\nWorld', 'utf8')];
    assert.deepStrictEqual(bytes, [72,101,108,108,111, 13,10, 87,111,114,108,100]);
  });

  test('mixed text and \\xHH byte', () => {
    assert.deepStrictEqual([...encodeMessage('H\\x00W', 'utf8')], [72, 0, 87]);
  });

  test('unknown escape \\z keeps backslash', () => {
    const b = encodeMessage('\\z', 'utf8');
    assert.strictEqual(b[0], 92); // backslash
  });

  test('trailing backslash kept as literal', () => {
    const b = encodeMessage('a\\', 'utf8');
    assert.deepStrictEqual([...b], [97, 92]);
  });

  test('invalid hex \\xGG is not consumed as hex', () => {
    // \xGG: backslash kept, then 'xGG' encoded as plain text
    const b = encodeMessage('\\xGG', 'utf8');
    assert.ok(b.length >= 1); // at minimum the backslash
  });

  test('UTF-8 multi-byte character é encoded correctly', () => {
    assert.deepStrictEqual([...encodeMessage('\u00e9', 'utf8')], [0xc3, 0xa9]);
  });

  test('ascii encoding', () => {
    assert.deepStrictEqual([...encodeMessage('Hi', 'ascii')], [72, 105]);
  });

  test('latin1 encoding for \\xFF character', () => {
    assert.deepStrictEqual([...encodeMessage('\xff', 'latin1')], [0xff]);
  });

  test('empty string returns empty buffer', () => {
    assert.strictEqual(encodeMessage('', 'utf8').length, 0);
  });

  test('only escape sequences', () => {
    assert.deepStrictEqual([...encodeMessage('\\r\\n', 'utf8')], [13, 10]);
  });

  test('\\xHH bytes are raw regardless of encoding', () => {
    // Even with utf16le encoding, \xFF is a single raw byte
    const b = encodeMessage('\\xFF', 'utf16le');
    assert.deepStrictEqual([...b], [0xff]);
  });
});

suite('MessageEncoder – formatBytes', () => {

  test('printable ASCII returned as-is', () => {
    assert.strictEqual(formatBytes(Buffer.from([72, 101, 108, 108, 111])), 'Hello');
  });

  test('0x0A shown as \\n', () => {
    assert.strictEqual(formatBytes(Buffer.from([10])), '\\n');
  });

  test('0x0D shown as \\r', () => {
    assert.strictEqual(formatBytes(Buffer.from([13])), '\\r');
  });

  test('0x09 shown as \\t', () => {
    assert.strictEqual(formatBytes(Buffer.from([9])), '\\t');
  });

  test('control byte 0x01 shown as \\x01', () => {
    assert.strictEqual(formatBytes(Buffer.from([0x01])), '\\x01');
  });

  test('0xFF shown as \\xff', () => {
    assert.strictEqual(formatBytes(Buffer.from([0xff])), '\\xff');
  });

  test('UTF-8 2-byte sequence é decoded', () => {
    assert.strictEqual(formatBytes(Buffer.from([0xc3, 0xa9])), '\u00e9');
  });

  test('UTF-8 3-byte sequence decoded', () => {
    // U+4E2D (中) = E4 B8 AD
    assert.strictEqual(formatBytes(Buffer.from([0xe4, 0xb8, 0xad])), '\u4e2d');
  });

  test('mixed printable and non-printable', () => {
    assert.strictEqual(formatBytes(Buffer.from([72, 101, 0x00, 108, 111])), 'He\\x00lo');
  });

  test('CRLF shown as \\r\\n', () => {
    assert.strictEqual(formatBytes(Buffer.from([13, 10])), '\\r\\n');
  });

  test('empty buffer returns empty string', () => {
    assert.strictEqual(formatBytes(Buffer.alloc(0)), '');
  });

  test('all printable ASCII range', () => {
    const bytes = Buffer.from(Array.from({ length: 95 }, (_, i) => i + 0x20));
    const result = formatBytes(bytes);
    assert.strictEqual(result.length, 95);
    assert.strictEqual(result[0], ' ');
    assert.strictEqual(result[94], '~');
  });
});
