/**
 * Regression test for review finding B1 of `#task:510` PR-1.
 *
 * Background: `node:net.Socket.write()` returns `false` when the
 * internal buffer crosses `highWaterMark`. That's a backpressure
 * signal, not a write failure — the bytes are still queued and reach
 * the peer in order. The earlier PR-1 implementation propagated that
 * `false` up to `HostClient.call()`, which then deleted the pending
 * entry and rejected with `disconnected`; the daemon later responded
 * normally and the client treated the response as a duplicate to
 * drop, surfacing a phantom failure on a request that actually
 * succeeded.
 *
 * The fix: `SocketTransport.write()` ignores the Node return value
 * and always returns `true` when the socket is connected. This test
 * pins that behaviour by forcing a connected socket to report
 * `false` on the next write (via a low `writableHighWaterMark` + a
 * payload exceeding it) and asserts the transport still claims
 * success.
 *
 * Why no e2e involvement: this is a unit-level contract on
 * SocketTransport.write — the corresponding behaviour at the
 * HostClient layer (don't reject pending on backpressure) is
 * automatically preserved as long as `write` returns true.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Server, Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocketTransport } from '../src/client/socket-transport.js';

interface Fixture {
  dir: string;
  socketPath: string;
  server: Server;
  serverSocket?: Socket;
}

describe('SocketTransport — backpressure not treated as failure', () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    while (fixtures.length) {
      const f = fixtures.pop()!;
      f.serverSocket?.destroy();
      await new Promise<void>(resolve => f.server.close(() => resolve()));
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('returns true even when the underlying socket reports highWaterMark exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-host-bp-'));
    const socketPath = join(dir, 'bp.sock');
    const server = new Server(socket => {
      // Pause reading so writes from the client side accumulate in
      // both the kernel send buffer and the Node-side writable
      // buffer — this is what tips Socket.write() into returning
      // false. We never resume; the test only cares about the
      // single write call's return value.
      socket.pause();
      f.serverSocket = socket;
    });
    const f: Fixture = { dir, socketPath, server };
    fixtures.push(f);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    const transport = new SocketTransport({ socketPath });
    await transport.connect();
    // Push enough bytes to overflow a tiny in-process buffer. 256KB
    // is well past Node's default 16KB highWaterMark and several
    // multiples past anything the kernel will absorb instantly
    // without the peer reading.
    const big = 'x'.repeat(256 * 1024) + '\n';
    const ok = transport.write(big);
    expect(ok).toBe(true);
    transport.close();
  });

  it('returns false only when the transport is not connected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-host-bp2-'));
    const socketPath = join(dir, 'bp.sock');
    const server = new Server(socket => {
      f.serverSocket = socket;
    });
    const f: Fixture = { dir, socketPath, server };
    fixtures.push(f);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    const transport = new SocketTransport({ socketPath });
    await transport.connect();
    expect(transport.write('hi\n')).toBe(true);
    transport.close();
    expect(transport.write('hi\n')).toBe(false);
  });
});
