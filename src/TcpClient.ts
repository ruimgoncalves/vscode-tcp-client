import * as net from 'net';
import { EventEmitter } from 'events';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

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
  private _state: ConnectionState = 'disconnected';

  get state(): ConnectionState { return this._state; }

  private _setState(state: ConnectionState): void {
    this._state = state;
    this.emit('stateChange', state);
  }

  /** Opens a TCP connection. Rejects if already connected/connecting. */
  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._state !== 'disconnected') {
        reject(new Error('Already connected or connecting'));
        return;
      }

      this._setState('connecting');
      const socket = new net.Socket();

      const onConnect = () => {
        cleanup();
        this._socket = socket;
        this._setState('connected');

        socket.on('data', (chunk: Buffer) => this.emit('data', chunk));
        socket.once('close', () => {
          this._socket = null;
          if (this._state !== 'disconnected') { this._setState('disconnected'); }
        });
        socket.on('error', (err: Error) => this.emit('error', err));
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        socket.destroy();
        this._socket = null;
        this._setState('disconnected');
        reject(err);
      };

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.connect(port, host);
    });
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
    if (this._state !== 'disconnected') { this._setState('disconnected'); }
  }

  /** Disconnect and remove all listeners. */
  dispose(): void {
    this.disconnect();
    this.removeAllListeners();
  }
}
