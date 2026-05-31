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

**📋 Timestamped response log**
Every response is logged with a precise timestamp and round-trip response time in milliseconds.

**💾 Persistent state**
Server address, encoding, and draft message survive panel close/reopen and VS Code restarts.

---

## How to Use

1. Open the Command Palette → **TCP Client: Open Panel**
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

- **Debug network services** — test API servers, databases, or custom daemons directly from VS Code
- **IoT & embedded** — send crafted binary packets to devices
- **Protocol exploration** — experiment with custom or undocumented protocols
- **Performance testing** — measure round-trip latency with built-in response timers

---

## License

MIT
