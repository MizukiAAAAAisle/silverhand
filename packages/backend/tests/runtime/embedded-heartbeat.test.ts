/**
 * #task:1588 slice 2 — embedded local-transport heartbeat gates (Cindy's
 * acceptance list, transport-scoped):
 *
 *   - timeout disconnects: a daemon that never pongs is torn down
 *     through the ordinary disconnect flow (onDisconnect + reconnect);
 *   - a normally-ponging daemon is never falsely disconnected;
 *   - timer cleanup: close() stops all heartbeat traffic;
 *   - generation isolation: a stray pong with no armed deadline is a
 *     benign no-op on the live connection.
 *
 * Real Unix sockets + short cadences (no fake timers — the adapter uses
 * real `net.Socket`s, so we shrink pingIntervalMs/pongTimeoutMs instead).
 */
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { splitNdjson, encodeOutboundFrame } from '@silverhand/host';
import { EmbeddedUnixOutboundFrameAdapter } from '../../src/runtime/embedded-unix-outbound-frame-adapter.js';

const PING_INTERVAL_MS = 60;
const PONG_TIMEOUT_MS = 50;

let socketSeq = 0;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

interface Peer {
  socket: Socket;
  frames: unknown[];
  write: (frame: unknown) => void;
}

async function makeFixture(opts?: { respondPong?: boolean }) {
  const socketPath = join(tmpdir(), `sh-hb-${process.pid}-${++socketSeq}.sock`);
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const peers: Peer[] = [];
  const server: NetServer = createServer(sock => {
    let buffer = '';
    const peer: Peer = {
      socket: sock,
      frames: [],
      write: frame => {
        sock.write(`${encodeOutboundFrame(frame as never)}\n`);
      },
    };
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      const { frames, leftover } = splitNdjson(buffer, String(chunk));
      buffer = leftover;
      for (const line of frames) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        peer.frames.push(parsed);
        if (
          opts?.respondPong &&
          parsed['type'] === 'heartbeat' &&
          parsed['kind'] === 'ping'
        ) {
          peer.write({
            direction: 'daemon_to_server',
            type: 'heartbeat',
            kind: 'pong',
            ts: Date.now(),
            echo_ts: parsed['ts'],
          });
        }
      }
    });
    peers.push(peer);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const disconnects: string[] = [];
  const adapter = new EmbeddedUnixOutboundFrameAdapter({
    socketPath,
    hostId: 'local',
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: PONG_TIMEOUT_MS,
    onDisconnect: (_hostId, connectionId) => {
      disconnects.push(connectionId);
    },
  });

  cleanups.push(async () => {
    await adapter.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  return { adapter, peers, disconnects };
}

const pingsOf = (peer: Peer) =>
  peer.frames.filter(
    f =>
      (f as Record<string, unknown>)['type'] === 'heartbeat' &&
      (f as Record<string, unknown>)['kind'] === 'ping',
  );

describe('embedded local transport heartbeat', () => {
  it('a daemon that never pongs is disconnected via heartbeat timeout and reconnects as a NEW generation', async () => {
    const { adapter, peers, disconnects } = await makeFixture({
      respondPong: false,
    });
    await adapter.connect();
    const firstConnectionId = adapter.connectionIdForHost('local');
    expect(firstConnectionId).not.toBeNull();

    // First ping goes out, no pong comes back → timeout disconnect.
    await waitFor(() => disconnects.length >= 1);
    expect(disconnects[0]).toBe(firstConnectionId);

    // The ordinary reconnect flow takes over and mints a NEW generation.
    await waitFor(
      () =>
        adapter.connectionIdForHost('local') !== null &&
        adapter.connectionIdForHost('local') !== firstConnectionId,
    );
    expect(peers.length).toBeGreaterThanOrEqual(2);
  });

  it('a normally-ponging daemon is never falsely disconnected', async () => {
    const { adapter, peers, disconnects } = await makeFixture({
      respondPong: true,
    });
    await adapter.connect();
    const connectionId = adapter.connectionIdForHost('local');

    // Ride out several full ping cycles.
    await waitFor(() => pingsOf(peers[0]!).length >= 3);
    expect(disconnects).toHaveLength(0);
    expect(adapter.connectionIdForHost('local')).toBe(connectionId);
  });

  it('close() stops all heartbeat traffic (timer cleanup)', async () => {
    const { adapter, peers } = await makeFixture({ respondPong: true });
    await adapter.connect();
    await waitFor(() => pingsOf(peers[0]!).length >= 1);

    await adapter.close();
    const pingsAtClose = pingsOf(peers[0]!).length;
    await sleep(PING_INTERVAL_MS * 3);
    expect(pingsOf(peers[0]!).length).toBe(pingsAtClose);
  });

  it('a stray pong with no armed deadline is a benign no-op', async () => {
    const { adapter, peers, disconnects } = await makeFixture({
      respondPong: true,
    });
    await adapter.connect();
    const connectionId = adapter.connectionIdForHost('local');

    // Unsolicited pong before any ping deadline is armed.
    peers[0]!.write({
      direction: 'daemon_to_server',
      type: 'heartbeat',
      kind: 'pong',
      ts: Date.now(),
      echo_ts: 1,
    });
    await sleep(PING_INTERVAL_MS * 2);
    expect(disconnects).toHaveLength(0);
    expect(adapter.connectionIdForHost('local')).toBe(connectionId);
  });

  it('P1-3: a replaced generation\'s late pong/close/error callbacks cannot touch the successor connection', async () => {
    const { adapter, peers, disconnects } = await makeFixture({
      respondPong: true,
    });
    await adapter.connect();
    const genA = adapter.connectionIdForHost('local');
    // Reach the adapter's private socket to replay stale Node callbacks
    // deterministically — the exact queued-event race Cindy described
    // cannot be produced on demand through real socket timing.
    const internals = adapter as unknown as {
      socket: import('node:net').Socket;
    };
    const socketA = internals.socket;

    // Tear down generation A from the daemon side; the adapter
    // reconnects and mints generation B.
    peers[0]!.socket.destroy();
    await waitFor(
      () =>
        adapter.connectionIdForHost('local') !== null &&
        adapter.connectionIdForHost('local') !== genA,
    );
    const genB = adapter.connectionIdForHost('local');
    expect(disconnects).toEqual([genA]);

    // Stale generation-A callbacks arrive late: a pong (must not clear
    // B's heartbeat deadline), a close, and an error (must not tear B
    // down or double-fire onDisconnect).
    socketA.emit(
      'data',
      `${JSON.stringify({
        direction: 'daemon_to_server',
        type: 'heartbeat',
        kind: 'pong',
        ts: Date.now(),
        echo_ts: 1,
      })}\n`,
    );
    socketA.emit('close');
    socketA.emit('error', new Error('stale generation error'));

    // Generation B survives: same connectionId, no extra disconnects,
    // and its own heartbeat keeps running (pings observed on peer B).
    await waitFor(() => peers.length >= 2 && pingsOf(peers[1]!).length >= 1);
    expect(adapter.connectionIdForHost('local')).toBe(genB);
    expect(disconnects).toEqual([genA]);
  });

  it('answers a daemon-initiated ping with a pong (WSS parity)', async () => {
    const { adapter, peers } = await makeFixture({ respondPong: true });
    await adapter.connect();

    peers[0]!.write({
      direction: 'daemon_to_server',
      type: 'heartbeat',
      kind: 'ping',
      ts: 1234,
    });
    await waitFor(() =>
      peers[0]!.frames.some(
        f =>
          (f as Record<string, unknown>)['kind'] === 'pong' &&
          (f as Record<string, unknown>)['echo_ts'] === 1234,
      ),
    );
    void adapter;
  });
});
