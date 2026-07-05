import * as vscode from 'vscode';

/**
 * A Variable is a named value that may be interpolated into outgoing
 * message text via `{{name}}` before encoding.
 *
 * - `name`     — unique identifier, used in `{{name}}` references
 * - `value`    — for custom variables: the literal string to substitute
 *                for built-in variables (e.g. timestamp): ignored, value
 *                is computed at substitution time
 * - `format`   — for the built-in timestamp: a date-format pattern (see
 *                `formatTimestamp`); ignored for custom
 * - `builtin`  — true for the built-in timestamp (always present, not
 *                deletable via the UI); false for user-defined vars
 */
export type Variable = {
  name: string;
  value: string;
  format?: string;
  builtin: boolean;
};

/**
 * Shape of a user-defined variable entry as stored in
 * `tcpClient.variables.custom` in settings.json — just the two fields
 * the user controls. The `format` and `builtin` fields are not persisted.
 */
export type VariableDef = {
  name: string;
  value: string;
};

export const DEFAULT_TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:mm:ss.sssZ';

// ---------------------------------------------------------------------------
// Built-in registry
// ---------------------------------------------------------------------------

const builtins: Variable[] = [];
const registered: Map<string, Variable> = new Map();

/**
 * Returns the runtime registry value for a variable name, looking first
 * at built-ins and then at runtime-registered entries. Mirrors the
 * envelope registry pattern.
 */
export function get(name: string): Variable | undefined {
  return registered.get(name);
}

/**
 * Returns all variables currently in the runtime registry (no custom
 * ones from settings).
 */
export function list(): Variable[] {
  return Array.from(registered.values());
}

/** Returns only the built-in variables registered via `_registerBuiltin`. */
export function listBuiltin(): Variable[] {
  return builtins.slice();
}

/**
 * Reads user-defined variables from VS Code configuration
 * (`tcpClient.variables.custom`). Returns an empty array if the setting
 * is missing or malformed.
 *
 * Note: Task 1 declares this signature; Task 2 wires it through to the
 * live configuration. For now the implementation already reads from
 * `vscode.workspace.getConfiguration('tcpClient').get('variables.custom')`
 * so it Just Works once the `package.json` schema is in place.
 */
export function getCustom(): Variable[] {
  const raw = vscode.workspace
    .getConfiguration('tcpClient')
    .get<VariableDef[]>('variables.custom', []);

  if (!Array.isArray(raw)) { return []; }

  const result: Variable[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) {
      continue;
    }
    result.push({
      name: entry.name,
      value: typeof entry.value === 'string' ? entry.value : '',
      builtin: false,
    });
  }
  return result;
}

/** Built-ins first, then custom variables from settings. */
export function getAll(): Variable[] {
  return [...listBuiltin(), ...getCustom()];
}

/**
 * Looks up a variable by name from a provided list. Returns `undefined`
 * if not found. Exposed so callers (e.g. the UI) can resolve names
 * without depending on the global registry.
 */
export function lookup(name: string, all: Variable[]): Variable | undefined {
  return all.find((v) => v.name === name);
}

// ---------------------------------------------------------------------------
// Timestamp formatting (minimal, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Formats a `Date` according to a small subset of date-fns-style tokens.
 * Supports: `YYYY MM DD HH mm ss sss Z`.
 *
 * `Z` is emitted as the literal character `Z` (the UTC marker), since
 * the v1 built-in always renders UTC. Custom timezone offsets are not
 * supported — v1 is UTC-only, configurable only by format choice.
 *
 * If the format string contains a token character we don't understand
 * we fall back to `DEFAULT_TIMESTAMP_FORMAT` and `console.warn` so the
 * user still sees a sane value rather than a half-rendered one.
 */
export function formatTimestamp(date: Date, format: string): string {
  // Allow letters/symbols that appear in legitimate format strings
  // (e.g. date-fns tokens YYYY, MM, DD; common separators : / - . T Z and digits).
  // Anything outside this set triggers the fallback + console.warn.
  const unsupported = /[^YMDHmssZ:\-T.Z+\/0-9 ]/;
  if (unsupported.test(format)) {
    console.warn(`Unsupported timestamp format token: "${format}". Falling back to default.`);
    format = DEFAULT_TIMESTAMP_FORMAT;
  }

  const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  const pad3 = (n: number): string => (n < 10 ? `00${n}` : (n < 100 ? `0${n}` : `${n}`));

  // ISO 8601 with milliseconds + explicit `Z`
  const YYYY = `${date.getUTCFullYear()}`;
  const MM = pad2(date.getUTCMonth() + 1);
  const DD = pad2(date.getUTCDate());
  const HH = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  const sss = pad3(date.getUTCMilliseconds());

  return format
    .replace(/YYYY/g, YYYY)
    .replace(/MM/g, MM)
    .replace(/DD/g, DD)
    .replace(/HH/g, HH)
    .replace(/mm/g, mm)
    .replace(/sss/g, sss)
    .replace(/ss/g, ss)
    .replace(/Z/g, 'Z');
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/** Matches `{{name}}` where name matches the documented identifier shape. */
const REFERENCE_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}\}/g;

/**
 * Substitutes `{{name}}` references in `text` with the corresponding
 * variable values.
 *
 * Rules:
 *  - `{{name}}` is replaced with `value` (custom) or the computed
 *    timestamp (built-in `name === 'timestamp'`).
 *  - Unknown variable names are left in the output verbatim and a
 *    `console.warn` is emitted once per reference.
 *  - Substitution is a single pass — the output is NOT re-scanned, so
 *    substituted text containing `{{` is preserved literally.
 *  - `\{\{` and `\}\}` are escape sequences handled by `encodeMessage`;
 *    by the time the substitution layer runs, the bytes `0x7B 0x7B`
 *    are literal `{` characters in the string and are NOT recognised
 *    as a reference (the substitution regex won't match a `{`-followed
 *    by a single `{`).
 *
 * @param text      The message text to substitute.
 * @param variables The list of variables to use (typically from `getAll()`).
 * @param now       Optional fixed `Date` for the built-in timestamp —
 *                  used by tests to make assertions deterministic. Defaults
 *                  to `new Date()` at call time.
 */
export function substitute(
  text: string,
  variables: Variable[],
  now: Date = new Date()
): string {
  return text.replace(REFERENCE_RE, (match, name: string) => {
    const v = lookup(name, variables);
    if (!v) {
      console.warn(`Unknown variable: ${name}`);
      return match;
    }
    if (v.builtin && name === 'timestamp') {
      const liveFormat = vscode.workspace
        .getConfiguration('tcpClient')
        .get<string>('variables.timestampFormat', v.format ?? DEFAULT_TIMESTAMP_FORMAT)
      return formatTimestamp(now, liveFormat)
    }
    return v.value;
  });
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/**
 * Internal: register a built-in variable. Called from `builtins.ts` at
 * module load. Exposed for the test suite.
 *
 * If a built-in with the same `name` already exists, it is replaced in
 * both the `builtins[]` array and the runtime `registered` map. This
 * mirrors `Envelope._registerBuiltin` and lets tests re-seed the
 * timestamp format without growing the list.
 */
export function _registerBuiltin(variable: Variable): void {
  builtins.push(variable);
  // Replace any existing entry with the same name (in both the array
  // and the runtime map) so a re-register doesn't duplicate the entry.
  const existingIdx = builtins.findIndex((b) => b.name === variable.name);
  if (existingIdx !== -1 && builtins[existingIdx] !== variable) {
    builtins[existingIdx] = variable;
    // Trim duplicate entries so listBuiltin returns one per name.
    for (let i = builtins.length - 1; i >= 0; i--) {
      if (i !== existingIdx && builtins[i].name === variable.name) {
        builtins.splice(i, 1);
      }
    }
  }
  registered.set(variable.name, variable);
}

/**
 * Test hook: clear the entire registry (built-ins + runtime entries).
 * Use in suite setup to reach a known state.
 */
export function _clearAllForTests(): void {
  builtins.length = 0;
  registered.clear();
}

/**
 * Test hook: re-register the standard built-ins (timestamp). Use in
 * suite setup after `_clearAllForTests()`.
 */
export function _loadBuiltinsForTests(): void {
  _registerBuiltin({
    name: 'timestamp',
    value: '',
    format: DEFAULT_TIMESTAMP_FORMAT,
    builtin: true,
  });
}
