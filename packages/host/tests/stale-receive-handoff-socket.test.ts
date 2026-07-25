/**
 * #task:1614 round-3 socket falsifier — the response-handoff proof
 * point over a REAL Unix socket.
 *
 * Pins the predicate `handoff(err == null)` in `DaemonServer.handleLine`:
 * a peer that reads the response frame and closes IMMEDIATELY must
 * still settle the handoff as PROVEN. A `socket.destroyed` term in the
 * predicate would flip this exact sequence into a pre-proof failure —
 * restoring (and later re-delivering) bodies the peer already has.
 * The inverse is pinned too: destroying the connection BEFORE the
 * response is written settles the handoff as failed (the write
 * callback errors), never as proven.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { DaemonServer } from '../src/daemon/server.js';
import { IntentDispatcher } from '../src/daemon/dispatcher.js';
import type { SupervisorContract } from '../src/daemon/supervisor-contract.js';
import { createDaemonLogControl } from '../src/daemon/logger.js';

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    logControl: createDaemonLogControl(),
  } as unknown as ConstructorParameters<typeof IntentDispatcher>[0]['logger'];
}

/** Stub supervisor: only `agentStaleReceive` matters — it registers the
 *  response handoff exactly like the real one and returns a valid
 *  batch_covered result. Everything else is unreachable in this test. */
function stubSupervisor(onHandoff: (ok: boolean) => void): SupervisorContract {
  const unreachable = () => {
    throw new Error('not used');
  };
  return {
    agentMessageSend: unreachable,
    agentStaleResolve: unreachable,
    agentStreamObserved: unreachable,
    agentStaleReceive: (_params, ctx) => {
      ctx.responseHandoff = onHandoff;
      return {
        ok: true,
        outcome: 'batch_covered',
        stale_event_id: 'stale-1',
        text: 'body',
        delivery_ids: [1],
        covered_seq_by_stream: [['main', 2]],
      };
    },
    start: unreachable,
    stop: unreachable,
    deliver: unreachable,
    cleanupDeferredForOwner: () => {},
    status: async () => ({ runtimes: [] }),
    clearSession: unreachable,
    stopAll: unreachable,
    closeActivityLog: unreachable,
    pauseOutput: unreachable,
    resumeOutput: unreachable,
  };
}

async function withServer(
  onHandoff: (ok: boolean) => void,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-handoff-'));
  const socketPath = join(dir, 'daemon.sock');
  const logger = silentLogger();
  const server = new DaemonServer({
    socketPath,
    dispatcher: new IntentDispatcher({
      logger,
      supervisor: stubSupervisor(onHandoff),
    }),
    logger: logger as never,
  });
  await server.start();
  try {
    await fn(socketPath);
  } finally {
    await server.stop('test_done').catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const REQUEST =
  JSON.stringify({
    id: 'req-1',
    intent: 'agent_stale_receive',
    params: { conversation_id: 'c1', agent_id: 'a1', wait_ms: 0 },
  }) + '\n';

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('#task:1614 — response-handoff proof point over a real socket', () => {
  it('peer reads the response frame then closes immediately → handoff settles PROVEN (true)', async () => {
    const handoffs: boolean[] = [];
    await withServer(ok => handoffs.push(ok), async socketPath => {
      const socket = createConnection(socketPath);
      socket.setEncoding('utf8');
      let buffer = '';
      let sawResponse = false;
      socket.on('data', chunk => {
        buffer += chunk;
        for (const line of buffer.split('\n')) {
          if (!line) continue;
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // First line is the connection's `ready` event; the response
          // frame carries our request id.
          if (parsed['id'] === 'req-1') {
            sawResponse = true;
            // The adversarial move: hard-close the moment the frame is
            // in hand, before the server's write callback has any
            // scheduling guarantee of having run.
            socket.destroy();
            return;
          }
        }
        buffer = buffer.endsWith('\n') ? '' : buffer.split('\n').at(-1)!;
      });
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(REQUEST);
      await waitFor(() => sawResponse && handoffs.length === 1);
      expect(handoffs).toEqual([true]);
    });
  });

  it('peer destroys the connection BEFORE the response is written → handoff settles failed (false), never proven', async () => {
    const handoffs: boolean[] = [];
    let sawResponse = false;
    await withServer(ok => handoffs.push(ok), async socketPath => {
      const socket = createConnection(socketPath);
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        if (String(chunk).includes('req-1')) sawResponse = true;
        // Kill the connection as soon as ANY bytes (the ready event)
        // arrive — the request below is written first, so the server
        // dispatches against an already-dying socket.
      });
      await new Promise<void>(resolve => socket.once('connect', resolve));
      // Write the request and destroy without waiting for the response:
      // the server's response write lands on a destroyed socket and the
      // write callback reports an error.
      socket.write(REQUEST);
      socket.destroy();
      await waitFor(() => handoffs.length === 1);
      expect(handoffs).toEqual([false]);
      expect(sawResponse).toBe(false);
    });
  });
});
