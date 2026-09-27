import * as vscode from 'vscode';
import { EnvelopeDef } from './Envelope';

/** GlobalState key that gates the one-shot HL7 prefill. */
export const HL7_PREFILL_FLAG_KEY = 'tcpClient.prefilledHL7.v1';

/** Independent one-shot key for correcting untouched legacy prefill copies. */
export const HL7_PREFILL_MIGRATION_FLAG_KEY = 'tcpClient.migratedHL7Prefill.v1';

/**
 * The editable MLLP HL7 envelope copied into `tcpClient.envelopes.custom`
 * on first activation. Kept in this file (not imported from
 * `builtins.ts`) so the prefill is fully self-contained — no module-load
 * side effects depend on the registry, and the prefill unit tests can
 * stub `vscode.workspace.getConfiguration` without registering builtins.
 *
 * The shape matches the live MLLP built-in exactly: VT prefix, FS+CR
 * framing trailer, and carriage-return segment terminators. If the actual
 * MLLP built-in changes, this list should be updated to match.
 *
 * This copy uses a `-copy` suffix (`hl7-mllp-copy`) so it does NOT shadow
 * the built-in id. Earlier versions of this prefill wrote entries with
 * built-in ids (`hl7-mllp`, `hl7-llp`), which caused the runtime to
 * silently skip them in the dropdown — making them invisible AND
 * undeletable via the panel's Save/Delete UI. The renamed form keeps the
 * "editable copy" UX intent while letting the panel manage it normally.
 */
export const HL7_PRESETS: ReadonlyArray<EnvelopeDef> = [
  {
    id: 'hl7-mllp-copy',
    label: 'HL7 v2 (MLLP framing) — editable copy',
    prefix: '\\x0B',
    suffix: '\\x1C\\r',
    linePrefix: '',
    lineSuffix: '\\r',
  },
];

/**
 * Reads the current custom envelopes from configuration. Defensive
 * against malformed settings — returns [] when the value isn't an array
 * or has any non-object entries. Mirrors `Envelope.getCustom()`'s
 * posture without importing it (the prefill runs at activation before
 * the registry is necessarily seeded).
 */
function readCustomEnvelopes(): EnvelopeDef[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .get<unknown>('envelopes.custom', []);
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((e): e is EnvelopeDef => !!e && typeof e === 'object');
}

/** Reads only the globally configured custom envelopes for global migrations. */
function readGlobalCustomEnvelopes(): EnvelopeDef[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .inspect<unknown>('envelopes.custom')?.globalValue;
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((e): e is EnvelopeDef => !!e && typeof e === 'object');
}

/**
 * Writes the custom-envelopes array back to configuration. Coerces the
 * target to ConfigurationTarget.Global so the prefill is visible across
 * workspaces — same target the user would use if they added the
 * envelopes by hand in the Settings UI.
 */
async function writeCustomEnvelopes(list: EnvelopeDef[]): Promise<void> {
  await vscode.workspace.getConfiguration('tcpClient').update(
    'envelopes.custom',
    list,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Corrects only exact old v1-prefill defaults, including their original
 * labels. The migration is eligible only for installs whose v1 prefill
 * flag was already set before this call; fresh installs mark it complete
 * without touching manually-created settings.
 */
async function migrateLegacyHL7Prefill(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(HL7_PREFILL_MIGRATION_FLAG_KEY)) {
    return;
  }
  if (!context.globalState.get<boolean>(HL7_PREFILL_FLAG_KEY)) {
    await context.globalState.update(HL7_PREFILL_MIGRATION_FLAG_KEY, true);
    return;
  }

  const existing = readGlobalCustomEnvelopes();
  let changed = false;
  const migrated = existing.map((entry) => {
    const isOldMllpDefault = entry.id === 'hl7-mllp-copy'
      && entry.label === 'HL7 v2 (MLLP framing) — editable copy'
      && entry.prefix === '\\x0B'
      && entry.suffix === '\\x1C'
      && entry.linePrefix === ''
      && entry.lineSuffix === '\\r';
    const isOldLlpDefault = entry.id === 'hl7-llp-copy'
      && entry.label === 'HL7 v2 (raw LLP, no VT) — editable copy'
      && entry.prefix === ''
      && entry.suffix === '\\x1C'
      && entry.linePrefix === ''
      && entry.lineSuffix === '\\r';

    if (!isOldMllpDefault && !isOldLlpDefault) { return entry; }
    changed = true;
    return { ...entry, suffix: '\\x1C\\r' };
  });

  if (changed) {
    await writeCustomEnvelopes(migrated);
  }
  await context.globalState.update(HL7_PREFILL_MIGRATION_FLAG_KEY, true);
}

/**
 * One-shot HL7 MLLP editable-copy prefill. On first activation, copies the
 * MLLP built-in into `tcpClient.envelopes.custom` so it appears as an
 * editable user preset in the panel dropdown.
 *
 * Idempotent: an independent migration flag corrects only exact untouched
 * v1 copies, then the `HL7_PREFILL_FLAG_KEY` globalState bit gates the
 * original one-shot insertion behavior. Subsequent calls return `{ ran: false }`
 * without changing settings.
 */
export async function maybePrefillHL7Envelopes(
  context: vscode.ExtensionContext
): Promise<{ ran: boolean; added: number }> {
  await migrateLegacyHL7Prefill(context);

  if (context.globalState.get<boolean>(HL7_PREFILL_FLAG_KEY)) {
    return { ran: false, added: 0 };
  }

  const existing = readCustomEnvelopes();
  const existingIds = new Set(existing.map((e) => e.id));

  // Append only the editable MLLP copy if it isn't already present.
  const toAdd = HL7_PRESETS.filter((p) => !existingIds.has(p.id));
  if (toAdd.length > 0) {
    await writeCustomEnvelopes([...existing, ...toAdd]);
  }

  await context.globalState.update(HL7_PREFILL_FLAG_KEY, true);
  return { ran: true, added: toAdd.length };
}