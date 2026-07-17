import { encodeMessage } from '../MessageEncoder';

/**
 * An EnvelopeSpec describes the framing bytes that wrap a user-typed message
 * before it is written to the socket.
 *
 * All three fields are escape-sequence strings using the same syntax as
 * `encodeMessage` (MessageEncoder.ts):
 *   \xHH  — raw byte (0xHH, case-insensitive hex)
 *   \n    — newline (0x0A)
 *   \r    — carriage return (0x0D)
 *   \t    — horizontal tab (0x09)
 *   \\    — literal backslash
 *   \0    — null byte (0x00)
 *
 * - `prefix`           — bytes written immediately before the payload
 * - `suffix`           — bytes written immediately after the payload
 * - `linePrefix`       — bytes prepended to every line of the payload
 *                        (added inside the outer prefix/suffix). Default ''.
 * - `lineSuffix`       — bytes appended to every line of the payload
 *                        (added inside the outer prefix/suffix). Default ''.
 */
export type EnvelopeSpec = {
  prefix: string;
  suffix: string;
  linePrefix: string;
  lineSuffix: string;
};

export type Envelope = {
  id: string;
  label: string;
  spec: EnvelopeSpec;
};

/**
 * Wraps a payload buffer with the prefix and suffix described by `spec`.
 *
 * When both `linePrefix` and `lineSuffix` are empty strings, the
 * payload is wrapped once with the outer prefix and suffix — a fast
 * path that keeps the behavior byte-identical to the previous
 * single-wrap implementation.
 *
 * When at least one of `linePrefix` / `lineSuffix` is non-empty, the
 * payload is split on `\n` (single byte 0x0A) and each line is wrapped
 * individually with the line-level prefix/suffix. Empty lines (from
 * leading, trailing, or consecutive `\n`s) are wrapped too, so a payload
 * ending in `\n` produces a trailing empty line that is also wrapped
 * — the right behavior for line-oriented protocols. Lines are NOT
 * rejoined with a synthetic byte — the user's `lineSuffix` is the
 * per-line terminator, so they choose what (if anything) sits between
 * lines by setting `lineSuffix` (e.g. `\r` for HL7) or by typing the
 * separator into the payload itself. The whole per-line result is then
 * wrapped with the outer prefix and suffix.
 */
export function wrap(payload: Buffer, spec: EnvelopeSpec): Buffer {
  const prefixBytes = encodeMessage(spec.prefix, 'latin1');
  const suffixBytes = encodeMessage(spec.suffix, 'latin1');
  const linePreBytes = encodeMessage(spec.linePrefix, 'latin1');
  const lineSufBytes = encodeMessage(spec.lineSuffix, 'latin1');

  // Back-compat fast path: no per-line framing configured, wrap once.
  if (linePreBytes.length === 0 && lineSufBytes.length === 0) {
    return Buffer.concat([prefixBytes, payload, suffixBytes]);
  }

  // Per-line wrap. Split payload on \n (0x0A) and wrap each line,
  // preserving empty lines from leading/trailing/consecutive separators.
  // No synthetic separator is emitted between wrapped lines — the user's
  // `lineSuffix` is the per-line terminator.
  const wrapped: Buffer[] = [prefixBytes];
  let cursor = 0;
  while (cursor <= payload.length) {
    const nextSep = payload.indexOf(0x0a, cursor);
    const lineEnd = nextSep === -1 ? payload.length : nextSep;
    const line = payload.subarray(cursor, lineEnd);
    wrapped.push(linePreBytes, line, lineSufBytes);
    if (nextSep === -1) { break; }
    cursor = nextSep + 1;
  }
  wrapped.push(suffixBytes);

  return Buffer.concat(wrapped);
}

// -----------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------

const builtins: Envelope[] = [];
const registered: Map<string, Envelope> = new Map();

/** Adds an envelope to the runtime registry. Overwrites any existing entry with the same id. */
export function register(envelope: Envelope): void {
  registered.set(envelope.id, envelope);
}

/** Looks up an envelope in the runtime registry (built-ins + runtime-registered only). */
export function get(id: string): Envelope | undefined {
  return registered.get(id);
}

/** Lists every envelope currently in the runtime registry. */
export function list(): Envelope[] {
  return Array.from(registered.values());
}

/** Lists only the built-in envelopes that were registered at module load. */
export function listBuiltin(): Envelope[] {
  return builtins.slice();
}

/**
 * Resolves an envelope by id, looking first at built-ins, then at runtime
 * registered entries, and finally falling back to the `none` passthrough
 * envelope. Throws on unknown ids.
 */
export function resolve(id: string): Envelope {
  const fromRegistry = registered.get(id);
  if (fromRegistry) { return fromRegistry; }
  if (id === 'none') {
    return {
      id: 'none',
      label: 'None (raw)',
      spec: { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' },
    };
  }
  throw new Error(`Unknown envelope id: ${id}`);
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/**
 * Internal: register a built-in envelope. Called from `builtins.ts` at
 * module load. Exposed for the test suite to seed the registry with
 * a known set of built-ins in a sandboxed environment.
 */
export function _registerBuiltin(envelope: Envelope): void {
  builtins.push(envelope);
  registered.set(envelope.id, envelope);
}

/**
 * Test hook: clear runtime registry entries (added via `register()`).
 * Built-ins registered via `_registerBuiltin` are preserved.
 */
export function _resetForTests(): void {
  for (const id of Array.from(registered.keys())) {
    if (!builtins.some((b) => b.id === id)) {
      registered.delete(id);
    }
  }
}

/**
 * Test hook: clear the entire registry (built-ins + runtime entries).
 * Use this when a test wants a fully empty starting state.
 */
export function _clearAllForTests(): void {
  builtins.length = 0;
  registered.clear();
}

/**
 * Test hook: re-register the three standard built-ins
 * (none / hl7-mllp / hl7-llp). Use this in suite setup after
 * `_clearAllForTests()` so downstream tests have builtins to work with.
 */
export function _loadBuiltinsForTests(): void {
  _registerBuiltin({
    id: 'none',
    label: 'None (raw)',
    spec: { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' },
  });
  _registerBuiltin({
    id: 'hl7-mllp',
    label: 'HL7 v2 (MLLP framing)',
    spec: { prefix: '\\x0B', suffix: '\\x1C', linePrefix: '', lineSuffix: '\\r' },
  });
  _registerBuiltin({
    id: 'hl7-llp',
    label: 'HL7 v2 (raw LLP, no VT)',
    spec: { prefix: '', suffix: '\\x1C', linePrefix: '', lineSuffix: '\\r' },
  });
}
