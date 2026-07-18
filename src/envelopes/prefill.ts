import * as vscode from 'vscode';
import { EnvelopeDef } from './Envelope';

/** GlobalState key that gates the one-shot HL7 prefill. */
export const HL7_PREFILL_FLAG_KEY = 'tcpClient.prefilledHL7.v1';

/**
 * Built-in HL7 envelopes that get copied into `tcpClient.envelopes.custom`
 * on first activation. Kept in this file (not imported from
 * `builtins.ts`) so the prefill is fully self-contained — no module-load
 * side effects depend on the registry, and the prefill unit tests can
 * stub `vscode.workspace.getConfiguration` without registering builtins.
 *
 * The shape matches the live HL7 built-ins exactly: VT prefix, FS suffix,
 * `\r` line suffix for both. If the actual built-ins change, this list
 * should be updated to match.
 */
export const HL7_PRESETS: ReadonlyArray<EnvelopeDef> = [
  {
    id: 'hl7-mllp',
    label: 'HL7 v2 (MLLP framing)',
    prefix: '\\x0B',
    suffix: '\\x1C',
    linePrefix: '',
    lineSuffix: '\\r',
  },
  {
    id: 'hl7-llp',
    label: 'HL7 v2 (raw LLP, no VT)',
    prefix: '',
    suffix: '\\x1C',
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
 * One-shot HL7 prefill. On first activation, copies the two HL7
 * built-ins into `tcpClient.envelopes.custom` so they appear as
 * editable user presets in the panel dropdown.
 *
 * Idempotent: the `HL7_PREFILL_FLAG_KEY` globalState bit is set after
 * the first run. Subsequent calls return `{ ran: false }` immediately
 * without touching settings. The flag is local to the extension's
 * globalState, so it persists across activations but resets if the
 * user clears the extension's storage.
 *
 * Manual re-trigger: use `prefillHL7EnvelopesCommand()`, which
 * bypasses the flag and replaces existing HL7 entries with the
 * current preset list.
 */
export async function maybePrefillHL7Envelopes(
  context: vscode.ExtensionContext
): Promise<{ ran: boolean; added: number }> {
  if (context.globalState.get<boolean>(HL7_PREFILL_FLAG_KEY)) {
    return { ran: false, added: 0 };
  }

  const existing = readCustomEnvelopes();
  const existingIds = new Set(existing.map((e) => e.id));

  // Append only the HL7 presets that aren't already present. If the
  // user already added hl7-mllp / hl7-llp themselves, we don't duplicate.
  const toAdd = HL7_PRESETS.filter((p) => !existingIds.has(p.id));
  if (toAdd.length > 0) {
    await writeCustomEnvelopes([...existing, ...toAdd]);
  }

  await context.globalState.update(HL7_PREFILL_FLAG_KEY, true);
  return { ran: true, added: toAdd.length };
}

/**
 * Manual re-trigger for the `TCP Client: Prefill HL7 Envelopes` command.
 * Replaces any existing HL7 entries with the same id (so the user gets
 * the latest preset definitions), and leaves other custom envelopes
 * untouched. Returns the number of HL7 entries now in the array.
 *
 * Does NOT touch the globalState flag — running the command does not
 * mark the auto-prefill as "already done." That separation matters: the
 * user might delete the HL7 presets later and want the auto-prefill
 * still available on a fresh install / globalState reset.
 */
export async function prefillHL7EnvelopesCommand(): Promise<{ replaced: number; total: number }> {
  const existing = readCustomEnvelopes();
  const hl7Ids = new Set(HL7_PRESETS.map((p) => p.id));
  const without = existing.filter((e) => !hl7Ids.has(e.id));
  const merged = [...without, ...HL7_PRESETS];
  await writeCustomEnvelopes(merged);
  return { replaced: existing.filter((e) => hl7Ids.has(e.id)).length, total: merged.length };
}