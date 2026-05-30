# TCP Client — VS Code Extension

Send and receive raw TCP messages from a VS Code panel, with escape-sequence support for binary data.

## Features

- **Connect / disconnect** to any `host:port` TCP server
- **Connection state** shown on the button (grey → orange → green/red)
- **Response time** displayed for each received message
- **Text encoding** selector: UTF-8, ASCII, Latin-1, UTF-16 LE
- **Escape sequences** in the message textarea:
  | Sequence | Meaning |
  |----------|---------|
  | `\xHH`   | Raw byte `0xHH` (e.g. `\xFF`) |
  | `\n`     | Newline (0x0A) |
  | `\r`     | Carriage return (0x0D) |
  | `\t`     | Tab (0x09) |
  | `\\`     | Literal backslash |
  | `\0`     | Null byte (0x00) |
- **Persistent state** – server address, encoding and draft message survive panel hide/show
- **Ctrl+Enter** to send

## Install

### From source (development)

```bash
cd vscode-tcp-client
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host
```

### Build a .vsix package

```bash
npm install
npm run package        # produces vscode-tcp-client-0.1.0.vsix
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX…**

## Usage

1. Open the panel: **Command Palette → TCP Client: Open Panel**
2. Enter `host:port` (default `localhost:9000`)
3. Click **Connect**
4. Type a message (use escape sequences for binary data), press **Send** or Ctrl+Enter
5. Responses appear in the log with timestamps and response times

## Running Tests

```bash
npm test
```

Tests cover `MessageEncoder` (unit) and `TcpClient` (integration with a loopback server).

## Project Layout

```
src/
  extension.ts          Entry point
  TcpPanel.ts           WebviewPanel + HTML/CSS/JS
  TcpClient.ts          TCP socket wrapper (Node net module)
  MessageEncoder.ts     Escape-sequence parser & byte formatter
  test/
    runTest.ts          VS Code test runner launcher
    suite/
      index.ts          Mocha suite loader
      MessageEncoder.test.ts
      TcpClient.test.ts
      extension.test.ts
```
