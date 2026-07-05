# TCP Client for VS Code

**Talk to any TCP server without leaving your editor.**

TCP Client brings a full-featured TCP socket client straight into VS Code — no terminal, no external tools, no context switching. Connect to any server, send text or binary messages, and watch responses appear in a clean, timestamped log.

![TCP Client in action](https://github.com/ruimgoncalves/vscode-tcp-client/raw/main/screenshot.png)

---

## Features

**🔌 Connect to any TCP server**
Enter `host:port`, hit Connect. A status dot shows connection state at a glance — grey when idle, amber while connecting, green when connected.

**⌨️ Send any message**
Plain text in UTF-8, ASCII, Latin-1, or UTF-16 LE. Binary data via escape sequences: `\xFF`, `\x00`, `\n`, `\r`, `\t`, `\\`. Press **Ctrl+Enter** to send.

**🔤 Variable interpolation**
Reference `{{name}}` values in the message area — built-in `{{timestamp}}`,
`{{seq}}`, `{{uuid}}`, plus your own user-defined variables. Format
timestamps inline with `{{timestamp|FORMAT}}`. User variables editable
in the Variables section.

**📋 Timestamped response log**
Every response is logged with a precise timestamp and round-trip response time in milliseconds.

**💾 Persistent state**
Server address, encoding, and draft message survive panel close/reopen and VS Code restarts.

**📨 Message envelopes**
Wrap outgoing messages with configurable prefix/suffix bytes — pick a built-in (HL7 v2 MLLP framing, raw LLP) or define your own custom envelope in `settings.json`. No need to type framing bytes manually.

**❓ Inline syntax help**
Click the yellow `?` button (top-right of the panel) to open a built-in cheat sheet for escape sequences and variables. Click any row to paste the syntax into the Message field — no need to memorize `\xHH`, `{{timestamp|YYYY-MM-DD}}`, or the MLLP prefix bytes.

---

## How to Use

1. Open the Command Palette → **TCP Client: Open Panel**
2. Enter your server address (e.g. `localhost:9000`) and click **Connect**
3. Choose an **Envelope** (default: *None / raw*)
4. Type a message — use escape sequences for binary data
5. Press **Send** or **Ctrl+Enter**
6. Watch responses appear in the log with timestamps and response times
7. Not sure how to type a variable or escape? Click the yellow `?` (top-right) for the syntax cheat sheet

### Escape Sequences

| Sequence | Meaning |
|----------|---------|
| `\xHH`   | Raw byte (e.g. `\xFF`) |
| `\n`     | Newline (0x0A) |
| `\r`     | Carriage return (0x0D) |
| `\t`     | Tab (0x09) |
| `\\`     | Literal backslash |
| `\0`     | Null byte (0x00) |
| `\{`     | Literal `{`        |
| `\}`     | Literal `}`        |

### Variables

Insert computed values into outgoing messages with `{{name}}` references.
The text is resolved **before** encoding and framing, so the response log
shows the actual bytes that hit the socket.

#### Built-in variables

Three built-ins are always present and cannot be deleted:

| Name         | Value                                              |
|--------------|----------------------------------------------------|
| `{{timestamp}}` | Current UTC time (default format from settings)   |
| `{{seq}}`       | Per-session counter, starts at 1, increments on each send |
| `{{uuid}}`      | Fresh RFC 4122 v4 UUID per substitution            |

**Format override for `{{timestamp}}`:** use the pipe syntax — `{{timestamp|FORMAT}}` renders the time with FORMAT instead of the default. Available tokens: YYYY, MM, DD, HH, mm, ss, sss, Z (literal UTC marker), X (Unix epoch seconds), x (Unix epoch milliseconds).

#### Pipe syntax

`{{name|format}}` overrides the format for the built-in `{{timestamp}}`.
The pipe is silently ignored for `{{seq}}`, `{{uuid}}`, and user-defined
variables (treated as noise).

Examples:

- `{{timestamp|YYYY-MM-DD}}` → `2026-07-05`
- `{{timestamp|HH:mm:ss}}` → `13:45:23`
- `{{timestamp|X}}` → `1783259123` (epoch seconds)
- `{{seq|anything}}` → just `1` (pipe ignored)
- `{{user.name|ignored}}` → just `ryu` (pipe ignored)

The default format when no pipe is present is `tcpClient.variables.timestampFormat`
in settings.json (default ISO 8601).

#### User variables

Define your own `{{name}}` references in the Variables section: enter a
name and value, click Add. Use them anywhere in the message area, e.g.
`Hello {{user.name}}, status from {{host}}`.

User variables are stored in `settings.json` under
`tcpClient.variables.custom` (as an array of `{name, value}` entries) and
also editable directly in the JSON if you prefer. The format of the
built-in `timestamp` lives in `tcpClient.variables.timestampFormat`.

**Example: variable + HL7 MLLP envelope**

```json
{
  "tcpClient.variables.custom": [
    { "name": "user.name", "value": "ryu" },
    { "name": "session.id", "value": "abc-123" }
  ],
  "tcpClient.variables.timestampFormat": "YYYY-MM-DDTHH:mm:ss.sssZ"
}
```

Then in the panel:

- Type message: `MSH|^~\&|SENDER|...|MSG_{{session.id}}|...|||{{timestamp}}||`
- Envelope: `HL7 v2 (MLLP)`

The bytes that go to the socket have `{{session.id}}` → `abc-123` and
`{{timestamp}}` → the formatted current time, then the whole thing gets
the MLLP VT/FS+CR framing.

#### Unknown variables

If a message references `{{name}}` or `{{name|anything}}` that is not defined, the reference is left in the output (including the pipe, if any) and a warning is logged in the developer console. No send is blocked.

#### Sending literal `{{name}}` in a message

To include literal `{{` and `}}` characters in a message (not as variable
references), escape each brace with a backslash in the encoder syntax:
`\{` produces a literal `{`, `\}` produces a literal `}`. So `\{\{name\}\}`
in the message area sends the literal text `{{name}}`.

### Envelopes

An **envelope** wraps your message with configurable prefix and suffix bytes
before it is written to the socket. This is useful for protocols that have a
well-known start and end marker (like HL7 v2 with MLLP framing).

Select the envelope from the **Envelope** dropdown in the panel. The wrapping
happens automatically — you type only the payload.

#### Built-in envelopes

| Envelope           | Prefix     | Suffix       | Use case                                  |
|--------------------|------------|--------------|-------------------------------------------|
| *None (raw)*       | *(none)*   | *(none)*     | Plain TCP — no framing                    |
| *HL7 v2 (MLLP)*    | `\x0B` (VT)| `\x1C\r`     | HL7 v2 over MLLP-framed TCP               |
| *HL7 v2 (LLP)*     | *(none)*   | `\x1C\r`     | HL7 v2 with LLP end marker but no start   |

The escape sequences in the prefix/suffix columns above use the same syntax as
the message area (`\xHH`, `\n`, `\r`, `\t`, `\\`, `\0`).

#### Custom envelopes

Define your own envelopes in `settings.json` under
`tcpClient.envelopes.custom`. Each entry has:

- `id` *(required)* — a unique identifier for the envelope
- `label` *(required)* — a human-readable label shown in the dropdown
- `prefix` — bytes to prepend (escape-sequence string, default `""`)
- `suffix` — bytes to append (escape-sequence string, default `""`)
- `linePrefix` — bytes (escape-sequence string) prepended to every line
  of the payload. Default `""`. When paired with `lineSuffix`, this turns
  the envelope into a per-line framing protocol (e.g. NRPE).
- `lineSuffix` — bytes (escape-sequence string) appended to every line
  of the payload. Default `""`.

**Example: an HL7 v2 MLLP envelope**

```json
{
  "tcpClient.envelopes.custom": [
    {
      "id": "hl7-mllp-custom",
      "label": "HL7 v2 MLLP (custom)",
      "prefix": "\\x0B",
      "suffix": "\\x1C\\r"
    }
  ]
}
```

**Example: STX/ETX framed protocol**

```json
{
  "tcpClient.envelopes.custom": [
    {
      "id": "stx-etx",
      "label": "STX/ETX framed",
      "prefix": "\\x02",
      "suffix": "\\x03"
    }
  ]
}
```

**Example: per-line STX/ETX framing (NRPE-style)**

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

With `linePrefix` and `lineSuffix` set, the payload is split on `\n` and
each line is wrapped with `linePrefix + line + lineSuffix` (empty lines
from leading/trailing/consecutive newlines are wrapped too). The whole
result is then wrapped with the outer `prefix` and `suffix`. This is the
right framing for protocols that frame every line (e.g. NRPE, line-oriented
logging). Set both to empty strings to keep the default single-wrap
behaviour.

Custom envelopes appear in the **Envelope** dropdown alongside the built-ins.
The selection is persisted per-panel along with the rest of the form state.

### Syntax Help Modal

Not sure how to write `\xFF` or `{{timestamp|YYYY-MM-DD}}`? Click the yellow
`?` button in the top-right of the panel to open an inline cheat sheet. The
modal has two side-by-side columns:

- **Escape Sequences** — every byte escape the encoder supports (`\xHH`,
  `\n`, `\r`, `\t`, `\\`, `\0`, `\{`, `\}`)
- **Variables** — every built-in (`{{timestamp}}`, `{{timestamp|FORMAT}}`,
  `{{seq}}`, `{{uuid}}`) plus any user-defined variables from your
  `settings.json`. Each row shows a live preview for `{{timestamp|FORMAT}}`.

**Click any row** to paste that syntax into the Message field at the
cursor position — no typing, no memorizing.

**Closing the modal:** click the row (which pastes and closes), press
**Escape**, or click outside the modal card.

### Keyboard Shortcuts

| Shortcut       | Action                          |
|----------------|---------------------------------|
| `Ctrl+Enter`   | Send the current message        |
| `Escape`       | Close the syntax help modal     |

---

## Use Cases

- **Debug network services** — test API servers, databases, or custom daemons directly from VS Code
- **IoT & embedded** — send crafted binary packets to devices
- **Protocol exploration** — experiment with custom or undocumented protocols
- **Performance testing** — measure round-trip latency with built-in response timers

---

## License

MIT
