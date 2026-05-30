import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {

  test('extension is registered', () => {
    const ext = vscode.extensions.getExtension('local.vscode-tcp-client');
    assert.ok(ext, 'Extension should be installed in the test environment');
  });

  test('tcpClient.openPanel command exists', async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('tcpClient.openPanel'), 'Command tcpClient.openPanel should be registered');
  });

  test('panel opens without throwing', async () => {
    await assert.doesNotReject(
      () => Promise.resolve(vscode.commands.executeCommand('tcpClient.openPanel'))
    );
    // Give the webview a moment to initialise
    await new Promise((r) => setTimeout(r, 200));
  });

});
