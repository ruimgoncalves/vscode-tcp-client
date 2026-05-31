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

## License

MIT
