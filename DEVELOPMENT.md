# TCP Client for VS Code

**Talk to any TCP server without leaving your editor.**

TCP Client brings a lightweight, full-featured TCP socket client straight into VS Code — no terminal, no external tools, no context switching. Connect to a server, send raw or binary messages, and watch responses in a clean, timestamped log. Perfect for debugging network services, testing custom protocols, or poking at IoT devices.

![TCP Client in action](https://github.com/ruimgoncalves/vscode-tcp-client/raw/main/screenshot.png)

---

## Features

### 🔌 Connect to Any TCP Server
Just enter `host:port` and hit Connect. The status dot tells you everything at a glance — grey when idle, amber while connecting, green when live.

### ⌨️ Send Any Message
- Plain text in **UTF-8, ASCII, Latin-1, or UTF-16 LE**
- **Binary support** via escape sequences (`\xFF`, `\x00`, `\n`, `\r`, `\t`, `\\`)
- Press **Ctrl+Enter** to send without touching the mouse

### 📋 Response Log
Every response is logged with a **timestamp** and **response time in milliseconds** — useful for benchmarking or spotting timeouts.

### 💾 Remembers Your State
Server address, encoding, and draft message are **automatically saved** between sessions. Close the panel, reopen VS Code — your context is still there.

---

## Install

### From the VS Code Marketplace *(coming soon)*
Search for **"TCP Client"** in the Extensions view and click Install.

### From a `.vsix` package
Download the latest `.vsix` from the [Releases](https://github.com/ruimgoncalves/vscode-tcp-client/releases) page, then:
**Extensions → ⋯ → Install from VSIX…**

### From source
```bash
git clone https://github.com/ruimgoncalves/vscode-tcp-client.git
cd vscode-tcp-client
npm install
npm run compile
# Press F5 to launch the Extension Development Host
```

---

## How to Use

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → **TCP Client: Open Panel**
2. Enter your server address (e.g. `localhost:9000`) and click **Connect**
3. Type a message — use escape sequences for binary data
4. Press **Send** or **Ctrl+Enter**
5. Watch responses appear in the log with timestamps and response times

### Escape Sequences

| Sequence | Meaning |
|----------|---------|
| `\xHH`   | Raw byte (e.g. `\xFF`) |
| `\n`     | Newline (0x0A) |
| `\r`     | Carriage return (0x0D) |
| `\t`     | Tab (0x09) |
| `\\`     | Literal backslash |
| `\0`     | Null byte (0x00) |

---

## Use Cases

- **Debug network services** — test your API server or database directly
- **IoT & embedded** — send crafted binary packets to devices
- **Protocol exploration** — experiment with custom or undocumented protocols
- **Performance testing** — measure round-trip latency with built-in response timers

---

## Architecture

The extension is intentionally small. The key files:

- `src/extension.ts` — entry point, registers the `tcpClient.openPanel` command
  and triggers built-in envelope registration
- `src/TcpClient.ts` — thin `net.Socket` wrapper, `EventEmitter`-based
- `src/TcpPanel.ts` — VS Code webview panel, owns a `TcpClient` and a
  webview; renders the HTML
- `src/MessageEncoder.ts` — escape-sequence parser used for both message
  payloads and envelope prefix/suffix strings
- `src/envelopes/Envelope.ts` — envelope registry, `wrap()` function, and
  helpers (`get`, `getAll`, `resolve`, …)
- `src/envelopes/builtins.ts` — registers the three built-in envelopes
  (`none`, `hl7-mllp`, `hl7-llp`) on import
- `src/variables/Variables.ts` — variable registry, `substitute()` function
  (v2: optional pipe suffix), `formatTimestamp()` for `{{timestamp}}`,
  built-in dispatch for `{{seq}}` and `{{uuid}}`
- `src/variables/builtins.ts` — registers the `timestamp`, `seq`, and
  `uuid` built-ins on import
- `src/test/suite/` — mocha tests, one file per source module

### Adding a new built-in envelope

1. Edit `src/envelopes/builtins.ts` and call `_registerBuiltin(...)` with
   an `Envelope` value. Escape sequences in `prefix` / `suffix` use the
   same syntax as the message area (`\xHH`, `\n`, `\r`, `\t`, `\\`, `\0`).
2. Add a test case in `src/test/suite/Envelopes.test.ts` to confirm the
   framing bytes are correct.
3. Update the built-ins table in `README.md`.

### Wrap modes

`wrap()` intentionally does not transform the payload bytes themselves — it
only adds framing. One mode is built in, plus an optional per-line
extension:

- **Default (single wrap)** — wrap the entire payload once with
  `prefix + payload + suffix`. Used by HL7 v2 MLLP, STX/ETX, and most
  framed protocols. This is the fast path inside `wrap()` and is
  byte-identical to the v0.2.0 behaviour.
- **Per-line (optional)** — when `linePrefix` and/or `lineSuffix` are
  non-empty, `wrap()` splits the payload on `\n` and wraps each line
  individually with the line-level prefix/suffix (see the section below).

### Line prefix and suffix

`EnvelopeSpec` has two optional fields that add bytes to every line of
the payload:

- `linePrefix` — bytes (escape-sequence string) prepended to every line.
- `lineSuffix` — bytes (escape-sequence string) appended to every line.

When both are empty (the default), `wrap()` is byte-identical to the
single-wrap behaviour: `prefix + payload + suffix`. This is a fast path
inside `wrap()`.

When at least one is non-empty, `wrap()` splits the payload on `\n` (a
single byte 0x0A) and emits `linePrefix + line + lineSuffix` for each
line, including empty lines from leading, trailing, or consecutive
newlines. Consecutive lines are rejoined with a single `\n` byte. The
whole per-line result is then wrapped with the outer `prefix` and
`suffix`.

Example (NRPE-style STX/ETX per line with a `>` line marker):

```json
{
  "tcpClient.envelopes.custom": [
    {
      "id": "stx-etx-line",
      "label": "STX/ETX per line",
      "prefix": "\\x02",
      "suffix": "\\x03",
      "linePrefix": ">",
      "lineSuffix": "<"
    }
  ]
}
```

A payload of `LOAD\nCPU\nMEM` produces (STX wraps the whole
message, then per-line `> ... <`, lines rejoined with single `\n`, then
ETX at the end):

```
\x02 >LOAD< \n >CPU< \n >MEM< \x03
```

Use `linePrefix` / `lineSuffix` when:

- The server reads discrete commands/messages, one per line
  (NRPE `check_nrpe`, syslog-style line protocols, line-oriented
  logging).
- You want a single user-typed payload to become N independent framed
  records on the wire.

Leave both empty (default) when:

- The protocol frames the whole message once (HL7 v2 MLLP, STX/ETX).
- Your payload is a single binary blob or already-terminated record.

The `linePrefix` and `lineSuffix` fields use the same escape-sequence
syntax as `prefix` / `suffix` (e.g. `\x02`, `\n`, `\r`).

### Custom envelopes

Custom envelopes are read from `vscode.workspace.getConfiguration('tcpClient')
.get('envelopes.custom')` at panel creation time. The schema is declared in
`package.json` under `contributes.configuration` and is therefore editable
via VS Code's Settings UI as well as `settings.json`. Adding a new custom
envelope requires no code changes. External edits to the setting take
effect on the next panel open, matching the `variables.custom` behaviour.

Every custom envelope accepts the full `EnvelopeSpec` shape: `prefix`,
`suffix`, plus the optional per-line fields
`linePrefix` and `lineSuffix` (escape-string, default `""`). When both
`linePrefix` and `lineSuffix` are empty, the envelope wraps the whole
payload once — identical to v0.2.0 behavior. When at least one is
non-empty, `wrap()` splits on `\n` and wraps every line individually.
See the "Line prefix and suffix" section above for the full semantics.

### Variables

The variables layer sits **before** `wrap()` in the send pipeline, so
substitution happens before encoding and framing. The pipeline is:
message text → `substitute()` → `encodeMessage()` → `wrap()` → socket.

A `Variable` is `{ name, value, format?, builtin }`. Built-in variables
are always present and not deletable; user variables come from
`tcpClient.variables.custom` in settings.json.

`substitute(text, variables)` uses `/\{\{([a-zA-Z_][a-zA-Z0-9_.-]*)(?:\|([^}]*))?\}\}/g`
to match both `{{name}}` and `{{name|pipe}}`. The pipe group is
undefined when no pipe is present. Unknown names are left in place (pipe
and all) and a `console.warn` is emitted (once per reference). The
substitution is single-pass: substituted output is NOT re-scanned, so a
custom variable whose value contains `{{x}}` is treated as literal text.

For the built-in `timestamp`, a non-empty pipe overrides the live
`tcpClient.variables.timestampFormat` setting; an empty pipe (or no
pipe) reads the setting. For `seq`, the panel passes `state.seq` and
the function returns it directly; pipe is silently ignored. For
`uuid`, the function calls `crypto.randomUUID()` (Node 14.17+);
pipe is silently ignored. For user-defined variables, the pipe is
silently stripped and the variable's literal value is substituted.

The `timestamp` built-in's format is re-read from
`tcpClient.variables.timestampFormat` on every `substitute()` call, so
changes in the Settings UI or settings.json take effect immediately for
the next message — no re-registration needed.

#### Escape interaction

The `MessageEncoder` adds `\{` and `\}` as literal-brace escapes. This
lets the user send a literal `{{name}}` in the message text by writing
`\{\{name\}\}` — the encoder converts each `\{` to a literal `{` byte,
so substitute sees the text `{{name}}` and (assuming no `name`
variable is defined) leaves it as-is.

The substitute regex doesn't see the user's escape syntax — it only
sees the post-encoded string. So `\{\{name\}\}` after encode becomes
`{{name}}`, which substitute treats as a reference (and falls through
unchanged if unknown). The escape mechanism and the substitution
mechanism layer cleanly.

#### seq counter

The `{{seq}}` built-in is panel-managed, not model-managed. The panel
holds a private `_seq` field initialized to 1 when the panel opens.
On each successful `tcpClient.send()` call, the panel increments
`_seq` by 1. The value passed into `substitute()` is the current
value (before increment), so the first message gets seq=1, the
second gets seq=2, and so on.

The counter is per-panel-instance. Two panels have independent
counters. Closing the panel and reopening resets the counter to 1
(new session).

#### Persistent message

The webview's draft message is persisted via
`extensionContext.globalState` (per VS Code install), not
`vscode.setState`. `setState` is webview-scoped and dies with the
webview context on VS Code restart; `globalState` survives. Other
fields (server, encoding, envelope) stay on `setState` since they
are session preferences, not draft content.

When the panel opens, it asks the extension for the persisted
message via a `getPersistedMessage` postMessage and restores the
value into the message textarea. On every input change, the
webview posts a `persistMessage` and the extension writes it back
to globalState (fire-and-forget; no debounce needed since
globalState.update is cheap and in-memory).

#### Adding a new built-in variable

1. Edit `src/variables/builtins.ts` and call `_registerBuiltin({...})`
   with a `Variable` value. Set `builtin: true` so the UI treats it as
   non-deletable.
2. If the variable is computed (like `timestamp`), it needs a custom
   substitution rule. The current `substitute()` implementation
   special-cases `timestamp`, `seq`, and `uuid` — to add e.g.
   `{{hostname}}`, extend the function with another `if` branch.
3. If the new variable supports a per-message format override (like
   `timestamp`), extend the `substitute()` dispatch to check for the
   variable's name and apply the pipe. Otherwise, return the value
   directly with the pipe silently ignored (matches the current
   `seq`/`uuid`/user-var behavior).
4. Add a test case in `src/test/suite/Variables.test.ts` covering the
   new variable's substitution behavior.
5. Update the built-ins table in `README.md` (add a row to the Variables
   section).

---

## License

MIT
