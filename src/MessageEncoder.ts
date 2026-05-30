export type TextEncoding = 'utf8' | 'ascii' | 'latin1' | 'utf16le';

export const ENCODINGS: { label: string; value: TextEncoding }[] = [
  { label: 'UTF-8',            value: 'utf8'    },
  { label: 'ASCII',            value: 'ascii'   },
  { label: 'Latin-1 (ISO-8859-1)', value: 'latin1' },
  { label: 'UTF-16 LE',        value: 'utf16le' },
];

/**
 * Parses escape sequences in the input string and encodes it to a Buffer.
 *
 * Supported escapes:
 *   \xHH  — raw byte 0xHH (case-insensitive hex, always a single byte)
 *   \n    — newline   (0x0A)
 *   \r    — carriage return (0x0D)
 *   \t    — horizontal tab  (0x09)
 *   \\    — literal backslash
 *   \0    — null byte (0x00)
 *
 * All other text is encoded using the specified TextEncoding.
 * Unknown escapes (e.g. \z) preserve the backslash and advance past it.
 */
export function encodeMessage(input: string, encoding: TextEncoding): Buffer {
  const parts: Buffer[] = [];
  let textStart = 0;
  let i = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      parts.push(Buffer.from(input.slice(textStart, end), encoding));
    }
  };

  while (i < input.length) {
    if (input[i] !== '\\') { i++; continue; }

    flushText(i);

    // Trailing backslash — treat as literal
    if (i + 1 >= input.length) {
      parts.push(Buffer.from('\\', encoding));
      i++;
      textStart = i;
      continue;
    }

    const next = input[i + 1];

    // \xHH — raw byte
    if (next === 'x' && i + 3 < input.length) {
      const hex = input.slice(i + 2, i + 4);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        parts.push(Buffer.from([parseInt(hex, 16)]));
        i += 4;
        textStart = i;
        continue;
      }
    }

    // Single-character escapes
    const simple: Record<string, number> = {
      n: 0x0a, r: 0x0d, t: 0x09, '0': 0x00,
    };
    if (next in simple) {
      parts.push(Buffer.from([simple[next]]));
      i += 2; textStart = i; continue;
    }
    if (next === '\\') {
      parts.push(Buffer.from('\\', encoding));
      i += 2; textStart = i; continue;
    }

    // Unknown escape — keep the backslash, let the next char be re-evaluated
    parts.push(Buffer.from('\\', encoding));
    i++;
    textStart = i;
  }

  flushText(input.length);
  return Buffer.concat(parts);
}

/**
 * Formats a Buffer as a human-readable string for display.
 *
 * - Printable ASCII (0x20–0x7E) is shown as-is.
 * - Valid UTF-8 multi-byte sequences are decoded to their characters.
 * - 0x09/0x0A/0x0D are shown as \t / \n / \r.
 * - All other bytes are shown as \xhh (lowercase hex).
 */
export function formatBytes(data: Buffer): string {
  let result = '';
  let i = 0;

  while (i < data.length) {
    const b = data[i];

    if (b === 0x09) { result += '\\t'; i++; continue; }
    if (b === 0x0a) { result += '\\n'; i++; continue; }
    if (b === 0x0d) { result += '\\r'; i++; continue; }
    if (b >= 0x20 && b <= 0x7e) { result += String.fromCharCode(b); i++; continue; }

    // 2-byte UTF-8: 110xxxxx 10xxxxxx
    if (b >= 0xc2 && b <= 0xdf && i + 1 < data.length) {
      const b2 = data[i + 1];
      if ((b2 & 0xc0) === 0x80) {
        result += String.fromCodePoint(((b & 0x1f) << 6) | (b2 & 0x3f));
        i += 2; continue;
      }
    }

    // 3-byte UTF-8: 1110xxxx 10xxxxxx 10xxxxxx
    if (b >= 0xe0 && b <= 0xef && i + 2 < data.length) {
      const b2 = data[i + 1], b3 = data[i + 2];
      if ((b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
        const cp = ((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        if (cp >= 0x800) { result += String.fromCodePoint(cp); i += 3; continue; }
      }
    }

    // 4-byte UTF-8: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
    if (b >= 0xf0 && b <= 0xf4 && i + 3 < data.length) {
      const b2 = data[i + 1], b3 = data[i + 2], b4 = data[i + 3];
      if ((b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80 && (b4 & 0xc0) === 0x80) {
        const cp = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
        if (cp >= 0x10000 && cp <= 0x10ffff) { result += String.fromCodePoint(cp); i += 4; continue; }
      }
    }

    result += '\\x' + b.toString(16).padStart(2, '0');
    i++;
  }

  return result;
}
