import { _registerBuiltin } from './Variables';

/**
 * Built-in variables. Imported from `extension.ts` at activation so the
 * registry is populated before any panel tries to enumerate variables.
 *
 * Currently registered:
 *  - timestamp: current time, formatted with the user-configurable
 *    `tcpClient.variables.timestampFormat` setting (default ISO 8601).
 *    Always present, not deletable from the UI.
 *
 * The `format` field below is the seed default; `formatTimestamp` reads
 * the live setting at substitution time, so user-configured formats
 * take precedence. We seed it here so the registry has a usable entry
 * even when the test runner has not set the setting (e.g. headless
 * unit tests that don't import extension.ts).
 */
_registerBuiltin({
  name: 'timestamp',
  value: '',
  format: 'YYYY-MM-DDTHH:mm:ss.sssZ',
  builtin: true,
});
