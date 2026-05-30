import * as vscode from 'vscode';
import { TcpPanel } from './TcpPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tcpClient.openPanel', () => {
      TcpPanel.createOrShow(context.extensionUri);
    })
  );
}

export function deactivate(): void {
  // TcpPanel disposes itself when the panel is closed
}
