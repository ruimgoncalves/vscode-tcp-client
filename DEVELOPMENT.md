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

The `segmentSeparator` field is informational and is not applied to the
payload — if you need to mutate the user-typed text, do it in the webview
or as a separate layer before `wrap()` runs.

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
.get('envelopes.custom')` at panel creation time, plus on every
`getEnvelopes` request from the webview. The schema is declared in
`package.json` under `contributes.configuration` and is therefore editable
via VS Code's Settings UI as well as `settings.json`. Adding a new custom
envelope requires no code changes.

Every custom envelope accepts the full `EnvelopeSpec` shape: `prefix`,
`suffix`, `segmentSeparator`, plus the optional per-line fields
`linePrefix` and `lineSuffix` (escape-string, default `""`). When both
`linePrefix` and `lineSuffix` are empty, the envelope wraps the whole
payload once — identical to v0.2.0 behavior. When at least one is
non-empty, `wrap()` splits on `\n` and wraps every line individually.
See the "Line prefix and suffix" section above for the full semantics.

---

## License

MIT
