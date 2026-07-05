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

The `wrap()` function intentionally only adds `prefix` + `suffix`; it does
not transform the payload. If you need to insert separators or otherwise
mutate the user-typed text, do it in the webview or as a separate layer
before `wrap()` runs.

### Custom envelopes

Custom envelopes are read from `vscode.workspace.getConfiguration('tcpClient')
.get('envelopes.custom')` at panel creation time, plus on every
`getEnvelopes` request from the webview. The schema is declared in
`package.json` under `contributes.configuration` and is therefore editable
via VS Code's Settings UI as well as `settings.json`. Adding a new custom
envelope requires no code changes.

---

## License

MIT
