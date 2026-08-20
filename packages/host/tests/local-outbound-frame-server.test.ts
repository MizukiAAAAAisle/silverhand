import { Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  encodeOutboundFrame,
  type OutboundServerToDaemonCommandFrame,
} from '../src/outbound-protocol.js';
import {
  splitNdjson,
  HOST_PROTOCOL_VERSION,
  type EventFrame,
} from '../src/protocol.js';
import {
  LocalOutboundFrameServer,
  deriveLocalOutboundFrameSocketPath,
} from '../src/daemon/local-outbound-frame-server.js';
import {
  createDaemonLogControl,
  type DaemonLogger,
} from '../src/daemon/logger.js';
import type { OutboundDispatcherResponse } from '../src/daemon/outbound-frame-mapping.js';

/**
 * D5.a-2 — host-side unit test for {@link LocalOutboundFrameServer}.
 *
 * This is the daemon end of the embedded formal path. It asserts the RAW
 * wire bytes (NDJSON outbound frames) the server reads and writes, and —
 * critically — that per-command error scoping survives the daemon side:
 * the same "foreign typed code on the wrong command" failure mode the
 * shared adapter contract pins on the BACKEND parser must ALSO be caught
 * here on the daemon, so neither end can leak a widened error union.
 *
 * The backend↔server end-to-end join (real adapter ↔ real server) is
 * D5.a-4; this file isolates the server.
 */

let socketSeq = 0;

class CapturingDaemonLogger implements DaemonLogger {
  readonly entries: Array<
    Record<string, unknown> & { level: string; msg?: string }
  > = [];
  readonly filePath = '/tmp/silverhand-local-outbound-server-test.log';
  readonly logControl = createDaemonLogControl('debug');

  debug(obj: unknown, msg?: string): void {
    this.push('debug', obj, msg);
  }
  info(obj: unknown, msg?: string): void {
    this.push('info', obj, msg);
  }
  warn(obj: unknown, msg?: string): void {
    this.push('warn', obj, msg);
  }
  error(obj: unknown, msg?: string): void {
    this.push('error', obj, msg);
  }
  async close(): Promise<void> {
    /* no-op */
  }

  private push(level: string, obj: unknown, msg?: string): void {
    const fields =
      obj && typeof obj === 'object' && !(obj instanceof Error)
        ? (obj as Record<string, unknown>)
        : { data: obj };
    this.entries.push({ level, msg, ...fields });
  }
}

type Dispatch = (
  command: OutboundServerToDaemonCommandFrame,
) => Promise<OutboundDispatcherResponse>;

interface Harness {
  server: LocalOutboundFrameServer;
  logger: CapturingDaemonLogger;
  client: RawClient;
  socketPath: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function makeHarness(
  dispatch: Dispatch,
  opts?: {
    writeBuffer?: { maxFrames?: number; maxBytes?: number };
    readyEvent?: () => Extract<EventFrame, { event: 'ready' }>;
    cleanupDeferredForOwner?: (owner: string) => void;
  },
): Promise<Harness> {
  const socketPath = join(tmpdir(), `sh-d5a-server-${process.pid}-${++socketSeq}.sock`);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const logger = new CapturingDaemonLogger();
  const server = new LocalOutboundFrameServer({
    socketPath,
    dispatchCommand: dispatch,
    logger,
    cleanupDeferredForOwner: opts?.cleanupDeferredForOwner ?? (() => {}),
    writeBuffer: opts?.writeBuffer,
    ...(opts?.readyEvent ? { readyEvent: opts.readyEvent } : {}),
  });
  await server.start();
  const client = await RawClient.connect(socketPath);
  cleanups.push(async () => {
    client.destroy();
    await server.stop();
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
      /* best-effort */
    }
  });
  return { server, logger, client, socketPath };
}

/** Raw NDJSON Unix-socket client — bypasses any adapter so the test sees
 *  exactly the bytes the server emits. */
class RawClient {
  private buffer = '';
  private readonly frames: unknown[] = [];
  private waiter: ((frame: unknown) => void) | null = null;
  closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { frames, leftover } = splitNdjson(this.buffer, text);
      this.buffer = leftover;
      for (const line of frames) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (this.waiter) {
          const resolve = this.waiter;
          this.waiter = null;
          resolve(parsed);
        } else {
          this.frames.push(parsed);
        }
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      /* swallow — close handler records teardown */
    });
  }

  static connect(socketPath: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const onError = (err: Error): void => {
        socket.off('connect', onConnect);
        reject(err);
      };
      const onConnect = (): void => {
        socket.off('error', onError);
        resolve(new RawClient(socket));
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
      socket.connect(socketPath);
    });
  }

  /** Send a pre-built object as a raw NDJSON line (no schema gate). */
  sendRaw(obj: unknown): void {
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }

  /** Send several objects as ONE NDJSON write (one chunk, multiple lines). */
  sendRawBatch(objs: unknown[]): void {
    this.socket.write(objs.map(o => `${JSON.stringify(o)}\n`).join(''));
  }

  /** Send a well-formed command via the real outbound encoder. */
  sendCommand(frame: OutboundServerToDaemonCommandFrame): void {
    this.socket.write(`${encodeOutboundFrame(frame)}\n`);
  }

  nextFrame(timeoutMs = 500): Promise<unknown> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('no frame received in time'));
      }, timeoutMs);
      timer.unref?.();
      this.waiter = frame => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  waitForClose(timeoutMs = 500): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close in time')), timeoutMs);
      timer.unref?.();
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

function runtimeStatusCommand(id: string): OutboundServerToDaemonCommandFrame {
  return {
    direction: 'server_to_daemon',
    type: 'command',
    id,
    kind: 'runtime_status',
    params: { conversation_id: 'c1', agent_id: 'a1' },
  } as OutboundServerToDaemonCommandFrame;
}

function agentMaterializeCommand(id: string): OutboundServerToDaemonCommandFrame {
  return {
    direction: 'server_to_daemon',
    type: 'command',
    id,
    kind: 'agent_materialize',
    params: {
      agent_id: 'a-new',
      agent_home_workspace_id: 'wsah_a-new',
      name: 'new-agent',
      runtime: 'claude',
      template_choice: 'default',
    },
  } as OutboundServerToDaemonCommandFrame;
}

describe('deriveLocalOutboundFrameSocketPath', () => {
  it('derives ~/.silverhand/run/daemon-outbound.sock from a home dir', () => {
    expect(deriveLocalOutboundFrameSocketPath('/home/x')).toBe(
      '/home/x/.silverhand/run/daemon-outbound.sock',
    );
  });
});

describe('LocalOutboundFrameServer', () => {
  it('round-trips a runtime_status command as raw outbound frame bytes', async () => {
    const { client } = await makeHarness(async command => ({
      id: command.id,
      result: {
        runtimes: [
          {
            runtime_scope: {
              kind: 'conversation',
              conversation_id: 'c1',
              agent_id: 'a1',
            },
            conversation_id: 'c1',
            agent_id: 'a1',
            runtime_generation: 1,
            pid: null,
            phase: 'idle',
            run_state: null,
            started_at: null,
          },
        ],
      },
    }));

    client.sendCommand(runtimeStatusCommand('cmd-1'));
    const raw = await client.nextFrame();

    // The bytes on the wire are a valid outbound command-response frame.
    const parsed = OutboundDaemonToServerCommandResponseFrameSchema.parse(raw);
    expect(parsed).toMatchObject({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-1',
      kind: 'runtime_status',
    });
    expect('result' in parsed && parsed.result).toMatchObject({
      runtimes: [{ agent_id: 'a1' }],
    });
  });

  it('passes an agent_materialize typed wire error through with its code intact', async () => {
    const { client } = await makeHarness(async command => ({
      id: command.id,
      error: {
        code: 'agent_dir_collision',
        message: 'agent home already exists',
      },
    }));

    client.sendCommand(agentMaterializeCommand('cmd-2'));
    const raw = await client.nextFrame();

    const parsed = OutboundDaemonToServerCommandResponseFrameSchema.parse(raw);
    expect('error' in parsed && parsed.error).toMatchObject({
      code: 'agent_dir_collision',
    });
  });

  it('collapses a foreign typed code on runtime_status to internal_error (per-command scoping)', async () => {
    // The dispatcher mistakenly returns an agent_materialize-scoped code on
    // a runtime_status response. `runtime_status` declares only the 5
    // generic codes, so the per-command response schema rejects the frame
    // and the mapper collapses it to internal_error BEFORE bytes leave —
    // the foreign code never reaches the backend. This is the daemon-side
    // half of the shared contract's negative typed-error pin.
    const { client, logger } = await makeHarness(async command => ({
      id: command.id,
      error: {
        code: 'agent_dir_collision',
        message: 'foreign code must not survive on runtime_status',
      },
    }));

    client.sendCommand(runtimeStatusCommand('cmd-3'));
    const raw = await client.nextFrame();

    const parsed = OutboundDaemonToServerCommandResponseFrameSchema.parse(raw);
    expect('error' in parsed && parsed.error.code).toBe('internal_error');
    expect('error' in parsed && parsed.error.code).not.toBe('agent_dir_collision');
    expect(
      logger.entries.some(e => e.action === 'command_response_shape_drift'),
    ).toBe(true);
  });

  it('drops the connection on an inbound frame with the wrong direction', async () => {
    const { client, logger } = await makeHarness(async command => ({
      id: command.id,
      result: {},
    }));

    // A daemon_to_server frame arriving on the server's INBOUND path is a
    // protocol violation — the server only accepts server_to_daemon
    // commands (and heartbeats).
    client.sendRaw({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'x',
      kind: 'runtime_status',
      result: { runtimes: [] },
    });

    await client.waitForClose();
    expect(client.closed).toBe(true);
    expect(logger.entries.some(e => e.action === 'frame_invalid')).toBe(true);
  });

  it('drops the connection on a command whose params fail the per-command schema', async () => {
    let dispatched = false;
    const { client } = await makeHarness(async command => {
      dispatched = true;
      return { id: command.id, result: {} };
    });

    // runtime_start requires a well-formed `options` object; an empty
    // payload must be rejected at the schema gate and never dispatched.
    client.sendRaw({
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-bad',
      kind: 'runtime_start',
      params: { conversation_id: 'c1', agent_id: 'a1' },
    });

    await client.waitForClose();
    expect(client.closed).toBe(true);
    expect(dispatched).toBe(false);
  });

  it('does not dispatch a valid command queued behind an invalid frame in the same chunk (P1-1)', async () => {
    let dispatched = false;
    const { client, logger } = await makeHarness(async command => {
      dispatched = true;
      return { id: command.id, result: {} };
    });

    // ONE write carries: (1) a daemon_to_server frame (protocol violation
    // → must close), then (2) a perfectly valid runtime_status command.
    // The admission gate must tear the connection down on (1) and never
    // dispatch (2) — the connection is already protocol-violated.
    client.sendRawBatch([
      {
        direction: 'daemon_to_server',
        type: 'command_response',
        id: 'evil',
        kind: 'runtime_status',
        result: { runtimes: [] },
      },
      runtimeStatusCommand('cmd-after-violation'),
    ]);

    await client.waitForClose();
    expect(client.closed).toBe(true);
    expect(dispatched).toBe(false);
    expect(logger.entries.some(e => e.action === 'frame_invalid')).toBe(true);
  });

  it('drops runtime_output at the write-buffer cap without enqueuing or closing (P1-2)', async () => {
    // Tiny cap so a single frame overflows. runtime_output is the only
    // droppable kind: it is dropped, the connection stays open, and nothing
    // reaches the peer.
    const { server, client, logger } = await makeHarness(
      async command => ({ id: command.id, result: {} }),
      { writeBuffer: { maxBytes: 8, maxFrames: 1024 } },
    );

    server.broadcast({
      event: 'runtime_output',
      conversation_id: 'c1',
      agent_id: 'a1',
      stream: 'stdout',
      chunk: 'x'.repeat(512),
      ts: 1717000000,
    } as EventFrame);

    await expect(client.nextFrame(60)).rejects.toThrow(/no frame/i);
    expect(client.closed).toBe(false);
    expect(
      logger.entries.some(
        e => e.action === 'runtime_output_dropped' && e.kind === 'local_outbound',
      ),
    ).toBe(true);
  });

  it('closes the connection on a non-droppable event overflowing the cap (P1-2)', async () => {
    const { server, client, logger } = await makeHarness(
      async command => ({ id: command.id, result: {} }),
      { writeBuffer: { maxBytes: 8, maxFrames: 1024 } },
    );

    // runtime_ready_for_drain is non-droppable: overflowing the cap must
    // close the socket rather than grow an unbounded write queue against a
    // slow/stuck backend.
    server.broadcast({
      event: 'runtime_ready_for_drain',
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      ts: 1717000000,
    } as EventFrame);

    await client.waitForClose();
    expect(client.closed).toBe(true);
    expect(
      logger.entries.some(e => e.action === 'buffer_overflow_close'),
    ).toBe(true);
  });

  it('broadcasts a daemon event as a mapped outbound event frame', async () => {
    const { server, client } = await makeHarness(async command => ({
      id: command.id,
      result: {},
    }));

    const event: EventFrame = {
      event: 'runtime_ready_for_drain',
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      ts: 1717000000,
    } as EventFrame;
    server.broadcast(event);

    const raw = await client.nextFrame();
    const parsed = OutboundDaemonToServerEventFrameSchema.parse(raw);
    expect(parsed).toMatchObject({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_ready_for_drain',
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      conversation_id: 'c1',
      agent_id: 'a1',
      ts: 1717000000,
    });
  });

  it('emits a connection-scoped ready as the first frame on a new connection (P1-1)', async () => {
    // The embedded adapter relies on this handshake (mirrors the
    // standalone WSS client's `sendEvent(readyEvent())` on open) to
    // latch the daemon key and trigger its fanout hydrate. The ready is
    // mapped through `toOutboundEventFrame`, so the daemon-local
    // `socket_path` is stripped and the outbound protocol version is
    // stamped.
    const { client } = await makeHarness(
      async command => ({ id: command.id, result: {} }),
      { readyEvent: makeReadyEvent },
    );

    const raw = await client.nextFrame();
    const parsed = OutboundDaemonToServerEventFrameSchema.parse(raw);
    expect(parsed).toMatchObject({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      daemon_pid: 4242,
      started_at: 1717000000,
    });
    // socket_path is daemon-local and MUST NOT cross the outbound wire.
    expect('socket_path' in parsed).toBe(false);
  });

  it('does not replay a prior connection ready to a later joiner (P1-1 connection-scoped)', async () => {
    // A second client connecting after the first must receive ITS OWN
    // ready exactly once — not a broadcast/replay of another socket's
    // handshake. We assert the second client sees a single ready and no
    // duplicate.
    const { socketPath } = await makeHarness(
      async command => ({ id: command.id, result: {} }),
      { readyEvent: makeReadyEvent },
    );

    const second = await RawClient.connect(socketPath);
    cleanups.push(async () => second.destroy());
    const raw = await second.nextFrame();
    const parsed = OutboundDaemonToServerEventFrameSchema.parse(raw);
    expect(parsed).toMatchObject({ kind: 'ready' });
    // No second handshake frame queued for this socket.
    await expect(second.nextFrame(60)).rejects.toThrow(/no frame/i);
  });

  it('calls cleanupDeferredForOwner with the connection’s minted owner on socket close (#task:1417 Stage 3)', async () => {
    // Ingress wiring gate: when this connection drops, the server must
    // discard exactly this connection's deferred entries — keyed by the
    // SAME owner token it injected into the delivery context. The owner is
    // minted per-socket and dispatcher-injected (unspoofable); we capture
    // it off a real dispatch, then assert the close cleanup uses it.
    let dispatchedOwner: string | null = null;
    const cleaned: string[] = [];
    const { client } = await makeHarness(
      async (command, ctx?: { owner: string }) => {
        if (ctx) dispatchedOwner = ctx.owner;
        return { id: command.id, result: { runtimes: [] } };
      },
      { cleanupDeferredForOwner: owner => cleaned.push(owner) },
    );

    client.sendCommand(runtimeStatusCommand('cmd-owner'));
    await client.nextFrame();
    expect(dispatchedOwner).toMatch(/^local:/);

    // Drop the connection → cleanup fires once with this socket's owner.
    client.destroy();
    await vi.waitFor(() => {
      expect(cleaned).toContain(dispatchedOwner);
    });
    expect(cleaned).toEqual([dispatchedOwner]);
  });
});

function makeReadyEvent(): Extract<EventFrame, { event: 'ready' }> {
  return {
    event: 'ready',
    protocol_version: HOST_PROTOCOL_VERSION,
    daemon_version: 'test',
    daemon_id: 'local',
    instance_id: 'inst-1',
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [],
    socket_path: '/tmp/should-be-stripped.sock',
    daemon_pid: 4242,
    started_at: 1717000000,
  } as Extract<EventFrame, { event: 'ready' }>;
}

describe('LocalOutboundFrameServer — heartbeat (#task:1588 slice 2)', () => {
  it('answers a server-initiated ping with a pong echoing ts', async () => {
    const { client } = await makeHarness(async command => ({
      id: command.id,
      result: {},
    }));

    client.sendRaw({
      direction: 'server_to_daemon',
      type: 'heartbeat',
      kind: 'ping',
      ts: 4321,
    });

    // Skip any unsolicited frames (e.g. a ready event) until the pong.
    const deadline = Date.now() + 1_000;
    for (;;) {
      const frame = (await client.nextFrame()) as Record<string, unknown>;
      if (frame['type'] === 'heartbeat') {
        expect(frame['kind']).toBe('pong');
        expect(frame['echo_ts']).toBe(4321);
        expect(frame['direction']).toBe('daemon_to_server');
        break;
      }
      if (Date.now() > deadline) throw new Error('no pong received');
    }
    expect(client.closed).toBe(false);
  });

  it('tolerates an inbound pong without treating it as a violation', async () => {
    const { client, logger } = await makeHarness(async command => ({
      id: command.id,
      result: {},
    }));

    client.sendRaw({
      direction: 'server_to_daemon',
      type: 'heartbeat',
      kind: 'pong',
      ts: 1,
      echo_ts: 2,
    });

    // Follow with a real command to prove the connection survived.
    client.sendCommand(runtimeStatusCommand('after-pong'));
    const deadline = Date.now() + 1_000;
    for (;;) {
      const frame = (await client.nextFrame()) as Record<string, unknown>;
      if (frame['type'] === 'command_response') {
        expect(frame['id']).toBe('after-pong');
        break;
      }
      if (Date.now() > deadline) throw new Error('no command response');
    }
    expect(client.closed).toBe(false);
    expect(logger.entries.some(e => e.action === 'frame_invalid')).toBe(false);
  });
});
