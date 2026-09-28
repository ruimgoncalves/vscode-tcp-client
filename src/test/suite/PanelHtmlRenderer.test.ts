import * as assert from 'assert';
import * as vscode from 'vscode';
import { Envelope } from '../../envelopes/Envelope';
import { TcpPanel } from '../../TcpPanel';
import { renderPanelHtml } from '../../PanelHtml';

suite('webview panel HTML renderer', () => {
  const none: Envelope = {
    id: 'none',
    label: 'None (raw)',
    spec: { prefix: '', suffix: '', linePrefix: '', lineSuffix: '' },
  };

  const inputs = (envelopes: Envelope[], builtins: Envelope[] = [none]) => ({
    nonce: '0123456789abcdef',
    cspSource: 'vscode-webview-resource:',
    styleUri: 'vscode-webview://panel.css',
    mainScriptUri: 'vscode-webview://main.js',
    envelopes,
    builtins,
  });

  test('panel bootstrap keeps a literal script terminator inside preset data', async () => {
    const payload = '</script><script>alert("x")</script>';
    const config = vscode.workspace.getConfiguration('tcpClient');
    await config.update('envelopes.custom', [{
      id: 'script-test',
      label: 'Script test',
      suffix: payload,
    }], vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('tcpClient.openPanel');
      const panel = TcpPanel.currentPanel;
      assert.ok(panel, 'TCP panel should be open');
      const panelInternals = panel as unknown as {
        _panel: vscode.WebviewPanel;
        _getHtmlForWebview(webview: vscode.Webview): string;
      };
      const html = panelInternals._getHtmlForWebview(panelInternals._panel.webview);
      const bootstrap = html.match(
        /<script nonce="[^"]+">window\.__TCP_BOOTSTRAP__ = \{ presets: (.*?) \};<\/script>/s
      );
      assert.ok(bootstrap, 'inline bootstrap script should be present');
      assert.ok(!bootstrap[1].includes('</script>'), 'preset data must not terminate the bootstrap script');
      const presets = JSON.parse(bootstrap[1]) as Record<string, { suffix: string }>;
      assert.strictEqual(presets['script-test'].suffix, payload);
    } finally {
      await config.update('envelopes.custom', [], vscode.ConfigurationTarget.Global);
    }
  });

  test('bootstrap JSON cannot terminate its script and preserves preset data', () => {
    const payload = '</script><script>alert("x")</script>';
    const html = renderPanelHtml(inputs([
      none,
      {
        id: 'custom',
        label: 'Custom',
        spec: { prefix: '', suffix: payload, linePrefix: '', lineSuffix: '' },
      },
    ]));
    const bootstrap = html.match(
      /<script nonce="[^"]+">window\.__TCP_BOOTSTRAP__ = \{ presets: (.*?) \};<\/script>/s
    );
    assert.ok(bootstrap, 'inline bootstrap script should be present');
    assert.ok(!bootstrap[1].includes('</script>'), 'serialized preset data must not contain a script terminator');
    const presets = JSON.parse(bootstrap[1]) as Record<string, { suffix: string }>;
    assert.strictEqual(presets.custom.suffix, payload);
  });

  test('preserves strict CSP, escaped option attributes, resource URIs, and panel markup', () => {
    const unsafePlaceholderPreset: Envelope = {
      id: 'none',
      label: 'None (raw)',
      spec: { prefix: '<&', suffix: '"', linePrefix: '', lineSuffix: '' },
    };
    const html = renderPanelHtml(inputs([
      none,
      {
        id: 'custom&<"',
        label: 'Custom & <label>',
        spec: { prefix: '<&', suffix: '"', linePrefix: '', lineSuffix: '' },
      },
    ], [unsafePlaceholderPreset]));
    assert.ok(html.includes("default-src 'none'; style-src vscode-webview-resource:; script-src 'nonce-0123456789abcdef';"));
    assert.ok(html.includes('href="vscode-webview://panel.css"'));
    assert.ok(html.includes('src="vscode-webview://main.js"'));
    assert.ok(html.includes('value="custom&amp;&lt;&quot;">Custom &amp; &lt;label&gt;</option>'));
    assert.ok(html.includes('placeholder="&lt;&amp;"'));
    assert.ok(html.includes('id="helpBtn"'));
    assert.ok(html.includes('id="envelope-prefix"'));
    assert.ok(html.includes('id="varsBody"'));
    assert.ok(html.includes('id="helpBackdrop"'));
  });
});
