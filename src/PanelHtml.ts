import { Envelope } from './envelopes/Envelope';
import { envelopePanelFragment } from './envelopes/panelHtml';

export interface PanelHtmlOptions {
  nonce: string;
  cspSource: string;
  styleUri: string;
  mainScriptUri: string;
  envelopes: Envelope[];
  builtins: Envelope[];
}

/** HTML-escape attribute values embedded into the webview document. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render the TCP Client webview document from its host-provided snapshots. */
export function renderPanelHtml(options: PanelHtmlOptions): string {
  const envelopeOptions = options.envelopes
    .map((envelope) => `<option value="${escapeHtmlAttr(envelope.id)}">${escapeHtmlAttr(envelope.label)}</option>`)
    .join('');

  // JSON is embedded in an HTML script element: escape `<` so data containing
  // `</script>` cannot terminate the element before JavaScript parses it.
  const presetsJson = JSON.stringify(
    Object.fromEntries(options.envelopes.map((envelope) => [envelope.id, envelope.spec]))
  ).replace(/</g, '\\u003c');

  const initialPreset = options.builtins.find((envelope) => envelope.id === 'none') ?? options.builtins[0];
  const presetPrefix = initialPreset ? initialPreset.spec.prefix : '';
  const presetSuffix = initialPreset ? initialPreset.spec.suffix : '';
  const presetLinePrefix = initialPreset ? initialPreset.spec.linePrefix : '';
  const presetLineSuffix = initialPreset ? initialPreset.spec.lineSuffix : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TCP Client</title>
<link rel="stylesheet" href="${options.styleUri}">
</head>
<body>

<div class="header-row">
  <span class="header-title">TCP Client</span>
  <button class="sec help-btn" id="helpBtn" title="Syntax help (escape sequences and variables)">?</button>
</div>

<div class="row">
  <label for="server">Server</label>
  <input id="server" type="text" value="localhost:9000" placeholder="host:port" spellcheck="false" autocomplete="off">
  <div class="dot" id="dot" data-state="disconnected"></div>
  <button id="connectBtn" data-state="disconnected">Connect</button>
</div>

<div class="row">
  <label for="encoding">Encoding</label>
  <select id="encoding">
    <option value="utf8">UTF-8</option>
    <option value="ascii">ASCII</option>
    <option value="latin1">Latin-1 (ISO-8859-1)</option>
    <option value="utf16le">UTF-16 LE</option>
  </select>
</div>

${envelopePanelFragment({ envelopeOptions })}

<div id="envelope-notice" class="envelope-notice" hidden></div>

<div id="envelope-fields" class="envelope-fields">
  <div class="env-field">
    <label for="envelope-prefix">Prefix</label>
    <div class="env-input-wrap">
      <input id="envelope-prefix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetPrefix)}">
      <button id="envelope-reset-prefix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset prefix" hidden>↺</button>
    </div>
  </div>
  <div class="env-field">
    <label for="envelope-suffix">Suffix</label>
    <div class="env-input-wrap">
      <input id="envelope-suffix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetSuffix)}">
      <button id="envelope-reset-suffix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset suffix" hidden>↺</button>
    </div>
  </div>
  <div class="env-field">
    <label for="envelope-linePrefix">Line Prefix</label>
    <div class="env-input-wrap">
      <input id="envelope-linePrefix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetLinePrefix)}">
      <button id="envelope-reset-linePrefix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset line prefix" hidden>↺</button>
    </div>
  </div>
  <div class="env-field">
    <label for="envelope-lineSuffix">Line Suffix</label>
    <div class="env-input-wrap">
      <input id="envelope-lineSuffix" type="text" spellcheck="false" autocomplete="off"
             placeholder="${escapeHtmlAttr(presetLineSuffix)}">
      <button id="envelope-reset-lineSuffix" class="env-reset" type="button" title="Reset to preset default" tabindex="-1" aria-label="Reset line suffix" hidden>↺</button>
    </div>
  </div>
</div>

<div class="msg-wrap">
  <div class="row">
    <span class="sec-label">Message</span>
  </div>
  <textarea id="msg" placeholder="Type message... Use {{name}} for your variables, {{timestamp|format}} for time, {{seq}} for sequence, {{uuid}} for unique id."></textarea>
  <div class="row">
    <button id="sendBtn" disabled>Send</button>
  </div>
</div>

<div class="vars-wrap">
  <div class="row">
    <span class="sec-label">Variables</span>
  </div>
  <div id="varsBody" class="vars-body"></div>
  <div class="var-add">
    <input id="newVarName" class="name" type="text" spellcheck="false" autocomplete="off" placeholder="name">
    <input id="newVarValue" type="text" spellcheck="false" autocomplete="off" placeholder="value">
    <button class="sec" id="addVarBtn">Add</button>
  </div>
</div>

<div class="log-wrap">
  <div class="row">
    <span class="sec-label">Response Log</span>
    <button class="sec" id="clearBtn">Clear</button>
  </div>
  <div id="log"></div>
</div>

<div id="helpBackdrop" class="modal-backdrop" hidden>
  <div class="modal" role="dialog" aria-labelledby="helpTitle">
    <button class="sec modal-close" id="helpCloseBtn" aria-label="Close">&times;</button>
    <h2 id="helpTitle">Syntax help</h2>
    <div class="modal-body">
      <section class="help-section">
        <h3>Escape sequences</h3>
        <p class="hint">Click any row to paste it into the message.</p>
        <table id="escapeTable" class="help-table">
          <!-- populated by JS from the getSyntaxHelp response -->
        </table>
      </section>
      <section class="help-section">
        <h3>Variables</h3>
        <label class="preview-toggle">
          <input type="checkbox" id="livePreviewToggle"> Show live substitution preview
        </label>
        <table id="varsTable" class="help-table">
          <!-- populated by JS -->
        </table>
      </section>
    </div>
  </div>
</div>

<script nonce="${options.nonce}">window.__TCP_BOOTSTRAP__ = { presets: ${presetsJson} };</script>
<script type="module" nonce="${options.nonce}" src="${options.mainScriptUri}"></script>
</body>
</html>`;
}
