import * as vscode from 'vscode';
import { TcpPanel } from './TcpPanel';
// Side-effect import: registers the built-in envelopes (none, hl7-mllp,
// hl7-llp) into the envelope registry at activation time.
import './envelopes/builtins';
// Side-effect import: registers the built-in variables (timestamp) into
// the variable registry at activation time.
import './variables/builtins';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tcpClient.openPanel', () => {
      TcpPanel.createOrShow(context.extensionUri, context);
    })
  );
}

export function deactivate(): void {
  // TcpPanel disposes itself when the panel is closed
}
