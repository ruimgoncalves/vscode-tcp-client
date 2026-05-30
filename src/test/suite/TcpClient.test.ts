import * as assert from 'assert';
import * as net from 'net';
import { TcpClient } from '../../TcpClient';

/** Creates a temporary TCP server, resolves with { server, port } */
function createTestServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

suite('TcpClient', function () {
  // Allow up to 5 s per test (network operations can be slow on CI)
  this.timeout(5000);

  let testServer: net.Server;
  let testPort: number;

  setup(async () => {
    const result = await createTestServer();
    testServer = result.server;
    testPort   = result.port;
  });

  teardown((done) => testServer.close(done));

  // ------------------------------------------------------------------

  test('initial state is disconnected', () => {
    const c = new TcpClient();
    assert.strictEqual(c.state, 'disconnected');
    c.dispose();
  });

  test('connects successfully', async () => {
    const c = new TcpClient();
    await c.connect('127.0.0.1', testPort);
    assert.strictEqual(c.state, 'connected');
    c.dispose();
  });

  test('emits stateChange: connecting → connected', async () => {
    const states: string[] = [];
    const c = new TcpClient();
    c.on('stateChange', (s) => states.push(s));
    await c.connect('127.0.0.1', testPort);
    assert.ok(states.includes('connecting'));
    assert.ok(states.includes('connected'));
    c.dispose();
  });

  test('emits stateChange: disconnected after dispose', async () => {
    const states: string[] = [];
    const c = new TcpClient();
    c.on('stateChange', (s) => states.push(s));
    await c.connect('127.0.0.1', testPort);
    c.dispose();
    assert.strictEqual(states[states.length - 1], 'disconnected');
  });

  test('sends data and receives echo', (done) => {
    testServer.once('connection', (sock) => {
      sock.on('data', (d) => sock.write(d)); // echo server
    });
    const c = new TcpClient();
    c.connect('127.0.0.1', testPort).then(() => {
      c.once('data', (chunk: Buffer) => {
        assert.strictEqual(chunk.toString(), 'ping');
        c.dispose();
        done();
      });
      c.send(Buffer.from('ping'));
    });
  });

  test('receives binary data intact', (done) => {
    const payload = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01]);
    testServer.once('connection', (sock) => {
      sock.on('data', () => sock.write(payload));
    });
    const c = new TcpClient();
    c.connect('127.0.0.1', testPort).then(() => {
      c.once('data', (chunk: Buffer) => {
        assert.deepStrictEqual([...chunk], [...payload]);
        c.dispose();
        done();
      });
      c.send(Buffer.from('go'));
    });
  });

  test('rejects on connection refused', async () => {
    // Spin up and immediately close a server to get a free port
    const { server, port } = await createTestServer();
    await new Promise<void>((r) => server.close(() => r()));

    const c = new TcpClient();
    await assert.rejects(
      () => c.connect('127.0.0.1', port),
      (err: Error) => /ECONNREFUSED|EADDRNOTAVAIL/.test(err.message)
    );
    assert.strictEqual(c.state, 'disconnected');
    c.dispose();
  });

  test('throws when sending while disconnected', () => {
    const c = new TcpClient();
    assert.throws(() => c.send(Buffer.from('x')), /Not connected/);
    c.dispose();
  });

  test('disconnect transitions state to disconnected', async () => {
    const c = new TcpClient();
    await c.connect('127.0.0.1', testPort);
    c.disconnect();
    assert.strictEqual(c.state, 'disconnected');
    c.dispose();
  });

  test('cannot connect while already connected', async () => {
    const c = new TcpClient();
    await c.connect('127.0.0.1', testPort);
    await assert.rejects(
      () => c.connect('127.0.0.1', testPort),
      /Already connected/
    );
    c.dispose();
  });
});
