/**
 * HTML fragment for the envelope row + Save/Delete dialogs.
 *
 * Embedded into the panel HTML by `TcpPanel._getHtmlForWebview` via the
 * `${envelopePanelFragment(...)}` template-literal interpolation. Lives
 * in its own file so the markup + dialog structure can evolve without
 * touching the 1400-line `TcpPanel.ts` template.
 *
 * The IDs (`#envelope-save-btn`, `#savePresetDialog`, etc.) are the
 * canonical contract with `media/main.js` (the Save/Delete button
 * IIFE was formerly exported as a string from `panelButtons.ts` and
 * inlined at the end of `TcpPanel.ts`'s webview template literal;
 * after the external-resources refactor that IIFE lives in
 * `media/main.js` next to the main panel IIFE, so the IDs and event
 * wiring are the single source of truth). If you rename them here,
 * rename them in `main.js`. The check is enforced by the
 * `scripts/check-webview-js.js` guard.
 *
 * The function takes `envelopeOptions` (the rendered <option> tags,
 * already HTML-escaped by the caller) as a parameter rather than
 * interpolating it inside this string constant. The reason: a string
 * constant exported as a module is already a fully-resolved string at
 * module load, so a `${envelopeOptions}` inside it would render as
 * literal text in the panel HTML, not be substituted at call time.
 * Returning a function lets the caller pass the value in at the moment
 * of template-literal evaluation.
 */

export function envelopePanelFragment(opts: { envelopeOptions: string }): string {
  return `
<div class="row">
  <label for="envelope">Envelope</label>
  <select id="envelope">
    ${opts.envelopeOptions}
  </select>
  <button id="envelope-save-btn" class="env-action" type="button" title="Save the current prefix/suffix fields as a new preset">+ Save preset</button>
  <button id="envelope-delete-btn" class="env-action env-action-danger" type="button" title="Delete the currently selected custom preset" disabled>Delete</button>
</div>

<dialog id="savePresetDialog" class="preset-dialog">
  <form method="dialog" id="savePresetForm">
    <h3>Save preset</h3>
    <p class="preset-dialog-hint">Captures the current prefix / suffix / line prefix / line suffix as a new preset. The preset appears in the envelope dropdown.</p>
    <label for="savePresetLabel">Preset name</label>
    <input id="savePresetLabel" type="text" maxlength="64" autocomplete="off" placeholder="e.g. STX/ETX framed" required>
    <div class="preset-dialog-buttons">
      <button type="button" id="savePresetCancel">Cancel</button>
      <button type="submit" id="savePresetConfirm" value="default">Save</button>
    </div>
  </form>
</dialog>

<dialog id="deletePresetDialog" class="preset-dialog">
  <form method="dialog" id="deletePresetForm">
    <h3>Delete preset</h3>
    <p id="deletePresetMessage" class="preset-dialog-hint">Delete this preset?</p>
    <div class="preset-dialog-buttons">
      <button type="button" id="deletePresetCancel">Cancel</button>
      <button type="submit" id="deletePresetConfirm" value="default">Delete</button>
    </div>
  </form>
</dialog>
`;
}