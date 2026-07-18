import * as vscode from 'vscode';
import { TcpPanel } from './TcpPanel';
// Side-effect import: registers the built-in envelopes (none, hl7-mllp,
// hl7-llp) into the envelope registry at activation time.
import './envelopes/builtins';
// Side-effect import: registers the built-in variables (timestamp) into
// the variable registry at activation time.
import './variables/builtins';
import { maybePrefillHL7Envelopes, prefillHL7EnvelopesCommand } from './envelopes/prefill';

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
}

export function deactivate(): void {
  // TcpPanel disposes itself when the panel is closed
}
