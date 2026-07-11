# TCP Client for VS Code

Talk to any TCP server from inside VS Code. Send text or binary, frame with HL7 or custom envelopes, interpolate variables.

![TCP Client in action](https://github.com/ruimgoncalves/vscode-tcp-client/raw/main/screenshot.png)

## Quick Start

1. Open the Command Palette → **TCP Client: Open Panel**
2. Enter `host:port` and click **Connect**
3. Pick an **Envelope** (default: *None / raw*)
4. Type your message — use escape sequences for binary, `{{name}}` for variables
5. Press **Send** or `Ctrl+Enter`. Click the yellow **?** for syntax help.

Connection state is shown by a status dot (grey / amber / green). Every response is logged with a timestamp and round-trip time in ms. Form state survives panel close and VS Code restarts.

## Message Syntax

### Escape sequences

| Sequence | Meaning |
|---|---|
| `\xHH` | Raw byte (e.g. `\xFF`) |
| `\n`   | Newline (0x0A) |
| `\r`   | Carriage return (0x0D) |
| `\t`   | Tab (0x09) |
| `\\`   | Literal backslash |
| `\0`   | Null byte (0x00) |
| `\{`   | Literal `{` |
| `\}`   | Literal `}` |

Use `\{` and `\}` to send literal `{{name}}` in a message.

### Variables

Reference `{{name}}` in the message area. The text is resolved before encoding and framing.

| Variable | Value |
|---|---|
| `{{timestamp}}` | Current UTC time, default format from settings |
| `{{timestamp|FORMAT}}` | Same, with FORMAT applied (`YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `sss`, `Z`, `X` = epoch seconds, `x` = epoch ms) |
| `{{seq}}` | Per-session counter, starts at 1 |
| `{{uuid}}` | Fresh RFC 4122 v4 UUID |

Add your own in the Variables section (or directly in `settings.json`):

```json
{
  "tcpClient.variables.custom": [
    { "name": "user.name", "value": "ryu" },
    { "name": "session.id", "value": "abc-123" }
  ],
  "tcpClient.variables.timestampFormat": "YYYY-MM-DDTHH:mm:ss.sssZ"
}
```

Unknown `{{name}}` references are left in the output and a warning is logged to the developer console — the send is not blocked. The pipe in `{{name|anything}}` is silently ignored for `seq`, `uuid`, and user variables.

## Envelopes

An envelope wraps your message with prefix/suffix bytes before it's written to the socket — useful for HL7 v2 / MLLP, NRPE-style line framing, and any protocol with a well-known start/end marker.

Pick one from the dropdown, or define your own:

```json
{
  "tcpClient.envelopes.custom": [
    {
      "id": "stx-etx",
      "label": "STX/ETX framed",
      "prefix": "\\x02",
      "suffix": "\\x03"
    },
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

Fields:
- `id` *(required)* — unique identifier
- `label` *(required)* — shown in the dropdown
- `prefix` / `suffix` — bytes prepended / appended (escape-sequence string)
- `linePrefix` / `lineSuffix` — wrap each `\n`-separated line of the payload (for protocols that frame every line). Default empty — leave both empty for single-wrap behaviour.

When you select a custom envelope in the panel, its `prefix`, `suffix`, `linePrefix`, and `lineSuffix` are exposed as inline fields so you can tweak them without editing `settings.json`.

## Settings

All settings live under `tcpClient.*` in `settings.json`:

| Key | Default | Purpose |
|---|---|---|
| `tcpClient.variables.custom` | `[]` | Array of `{name, value}` user-defined variables |
| `tcpClient.variables.timestampFormat` | `YYYY-MM-DDTHH:mm:ss.sssZ` | Default format for `{{timestamp}}` |
| `tcpClient.envelopes.custom` | — | Array of envelope definitions |

## Keyboard

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Send the current message |
| `Escape` | Close the syntax help modal |

## License

MIT
