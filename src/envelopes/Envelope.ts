import * as vscode from 'vscode';
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
 * - `segmentSeparator` — informational; describes the byte that separates
 *                        segments inside the payload (e.g. `\r` for HL7 v2).
 *                        Not modified by `wrap` in v1 — the user is trusted
 *                        to provide the payload exactly as they want it
 *                        transmitted; `wrap` only adds the prefix and suffix.
 */
export type LineMode = 'none' | 'each-line';

export type EnvelopeSpec = {
  prefix: string;
  suffix: string;
  segmentSeparator: string;
  lineMode: LineMode;
  lineSeparator: string;
};

export type Envelope = {
  id: string;
  label: string;
  spec: EnvelopeSpec;
};

/**
 * Shape of a custom-envelope entry as stored in `tcpClient.envelopes.custom`.
 * The fields are flattened (no nested `spec`) to match the package.json
 * configuration schema.
 */
export type EnvelopeDef = {
  id: string;
  label: string;
  prefix?: string;
  suffix?: string;
  segmentSeparator?: string;
  lineMode?: 'none' | 'each-line';
  lineSeparator?: string;
};

/**
 * Wraps a payload buffer with the prefix and suffix described by `spec`.
 *
 * - `lineMode = 'none'` (default): wrap the whole payload once with
 *   prefix + suffix. Used by HL7 v2 MLLP, STX/ETX, etc.
 * - `lineMode = 'each-line'`: split the payload on `lineSeparator` and
 *   wrap each chunk independently. The separator itself is preserved
 *   between wrapped chunks. Used for protocols that frame every line
 *   (e.g. NRPE, line-oriented logging).
 *
 * The `segmentSeparator` field of `spec` is informational; it is not
 * applied to the payload.
 */
export function wrap(payload: Buffer, spec: EnvelopeSpec): Buffer {
  const prefixBytes = encodeMessage(spec.prefix, 'latin1');
  const suffixBytes = encodeMessage(spec.suffix, 'latin1');

  if (spec.lineMode !== 'each-line' || !spec.lineSeparator) {
    return Buffer.concat([prefixBytes, payload, suffixBytes]);
  }

  // lineMode === 'each-line' and a separator is configured.
  const sepBytes = encodeMessage(spec.lineSeparator, 'latin1');
  if (sepBytes.length === 0) {
    return Buffer.concat([prefixBytes, payload, suffixBytes]);
  }

  const wrapped: Buffer[] = [];
  let cursor = 0;
  while (cursor <= payload.length) {
    const nextSep =
      cursor < payload.length
        ? payload.indexOf(sepBytes, cursor)
        : -1;
    const chunkEnd = nextSep === -1 ? payload.length : nextSep;
    const chunk = payload.subarray(cursor, chunkEnd);
    wrapped.push(prefixBytes, chunk, suffixBytes);
    if (nextSep === -1) { break; }
    wrapped.push(sepBytes);
    cursor = nextSep + sepBytes.length;
  }
  return Buffer.concat(wrapped);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

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

/** Lists every envelope currently in the runtime registry (no custom ones from settings). */
export function list(): Envelope[] {
  return Array.from(registered.values());
}

/** Lists only the built-in envelopes that were registered at module load. */
export function listBuiltin(): Envelope[] {
  return builtins.slice();
}

/**
 * Reads user-defined envelopes from VS Code configuration
 * (`tcpClient.envelopes.custom`). Returns an empty array if the setting is
 * missing or malformed.
 */
export function getCustom(): Envelope[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .get<EnvelopeDef[]>('envelopes.custom', []);

  if (!Array.isArray(raw)) { return []; }

  const result: Envelope[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') {
      continue;
    }
    result.push({
      id: entry.id,
      label: entry.label,
      spec: {
        prefix: typeof entry.prefix === 'string' ? entry.prefix : '',
        suffix: typeof entry.suffix === 'string' ? entry.suffix : '',
        segmentSeparator:
          typeof entry.segmentSeparator === 'string' ? entry.segmentSeparator : '',
        lineMode: entry.lineMode === 'each-line' ? 'each-line' : 'none',
        lineSeparator:
          typeof entry.lineSeparator === 'string' ? entry.lineSeparator : '\\n',
      },
    });
  }
  return result;
}

/** Built-ins first, then custom envelopes from settings. */
export function getAll(): Envelope[] {
  return [...listBuiltin(), ...getCustom()];
}

/**
 * Resolves an envelope by id, looking first at built-ins, then at the
 * custom envelopes from settings, and finally falling back to the `none`
 * passthrough envelope. Throws on unknown ids.
 */
export function resolve(id: string): Envelope {
  const fromRegistry = registered.get(id);
  if (fromRegistry) { return fromRegistry; }
  const fromCustom = getCustom().find((e) => e.id === id);
  if (fromCustom) { return fromCustom; }
  if (id === 'none') {
    return {
      id: 'none',
      label: 'None (raw)',
      spec: { prefix: '', suffix: '', segmentSeparator: '', lineMode: 'none', lineSeparator: '\\n' },
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
    spec: { prefix: '', suffix: '', segmentSeparator: '', lineMode: 'none', lineSeparator: '\\n' },
  });
  _registerBuiltin({
    id: 'hl7-mllp',
    label: 'HL7 v2 (MLLP framing)',
    spec: { prefix: '\\x0B', suffix: '\\x1C\\r', segmentSeparator: '\\r', lineMode: 'none', lineSeparator: '\\n' },
  });
  _registerBuiltin({
    id: 'hl7-llp',
    label: 'HL7 v2 (raw LLP, no VT)',
    spec: { prefix: '', suffix: '\\x1C\\r', segmentSeparator: '\\r', lineMode: 'none', lineSeparator: '\\n' },
  });
}
