import * as vscode from 'vscode';
import { TcpPanel } from './TcpPanel';
// Side-effect import: registers the built-in envelopes (none, hl7-mllp,
// hl7-llp) into the envelope registry at activation time.
import './envelopes/builtins';
// Side-effect import: registers the built-in variables (timestamp) into
// the variable registry at activation time.
import './variables/builtins';
import { maybePrefillHL7Envelopes, prefillHL7EnvelopesCommand } from './envelopes/prefill';
import { listBuiltin } from './envelopes/Envelope';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tcpClient.openPanel', () => {
      TcpPanel.createOrShow(context.extensionUri, context);
    })
  );
  // First-run only: copy the HL7 built-ins into the user's custom
  // envelope list so they can edit / delete / clone them via the panel
  // buttons. Subsequent activations are a no-op (gated by globalState).
  // Catch the rejection: if update() throws (disk full, settings.json
  // locked), we don't want an unhandled-rejection warning in the
  // Extension Host console.
  maybePrefillHL7Envelopes(context).catch((err) => {
    console.warn('TCP Client: HL7 prefill failed:', err);
  });
  // Manual re-trigger: useful if the user deletes the HL7 presets
  // and wants them back, or if a new HL7 preset is added in a future
  // release and the user wants it.
  context.subscriptions.push(
    vscode.commands.registerCommand('tcpClient.prefillHL7Envelopes', async () => {
      const result = await prefillHL7EnvelopesCommand();
      vscode.window.showInformationMessage(
        `HL7 envelopes refreshed. ${result.replaced} replaced, ${result.total} total.`
      );
    })
  );
  // One-shot cleanup for users who installed the v0.2.7-pre.1 build,
  // where the prefill wrote shadowed entries (id = built-in id like
  // 'hl7-mllp') that the panel Save/Delete UI can't see or manage.
  // Without this command, those users see the "Delete always disabled"
  // bug because the dropdown only contains built-ins — the shadowed
  // entries are silently filtered. Running this removes them.
  context.subscriptions.push(
    vscode.commands.registerCommand('tcpClient.removeBuiltinShadows', async () => {
      const removed = await removeBuiltinShadowsCommand();
      if (removed === 0) {
        vscode.window.showInformationMessage(
          'No shadowed built-in envelopes found in your settings. Nothing to clean up.'
        );
      } else {
        vscode.window.showInformationMessage(
          `Removed ${removed} shadowed built-in envelope(s) from settings.json. The dropdown now reflects your actual presets.`
        );
      }
    })
  );
}

/**
 * Removes any custom envelope whose id collides with a built-in.
 * Mirrors the runtime read-path filter in `Envelope.getCustom()` so
 * the panel and settings.json agree on what's "visible."
 */
async function removeBuiltinShadowsCommand(): Promise<number> {
  const config = vscode.workspace.getConfiguration('tcpClient');
  const raw = config.get<unknown>('envelopes.custom', []);
  if (!Array.isArray(raw)) { return 0; }
  const builtinIdSet = new Set(listBuiltin().map((b) => b.id));
  const filtered = raw.filter((e): boolean => {
    return !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string'
      && !builtinIdSet.has((e as { id: string }).id);
  });
  const removed = raw.length - filtered.length;
  if (removed > 0) {
    await config.update('envelopes.custom', filtered, vscode.ConfigurationTarget.Global);
  }
  return removed;
}

export function deactivate(): void {
  // TcpPanel disposes itself when the panel is closed
}
