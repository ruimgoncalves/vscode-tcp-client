import * as net from 'net';
import { EventEmitter } from 'events';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Options for {@link TcpClient.connect}. */
export interface ConnectOptions {
  /**
   * Maximum time (in ms) to wait for the underlying socket to establish a
   * connection. If the connection does not complete within this window,
   * the connect promise rejects with `Connect timed out after Xms` and the
   * state transitions back to `disconnected`. Set to `0` to disable the
   * timeout entirely.
   *
   * When omitted, the value is read from the VS Code setting
   * `tcpClient.connection.timeoutMs` (default 10000). Passing an explicit
   * value here — including `0` — overrides the setting.
   */
  timeoutMs?: number;
}

/**
 * Thin wrapper around a Node.js TCP socket that exposes a promise-based
 * connect API and emits typed events.
 *
 * Events:
 *   stateChange(state: ConnectionState)
 *   data(chunk: Buffer)
 *   error(err: Error)
 */
export class TcpClient extends EventEmitter {
  private _socket: net.Socket | null = null;
  // The socket currently in the `connecting` state, before it has been
  // promoted to `_socket` on successful connect. Used by `cancel()` to
  // find the in-flight socket without mutating the public `_socket`
  // contract (which remains null until the connection is established).
  private _pendingSocket: net.Socket | null = null;
  private _state: ConnectionState = 'disconnected';

  get state(): ConnectionState { return this._state; }

  private _setState(state: ConnectionState): void {
    this._state = state;
    this.emit('stateChange', state);
  }

  /** Opens a TCP connection. Rejects if already connected/connecting. */
  connect(host: string, port: number, opts?: ConnectOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._state !== 'disconnected') {
        reject(new Error('Already connected or connecting'));
        return;
      }

      // Resolve effective timeout. Caller-provided `opts.timeoutMs`
      // (including `0` = disabled) wins over the setting default. We
      // only consult the setting when `opts.timeoutMs` is undefined.
      let effectiveTimeoutMs: number;
      if (opts && opts.timeoutMs !== undefined) {
        effectiveTimeoutMs = opts.timeoutMs;
      } else {
        // Lazy-require vscode so this module remains usable outside the
        // extension host (e.g. plain Node tests). When the vscode module
        // is not available we fall back to the hard-coded default.
        let fromSetting = 10000;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const vscodeMod = require('vscode') as
            | typeof import('vscode')
            | undefined;
          if (vscodeMod && vscodeMod.workspace) {
            const v: unknown = vscodeMod.workspace
              .getConfiguration('tcpClient.connection')
              .get('timeoutMs', 10000);
            if (typeof v === 'number') { fromSetting = v; }
          }
        } catch {
          // No vscode module available — keep the hard-coded default.
        }
        effectiveTimeoutMs = fromSetting;
      }

      this._setState('connecting');
      const socket = new net.Socket();
      // Track the in-flight socket on the instance so `cancel()` can
      // find it without having to wait for `onConnect` to assign it to
      // `this._socket`. (Until connect succeeds, `this._socket` is
      // intentionally null — the existing read-only contract.)
      this._pendingSocket = socket;
      let timeoutHandle: NodeJS.Timeout | null = null;
      // Track whether one of our internal paths (connect/error/timeout/
      // cancel) has already settled the promise, so we never resolve +
      // reject or double-reject.
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) { return; }
        settled = true;
        fn();
      };

      const onConnect = () => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        cleanup();
        this._pendingSocket = null;
        this._socket = socket;
        this._setState('connected');

        socket.on('data', (chunk: Buffer) => this.emit('data', chunk));
        socket.once('close', () => {
          this._socket = null;
          if (this._state !== 'disconnected') { this._setState('disconnected'); }
        });
        socket.on('error', (err: Error) => this.emit('error', err));
        settle(resolve);
      };

      const onError = (err: Error) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        cleanup();
        socket.destroy();
        this._pendingSocket = null;
        this._socket = null;
        this._setState('disconnected');
        settle(() => reject(err));
      };

      const onTimeout = () => {
        // Defensive: if the socket already connected/errored/cancelled,
        // do nothing.
        if (this._state !== 'connecting') { return; }
        timeoutHandle = null;
        cleanup();
        socket.destroy();
        this._pendingSocket = null;
        this._socket = null;
        this._setState('disconnected');
        settle(() => reject(new Error(`Connect timed out after ${effectiveTimeoutMs}ms`)));
      };

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };

      // Public-ish escape hatch so `cancel(reason)` can drive its own
      // teardown without re-implementing the connect-failure path.
      // Stashed on the socket so it lives alongside the other handlers
      // and is automatically garbage-collected when the socket is.
      const doCancel = (reason: string) => {
        if (this._state !== 'connecting') { return false; }
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        cleanup();
        socket.destroy();
        this._pendingSocket = null;
        this._socket = null;
        this._setState('disconnected');
        settle(() => reject(new Error(reason)));
        return true;
      };
      (socket as unknown as { __tcpCancel?: (reason: string) => boolean }).__tcpCancel = doCancel;

      // Arm the connect timeout only when the user hasn't explicitly
      // disabled it (0 = no timeout).
      if (effectiveTimeoutMs > 0) {
        timeoutHandle = setTimeout(onTimeout, effectiveTimeoutMs);
      }

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.connect(port, host);
    });
  }

  /**
   * Cancels an in-flight connect. If the client is currently
   * `connecting`, the pending socket is destroyed and the connect
   * promise rejects with the supplied reason (default
   * `"Connect cancelled"`). Calling on a disconnected or
   * already-connected client is a no-op.
   */
  cancel(reason: string = 'Connect cancelled'): void {
    if (this._state !== 'connecting') { return; }
    const pending = this._pendingSocket;
    if (!pending) { return; }
    const stash = pending as unknown as { __tcpCancel?: (reason: string) => boolean };
    if (typeof stash.__tcpCancel === 'function') {
      stash.__tcpCancel(reason);
    }
  }

  /** Writes raw bytes to the socket. Throws if not connected. */
  send(data: Buffer): void {
    if (!this._socket || this._state !== 'connected') {
      throw new Error('Not connected');
    }
    this._socket.write(data);
  }

  /** Closes the socket immediately. Safe to call multiple times. */
  disconnect(): void {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    if (this._pendingSocket) {
      this._pendingSocket.destroy();
      this._pendingSocket = null;
    }
    if (this._state !== 'disconnected') { this._setState('disconnected'); }
  }

  /** Disconnect and remove all listeners. */
  dispose(): void {
    this.disconnect();
    this.removeAllListeners();
  }
}
