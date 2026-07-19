import * as vscode from 'vscode';
import { listBuiltin, getAll, EnvelopeDef } from './Envelope';

/**
 * Built-in envelope ids that the Save handler must refuse to shadow.
 * The runtime read path (`Envelope.getCustom()`) silently skips the
 * same collisions with a console warning; the Save path rejects
 * explicitly so the user gets feedback instead of a no-op. Two
 * inconsistent behaviors is the lesser evil — hand-edited
 * settings.json can still bypass the Save gate, but at least the
 * primary write path doesn't accept the shadow.
 */
export const BUILTIN_IDS = ['none', 'hl7-mllp', 'hl7-llp'] as const;

/**
 * Sanitizes a user-entered label into a valid envelope id:
 *   - lowercase
 *   - non-`[a-z0-9-_]` chars → `-`
 *   - collapse repeated `-`
 *   - trim leading/trailing `-`
 *
 * Returns '' when the input would produce an empty id after sanitization
 * (e.g. user enters only punctuation).
 */
export function sanitizeId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generates a unique id given a base sanitized id and the list of
 * currently-used ids (built-ins + existing custom). Appends `-2`, `-3`,
 * ... until the id is unique. Returns the base id unchanged when it's
 * already unique.
 */
export function uniqueId(baseId: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(baseId)) { return baseId; }
  let counter = 2;
  while (usedIds.has(`${baseId}-${counter}`)) { counter++; }
  return `${baseId}-${counter}`;
}

/**
 * Reads the current custom envelopes from configuration. Same defensive
 * posture as `Envelope.getCustom()` — non-array value or any non-object
 * entry is dropped. Returns [] when the setting is missing entirely.
 */
export function readCustomEnvelopes(): EnvelopeDef[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .get<unknown>('envelopes.custom', []);
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((e): e is EnvelopeDef => !!e && typeof e === 'object');
}

async function writeCustomEnvelopes(list: EnvelopeDef[]): Promise<void> {
  await vscode.workspace.getConfiguration('tcpClient').update(
    'envelopes.custom',
    list,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Validates the user-entered label and current field values, generates
 * a unique id, appends to settings, returns the new envelope (or null
 * with a reason when validation fails).
 *
 * `currentFields` is the live state of the panel's prefix/suffix/line
 * fields at the moment the user clicked Save. The webview reads these
 * and passes them in the postMessage; the host doesn't have a way to
 * see them otherwise.
 */
export interface SaveEnvelopeInput {
  label: string;
  prefix: string;
  suffix: string;
  linePrefix: string;
  lineSuffix: string;
}

export interface SaveEnvelopeResult {
  envelope: EnvelopeDef | null;
  reason?: string;
}

// Serializes read-modify-write cycles against the tcpClient.envelopes.custom
// setting. Without this, two concurrent calls (rapid clicks, multiple
// panels, or an external settings.json write interleaving with a Save
// click) can both read the same baseline and one save gets silently lost.
// Promise-chained queue is sufficient — these handlers are async-only and
// the chain naturally serializes back-to-back calls.
let envelopeWriteChain: Promise<void> = Promise.resolve();

export async function handleSaveEnvelope(
  input: SaveEnvelopeInput
): Promise<SaveEnvelopeResult> {
  const trimmedLabel = (input.label ?? '').trim();
  if (!trimmedLabel) {
    return { envelope: null, reason: 'Label cannot be empty.' };
  }

  const baseId = sanitizeId(trimmedLabel);
  if (!baseId) {
    return { envelope: null, reason: 'Label must contain at least one letter or digit.' };
  }

  const result = envelopeWriteChain.then(async (): Promise<SaveEnvelopeResult> => {
    const existing = readCustomEnvelopes();
    const usedIds = new Set<string>([...BUILTIN_IDS, ...existing.map((e) => e.id)]);
    // Reject — don't rename to `hl7-mllp-2`. The user's intent was
    // clearly to shadow a built-in, and accepting with a rename
    // gives them a preset they didn't ask for with no signal that
    // something changed. Plan: "Collision with built-in id (`none`,
    // `hl7-mllp`, `hl7-llp`) → reject (the user can't shadow a
    // built-in)."
    if ((BUILTIN_IDS as readonly string[]).includes(baseId)) {
      return { envelope: null, reason: `"${baseId}" is a built-in envelope id and cannot be reused. Pick a different name.` };
    }
    const id = uniqueId(baseId, usedIds);

    const newEnvelope: EnvelopeDef = {
      id,
      label: trimmedLabel,
      prefix: input.prefix,
      suffix: input.suffix,
      linePrefix: input.linePrefix,
      lineSuffix: input.lineSuffix,
    };

    await writeCustomEnvelopes([...existing, newEnvelope]);
    return { envelope: newEnvelope };
  });
  // Keep the chain alive even if a call rejects — a single failure
  // shouldn't break the next write. Swallow here; the outer dispatch
  // catches and posts an envelopeError to the webview.
  envelopeWriteChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Validates the id (must be a custom envelope, not a built-in),
 * removes it from settings, returns success/failure.
 */
export async function handleDeleteEnvelope(
  id: string
): Promise<{ deleted: boolean; reason?: string }> {
  if (!id) {
    return { deleted: false, reason: 'No envelope id provided.' };
  }
  if ((BUILTIN_IDS as readonly string[]).includes(id)) {
    return { deleted: false, reason: 'Built-in envelopes cannot be deleted.' };
  }

  const result = envelopeWriteChain.then(async (): Promise<{ deleted: boolean; reason?: string }> => {
    const existing = readCustomEnvelopes();
    const filtered = existing.filter((e) => e.id !== id);
    if (filtered.length === existing.length) {
      return { deleted: false, reason: `No custom envelope with id "${id}" found.` };
    }
    await writeCustomEnvelopes(filtered);
    return { deleted: true };
  });
  envelopeWriteChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Builds the current envelope list for shipping to the webview. Uses
 * `getAll()` so built-ins + custom come back in display order.
 */
export function buildEnvelopeListForWebview() {
  return getAll().map((e) => ({ id: e.id, label: e.label }));
}

/**
 * Same as `buildEnvelopeListForWebview` but suppresses the
 * "Custom envelope collides with built-in" warnings that `getAll()`
 * emits via `getCustom()`. Used by the onDidChangeConfiguration listener
 * where the warnings would otherwise fire on every settings edit,
 * including from automated tests that count them.
 */
export function buildEnvelopeListForWebviewQuiet() {
  const builtinIds = new Set(listBuiltin().map((b) => b.id));
  const customRaw = readCustomEnvelopesRaw();
  const custom = customRaw
    .filter((e) => !builtinIds.has(e.id))
    .map((e) => ({
      id: e.id,
      label: e.label,
      // Ship the full spec (prefix/suffix/etc.) so the webview's
      // envelope <select> change handler can populate the input
      // fields when the user picks a custom preset. Without this,
      // selecting a custom preset silently resets the fields to the
      // 'none' built-in defaults (the bootstrap only ships built-in
      // specs, and applyPreset() falls back to PRESETS['none'] for
      // any id it doesn't recognize).
      spec: {
        prefix: typeof e.prefix === 'string' ? e.prefix : '',
        suffix: typeof e.suffix === 'string' ? e.suffix : '',
        linePrefix: typeof e.linePrefix === 'string' ? e.linePrefix : '',
        lineSuffix: typeof e.lineSuffix === 'string' ? e.lineSuffix : '',
      },
    }));
  const builtins = listBuiltin().map((b) => ({
    id: b.id,
    label: b.label,
    spec: {
      prefix: typeof b.spec.prefix === 'string' ? b.spec.prefix : '',
      suffix: typeof b.spec.suffix === 'string' ? b.spec.suffix : '',
      linePrefix: typeof b.spec.linePrefix === 'string' ? b.spec.linePrefix : '',
      lineSuffix: typeof b.spec.lineSuffix === 'string' ? b.spec.lineSuffix : '',
    },
  }));
  return [...builtins, ...custom];
}

/** Raw reader (no type narrowing, no warn side-effects). */
function readCustomEnvelopesRaw(): EnvelopeDef[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .get<unknown>('envelopes.custom', []);
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((e): e is EnvelopeDef => !!e && typeof e === 'object');
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

/**
 * Wires up the message handlers for the envelope Save/Delete flow.
 * Returns a `Disposable` so the caller can clean up on panel disposal.
 *
 * The host responds to:
 *   - { type: 'saveEnvelope', label, prefix, suffix, linePrefix, lineSuffix }
 *   - { type: 'deleteEnvelope', id }
 *   - { type: 'getEnvelopes' }
 *
 * And broadcasts:
 *   - { type: 'envelopes', list }                       on every successful mutation
 *   - { type: 'envelopeError', reason }                on validation failure
 *
 * Errors are surfaced via a separate message type rather than thrown,
 * so the webview can render them in a toast without the host console
 * filling with stack traces from expected user errors (empty label,
 * collision, etc.).
 */
export function registerEnvelopeHostHandlers(
  panel: vscode.WebviewPanel
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    panel.webview.onDidReceiveMessage(async (msg: { type?: string } & Record<string, unknown>) => {
      if (!msg || typeof msg.type !== 'string') { return; }

      try {
        switch (msg.type) {
          case 'saveEnvelope': {
            const result = await handleSaveEnvelope({
              label: String(msg.label ?? ''),
              prefix: String(msg.prefix ?? ''),
              suffix: String(msg.suffix ?? ''),
              linePrefix: String(msg.linePrefix ?? ''),
              lineSuffix: String(msg.lineSuffix ?? ''),
            });
            if (result.envelope) {
              panel.webview.postMessage({
                type: 'envelopes',
                // Quiet variant — getAll() (via buildEnvelopeListForWebview)
                // emits console.warn per built-in-id collision, which
                // shows up in the user's Extension Host Output channel
                // and gets mistaken for a webview error.
                list: buildEnvelopeListForWebviewQuiet(),
                selectedId: result.envelope.id,
              });
            } else {
              panel.webview.postMessage({ type: 'envelopeError', reason: result.reason });
            }
            return;
          }

          case 'deleteEnvelope': {
            const result = await handleDeleteEnvelope(String(msg.id ?? ''));
            if (result.deleted) {
              panel.webview.postMessage({
                type: 'envelopes',
                list: buildEnvelopeListForWebviewQuiet(),
                selectedId: 'none',
              });
            } else {
              panel.webview.postMessage({ type: 'envelopeError', reason: result.reason });
            }
            return;
          }

          case 'getEnvelopes': {
            panel.webview.postMessage({
              type: 'envelopes',
              list: buildEnvelopeListForWebviewQuiet(),
              selectedId: typeof msg.selectedId === 'string' ? msg.selectedId : 'none',
            });
            return;
          }
        }
      } catch (err) {
        // handleSaveEnvelope / handleDeleteEnvelope can throw if
        // vscode.workspace.getConfiguration().update() rejects (disk
        // full, permission denied, settings.json locked). Without
        // this catch the rejection bubbles to the Extension Host
        // console and the webview gets no feedback — the user sees
        // a stale dropdown and no error message. Surface it instead.
        const reason = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: 'envelopeError', reason });
      }
    })
  );

  return new vscode.Disposable(() => disposables.forEach((d) => d.dispose()));
}

/**
 * Subscribes to settings.json changes that affect the custom envelopes
 * list and broadcasts the new list to the webview. Solves the case
 * where the user edits `tcpClient.envelopes.custom` outside the panel
 * (hand-edit, another extension, VS Code Settings UI) and the panel's
 * dropdown needs to reflect the change without a manual refresh.
 *
 * Returned Disposable must be added to the panel's `_disposables`.
 */
export function subscribeEnvelopeConfigChanges(
  panel: vscode.WebviewPanel
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('tcpClient.envelopes.custom')) { return; }
    panel.webview.postMessage({
      type: 'envelopes',
      list: buildEnvelopeListForWebviewQuiet(),
      // Don't override the user's current selection on external edits —
      // they may have unsaved field changes tied to the selection.
    });
  });
}