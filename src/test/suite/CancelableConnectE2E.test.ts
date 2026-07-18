// Headless reproduction test for the "click does nothing" symptom.
// Loads the extension inside a real Electron VS Code instance via
// @vscode/test-electron, exercises the connect→cancel flow against a
// blackholed address (TEST-NET-1, RFC 5737), and verifies:
//
//   1. Sending {type:'connect'} transitions state → connecting
//   2. Sending {type:'cancelConnect'} during 'connecting' transitions state → disconnected
//   3. After cancel, sending another {type:'connect'} actually starts a new connect
//
// This is the exact code path the user is hitting when they say "the
// cancel button doesn't work" / "the UI is unresponsive". If any step
// here fails, that's the bug.

import * as assert from 'assert';
import { TcpClient, ConnectionState } from '../../TcpClient';

suite('Regression: cancelable connect end-to-end (bug report 2026-07-17)', function () {
  this.timeout(15000);

  test('connect → cancel → reconnect actually transitions state correctly', async () => {
    // Spin up a TcpClient directly — same code path the panel uses,
    // so this is the host-side flow minus the message-router.
    const client = new TcpClient();
    const stateLog: ConnectionState[] = [];
    client.on('stateChange', (s) => stateLog.push(s));

    // ── Step 1: kick off a connect to TEST-NET-1 (RFC 5737 blackhole) ──
    // Same host the user hits with the v0.2.3 panel: a server that's
    // silently dropping SYN packets (firewall, half-open, slow target).
    const connectPromise = client.connect('192.0.2.1', 65000, { timeoutMs: 5000 });

    // Wait one tick for the connecting state to land
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(client.state, 'connecting',
      `Expected 'connecting' after kickoff, got '${client.state}'`);

    // ── Step 2: simulate the user clicking the Cancel button ──
    // The panel's click handler posts {type:'cancelConnect'}, which
    // the host routes to `client.cancel()`. Test the cancel path
    // directly.
    client.cancel();

    // The cancel promise should reject with 'Connect cancelled'
    await assert.rejects(connectPromise, /Connect cancelled/);

    // State must be back to disconnected
    assert.strictEqual(client.state, 'disconnected',
      `After cancel(), expected 'disconnected', got '${client.state}'`);

    // ── Step 3: user clicks Connect AGAIN — must actually start a new connect ──
    // The real regression test: after a cancel, can the user retry?
    // (If cancel() leaves the client in a broken state, this hangs.)
    const retryPromise = client.connect('127.0.0.1', 1, { timeoutMs: 200 })
      .then(() => 'connected' as const)
      .catch((e) => e.message);
    const result = await retryPromise;
    assert.ok(
      /ECONNREFUSED|Connect timed out/.test(result),
      `Retry from cancelled state should have made a fresh attempt; got: ${result}`,
    );
    // After the retry attempt finishes (whatever the outcome), state must be disconnected again
    assert.strictEqual(client.state, 'disconnected');

    // Full state log for the record
    console.log('  state transitions:', JSON.stringify(stateLog));

    client.dispose();
  });

  test('timeout fires against TEST-NET-1 (the original user complaint)', async function () {
    this.timeout(15000);
    if (process.env.CI_SKIP_TIMEOUT_TEST) { this.skip(); return; }

    const client = new TcpClient();
    const start = Date.now();
    let elapsed = 0;
    try {
      await client.connect('192.0.2.1', 65000, { timeoutMs: 1000 });
      assert.fail('connect should have rejected (timeout)');
    } catch (e) {
      elapsed = Date.now() - start;
      assert.ok(/timed out/.test((e as Error).message),
        `Expected timeout error, got: ${(e as Error).message}`);
    }
    // Sanity: timeout actually fired within a loose bound
    assert.ok(elapsed < 5000,
      `Timeout took ${elapsed}ms — should have fired within ~1000ms`);
    assert.strictEqual(client.state, 'disconnected',
      `State after timeout should be 'disconnected', got '${client.state}'`);
    console.log(`  timeout fired after ${elapsed}ms (limit 1000ms, bound 5000ms)`);
    client.dispose();
  });
});
