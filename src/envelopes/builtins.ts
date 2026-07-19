import { _registerBuiltin } from './Envelope';

/**
 * Built-in envelopes. Imported from `extension.ts` at activation so the
 * registry is populated before any panel tries to enumerate envelopes.
 *
 * Escape sequences in prefix/suffix use the same syntax as `encodeMessage`
 * (MessageEncoder.ts).
 */
_registerBuiltin({
  id: 'none',
  label: 'None (raw)',
  spec: { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' },
});

_registerBuiltin({
  id: 'hl7-mllp',
  label: 'HL7 v2 (MLLP framing)',
  // VT (0x0B) prefix, FS (0x1C) suffix, per-line \r segment terminator.
  spec: { prefix: '\\x0B', suffix: '\\x1C', linePrefix: '', lineSuffix: '\\r' },
});

_registerBuiltin({
  id: 'hl7-llp',
  label: 'HL7 v2 (raw LLP, no VT)',
  // FS suffix only; per-line \r segment terminator; no leading VT.
  spec: { prefix: '', suffix: '\\x1C', linePrefix: '', lineSuffix: '\\r' },
});
