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
// Custom envelopes (settings.json)
// -----------------------------------------------------------------------

/**
 * Shape of a user-defined envelope entry as stored in
 * `tcpClient.envelopes.custom` in settings.json. Only the fields the user
 * controls; the runtime `Envelope` is built from this in `getCustom()`.
 *
 * Mirrors `VariableDef` in `Variables.ts` — flat, persisted shape,
 * distinct from the runtime `Envelope` (which wraps it in `EnvelopeSpec`
 * for the `wrap()` function).
 */
export type EnvelopeDef = {
  id: string;
  label: string;
  prefix?: string;
  suffix?: string;
  linePrefix?: string;
  lineSuffix?: string;
};

/**
 * Reads user-defined envelopes from VS Code configuration
 * (`tcpClient.envelopes.custom`) and returns them as runtime `Envelope`
 * entries, ready for the registry.
 *
 * Defensive parsing — mirrors `Variables.getCustom()`:
 *  - Skips entries that are missing `id` or `label`, or where those
 *    aren't strings.
 *  - Coerces optional string fields to '' when missing/wrong type.
 *  - Skips entries whose `id` collides with a built-in (avoids masking
 *    `none` / `hl7-mllp` / `hl7-llp` via the dropdown — a user error
 *    silently producing a non-functional preset). A console.warn names
 *    the offending id so it's visible in the Extension Host output.
 *  - Does NOT deduplicate against other custom entries — if a user
 *    puts two envelopes with the same `id`, the last one wins in the
 *    runtime registry (consistent with the `Map` semantics of
 *    `register()`). The Settings UI won't let them save duplicates,
 *    but a hand-edited settings.json could.
 *
 * Returns `[]` when the setting is missing, not an array, or every
 * entry was malformed — the dropdown then shows built-ins only, which
 * is the correct degraded experience.
 */
export function getCustom(): Envelope[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .get<EnvelopeDef[]>('envelopes.custom', []);

  if (!Array.isArray(raw)) { return []; }

  const builtinIds = new Set(builtins.map((b) => b.id));
  const result: Envelope[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { continue; }
    const id = (entry as EnvelopeDef).id;
    const label = (entry as EnvelopeDef).label;
    if (typeof id !== 'string' || id.trim().length === 0) { continue; }  // trim() (not just length) so '   ' is rejected too
    if (typeof label !== 'string' || label.length === 0) { continue; }
    if (builtinIds.has(id)) {
      console.warn(`Custom envelope "${id}" collides with a built-in id; skipping.`);
      continue;
    }
    if (seenIds.has(id)) { continue; }
    seenIds.add(id);

    const e = entry as EnvelopeDef;
    result.push({
      id,
      label,
      spec: {
        prefix: typeof e.prefix === 'string' ? e.prefix : '',
        suffix: typeof e.suffix === 'string' ? e.suffix : '',
        linePrefix: typeof e.linePrefix === 'string' ? e.linePrefix : '',
        lineSuffix: typeof e.lineSuffix === 'string' ? e.lineSuffix : '',
      },
    });
  }
  return result;
}

/**
 * Built-ins first, then custom envelopes from settings. Custom envelopes
 * are freshly read from the live configuration on every call — callers
 * that want the snapshot at one moment should store the result.
 *
 * Identical-id tie-break: built-in wins (it appears first; later entries
 * overwrite earlier ones in the dedup pass below, so a custom envelope
 * that survives `getCustom()`'s built-in collision filter still ends
 * up after the built-in in the list, which preserves `listBuiltin()`
 * order for any consumer that diffs against it).
 */
export function getAll(): Envelope[] {
  const builtin = listBuiltin();
  const custom = getCustom();
  // Built-ins first; custom second. If a custom envelope slips through
  // with the same id as another custom (not caught by `seenIds` because
  // it was malformed upstream), the later one wins — consistent with
  // Map.set semantics.
  return [...builtin, ...custom];
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
  // Dedupe by id: if a built-in with this id is already in the
  // `builtins[]` array, replace it in place instead of appending.
  // Without this, callers that re-register builtins across many
  // tests (e.g. `_loadBuiltinsForTests()` from each suite's setup)
  // accumulate duplicates and `listBuiltin()` returns N copies of
  // `none` / `hl7-mllp` / `hl7-llp`. The runtime `registered` Map is
  // already idempotent via `set()`, so no change there.
  const existingIdx = builtins.findIndex((b) => b.id === envelope.id);
  if (existingIdx !== -1) {
    builtins[existingIdx] = envelope;
  } else {
    builtins.push(envelope);
  }
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
