/**
 * OutputBackpressure tests — drives a fake `Socket` whose
 * `writableNeedDrain` flag and write-callback timing the test
 * controls explicitly. No real `node:net.Socket`, no event-loop
 * dependency.
 *
 * The contract under test (design doc §2.2.2):
 *
 *  - Non-droppable events bypass the cap entirely.
 *  - `runtime_output` chunks count against a per-(socket, conv, agent)
 *    in-flight byte counter.
 *  - Drops fire only when (a) the kernel signals back-pressure via
 *    `writableNeedDrain` AND (b) accepting the chunk would push the
 *    counter above the high-water mark.
 *  - On recovery (counter ≤ low-water), exactly ONE
 *    `runtime_output_dropped` summary event lands per window.
 *  - State is per-socket — slow consumer A does not affect socket B.
 *  - `forgetSocket()` purges per-socket state on disconnect.
 */
import { describe, expect, it } from 'vitest';
import { OutputBackpressure } from '../src/daemon/output-backpressure.js';
import type { EventFrame } from '../src/protocol.js';
import type { Socket } from 'node:net';

type WriteCb = () => void;
type WriteRecord = { line: string; cb?: WriteCb };

interface FakeSocket {
  __writes: WriteRecord[];
  /** Toggle to simulate kernel back-pressure. */
  writableNeedDrain: boolean;
  writable: boolean;
  readonly destroyed: boolean;
  write(chunk: string, cb?: WriteCb): boolean;
  /** Mark socket destroyed; subsequent writes return false. */
  __destroy(): void;
  /** Fire write-callbacks in FIFO order (kernel finished flushing
   *  the next N chunks). */
  __ack(count?: number): void;
}

function makeFakeSocket(): FakeSocket {
  const writes: WriteRecord[] = [];
  let destroyed = false;
  const sock: FakeSocket = {
    __writes: writes,
    writableNeedDrain: false,
    writable: true,
    get destroyed(): boolean { return destroyed; },
    write(chunk: string, cb?: WriteCb): boolean {
      if (destroyed) return false;
      writes.push({ line: chunk, cb });
      return !sock.writableNeedDrain;
    },
    __destroy(): void {
      destroyed = true;
    },
    __ack(count = 1): void {
      for (let i = 0; i < count; i++) {
        const next = writes.find(w => w.cb);
        if (!next || !next.cb) break;
        const cb = next.cb;
        next.cb = undefined;
        cb();
      }
    },
  };
  return sock;
}

/** Cast for OutputBackpressure.emit's Socket parameter — the BP module
 *  only ever uses `write` / `writableNeedDrain` / `writable` / `destroyed`,
 *  so a structural fake satisfies it at runtime. */
function asSocket(s: FakeSocket): Socket {
  return s as unknown as Socket;
}

function outputFrame(chunkSize: number, conv = 'c1', agent = 'a1'): EventFrame {
  return {
    event: 'runtime_output',
    runtime_scope: {
      kind: 'conversation',
      conversation_id: conv,
      agent_id: agent,
    },
    conversation_id: conv,
    agent_id: agent,
    stream: 'stdout',
    chunk: 'x'.repeat(chunkSize),
    ts: 1_700_000_000_000,
  };
}

describe('OutputBackpressure — non-droppable events', () => {
  it('writes runtime_state straight through without touching the counter', () => {
    const bp = new OutputBackpressure({ highWaterBytes: 1024, lowWaterBytes: 512 });
    const sock = makeFakeSocket();
    sock.writableNeedDrain = true;
    const r = bp.emit(asSocket(sock), {
      event: 'runtime_state',
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      conversation_id: 'c1',
      agent_id: 'a1',
      runtime_generation: 1,
      state: {
        runId: 'r1',
        agentId: 'a1',
        conversationId: 'c1',
        status: 'idle',
        startedAt: 0,
        updatedAt: 0,
        lastActivityAt: 0,
      },
      ts: 0,
    });
    expect(r).toBe('sent');
    expect(sock.__writes).toHaveLength(1);
    expect(bp.__peekBytes(asSocket(sock), 'c1', 'a1')).toBe(0);
  });

  it('runtime_exit, ready_for_drain, startup_delivery_consumed are all non-droppable', () => {
    const bp = new OutputBackpressure({ highWaterBytes: 64, lowWaterBytes: 32 });
    const sock = makeFakeSocket();
    sock.writableNeedDrain = true;
    const events: EventFrame[] = [
      {
        event: 'runtime_exit',
        runtime_scope: {
          kind: 'conversation',
          conversation_id: 'c1',
          agent_id: 'a1',
        },
        conversation_id: 'c1',
        agent_id: 'a1',
        runtime_generation: 1,
        code: 0,
        intentional: true,
        ts: 0,
      },
      {
        event: 'runtime_ready_for_drain',
        runtime_scope: {
          kind: 'conversation',
          conversation_id: 'c1',
          agent_id: 'a1',
        },
        conversation_id: 'c1',
        agent_id: 'a1',
        runtime_generation: 1,
        ts: 0,
      },
      {
        event: 'runtime_delivery_consumed',
        runtime_scope: {
          kind: 'conversation',
          conversation_id: 'c1',
          agent_id: 'a1',
        },
        conversation_id: 'c1',
        agent_id: 'a1',
        runtime_generation: 1,
        delivery_ids: [1],
        ts: 0,
      },
    ];
    for (const e of events) {
      expect(bp.emit(asSocket(sock), e)).toBe('sent');
    }
    expect(sock.__writes).toHaveLength(3);
  });
});

describe('OutputBackpressure — happy path (no kernel pressure)', () => {
  it('runtime_output writes pass through and decrement counter on ack', () => {
    const bp = new OutputBackpressure({ highWaterBytes: 4096, lowWaterBytes: 1024 });
    const sock = makeFakeSocket();
    expect(bp.emit(asSocket(sock), outputFrame(100))).toBe('sent');
    expect(bp.emit(asSocket(sock), outputFrame(200))).toBe('sent');
    // Bytes-in-flight tracks encoded length (chunk + JSON envelope).
    expect(bp.__peekBytes(asSocket(sock), 'c1', 'a1')).toBeGreaterThan(0);
    sock.__ack(2);
    expect(bp.__peekBytes(asSocket(sock), 'c1', 'a1')).toBe(0);
  });

  it('does not enter the dropping state when writableNeedDrain is false even past high-water', () => {
    // High-water=64 bytes; emit a 100-byte chunk. Counter goes above
    // high-water but socket is NOT signaling drain → must accept.
    const bp = new OutputBackpressure({ highWaterBytes: 64, lowWaterBytes: 32 });
    const sock = makeFakeSocket();
    expect(bp.emit(asSocket(sock), outputFrame(100))).toBe('sent');
    expect(bp.__peekWindow(asSocket(sock), 'c1', 'a1')).toBeNull();
  });
});

describe('OutputBackpressure — drop window', () => {
  it('starts a window and drops chunks when needDrain && over high-water', () => {
    const bp = new OutputBackpressure({
      highWaterBytes: 64,
      lowWaterBytes: 32,
      now: () => 1_700_000_000_000,
    });
    const sock = makeFakeSocket();
    // Fill the in-flight counter without back-pressure first.
    expect(bp.emit(asSocket(sock), outputFrame(60))).toBe('sent');
    const baseline = bp.__peekBytes(asSocket(sock), 'c1', 'a1');
    expect(baseline).toBeGreaterThan(0);
    // Now flip the kernel into back-pressure mode and emit again.
    // Counter (~baseline) plus chunk pushes us over high-water.
    sock.writableNeedDrain = true;
    expect(bp.emit(asSocket(sock), outputFrame(60))).toBe('dropped');
    expect(bp.emit(asSocket(sock), outputFrame(60))).toBe('dropped');
    const win = bp.__peekWindow(asSocket(sock), 'c1', 'a1');
    expect(win).not.toBeNull();
    expect(win!.dropped_count).toBe(2);
    expect(win!.bytes_dropped).toBeGreaterThan(0);
    expect(win!.since_ts).toBe(1_700_000_000_000);
  });

  it('emits exactly ONE runtime_output_dropped summary on recovery', () => {
    const bp = new OutputBackpressure({
      highWaterBytes: 64,
      lowWaterBytes: 32,
      now: () => 1_700_000_000_000,
    });
    const sock = makeFakeSocket();
    // Enqueue one accepted chunk, then flip needDrain so the next two
    // get dropped.
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = true;
    bp.emit(asSocket(sock), outputFrame(60));
    bp.emit(asSocket(sock), outputFrame(60));
    expect(bp.__peekWindow(asSocket(sock), 'c1', 'a1')).not.toBeNull();
    // Kernel takes the first chunk → callback fires → counter drops
    // below low-water → summary should land.
    sock.writableNeedDrain = false;
    sock.__ack(1);
    const summaryWrites = sock.__writes
      .map(w => JSON.parse(w.line) as Record<string, unknown>)
      .filter(p => p.event === 'runtime_output_dropped');
    expect(summaryWrites).toHaveLength(1);
    expect(summaryWrites[0]).toMatchObject({
      conversation_id: 'c1',
      agent_id: 'a1',
      dropped_count: 2,
      since_ts: 1_700_000_000_000,
    });
    expect((summaryWrites[0] as { bytes_dropped: number }).bytes_dropped).toBeGreaterThan(0);
    expect(bp.__peekWindow(asSocket(sock), 'c1', 'a1')).toBeNull();
  });

  it('opens a new window after a previous one has closed', () => {
    const bp = new OutputBackpressure({
      highWaterBytes: 64,
      lowWaterBytes: 32,
      now: () => 1_700_000_000_000,
    });
    const sock = makeFakeSocket();
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = true;
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = false;
    sock.__ack(1); // recovery → summary 1
    sock.writableNeedDrain = false;
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = true;
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = false;
    sock.__ack(1); // recovery → summary 2
    const summaries = sock.__writes
      .map(w => JSON.parse(w.line) as Record<string, unknown>)
      .filter(p => p.event === 'runtime_output_dropped');
    expect(summaries).toHaveLength(2);
  });

  it('invokes onSummaryEvent with the synthesized frame before the socket write (§3.4 event log path)', () => {
    // Cindy `POiN_oGtyDjr3Sni` note — the summary frame used to go
    // direct to socket.write, bypassing the structured event log.
    // The new onSummaryEvent hook lets the server route it through
    // logEvent so runtime_output_dropped shows up in the event log
    // like every other broadcast event.
    const captured: EventFrame[] = [];
    const bp = new OutputBackpressure({
      highWaterBytes: 64,
      lowWaterBytes: 32,
      now: () => 1_700_000_000_000,
      onSummaryEvent: ev => captured.push(ev),
    });
    const sock = makeFakeSocket();
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = true;
    bp.emit(asSocket(sock), outputFrame(60));
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = false;
    sock.__ack(1);
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    if (ev.event !== 'runtime_output_dropped') {
      throw new Error('expected runtime_output_dropped');
    }
    expect(ev.conversation_id).toBe('c1');
    expect(ev.agent_id).toBe('a1');
    expect(ev.dropped_count).toBe(2);
    expect(ev.since_ts).toBe(1_700_000_000_000);
  });
});

describe('OutputBackpressure — per-key isolation', () => {
  it('does not let one (conv, agent) starve another on the same socket', () => {
    // Sized so that two 60-byte chunks for A push past 256 bytes (with
    // JSON envelope overhead each chunk encodes to ~150 bytes), but a
    // single B chunk's encoding fits comfortably under high-water — so
    // B is unaffected by A's pressure.
    const bp = new OutputBackpressure({ highWaterBytes: 256, lowWaterBytes: 128 });
    const sock = makeFakeSocket();
    // A fills its counter and gets back-pressured → starts dropping.
    bp.emit(asSocket(sock), outputFrame(60, 'A', 'a1'));
    bp.emit(asSocket(sock), outputFrame(60, 'A', 'a1'));
    sock.writableNeedDrain = true;
    expect(bp.emit(asSocket(sock), outputFrame(60, 'A', 'a1'))).toBe('dropped');
    // B shares the kernel's needDrain but starts at 0 — its first
    // chunk must NOT be dropped (would-exceed=false for B).
    expect(bp.emit(asSocket(sock), outputFrame(40, 'B', 'b1'))).toBe('sent');
  });

  it('keeps per-socket buckets isolated', () => {
    const bp = new OutputBackpressure({ highWaterBytes: 64, lowWaterBytes: 32 });
    const slow = makeFakeSocket();
    const fast = makeFakeSocket();
    bp.emit(asSocket(slow), outputFrame(60));
    slow.writableNeedDrain = true;
    expect(bp.emit(asSocket(slow), outputFrame(60))).toBe('dropped');
    // Fast socket's counter is untouched; it accepts.
    expect(bp.emit(asSocket(fast), outputFrame(60))).toBe('sent');
  });
});

describe('OutputBackpressure — closed sockets', () => {
  it('returns "closed" when emit is called on a destroyed socket', () => {
    const bp = new OutputBackpressure();
    const sock = makeFakeSocket();
    sock.__destroy();
    expect(bp.emit(asSocket(sock), outputFrame(10))).toBe('closed');
    expect(sock.__writes).toHaveLength(0);
  });

  it('forgetSocket clears per-key state', () => {
    const bp = new OutputBackpressure({ highWaterBytes: 64, lowWaterBytes: 32 });
    const sock = makeFakeSocket();
    bp.emit(asSocket(sock), outputFrame(60));
    expect(bp.__peekBytes(asSocket(sock), 'c1', 'a1')).toBeGreaterThan(0);
    bp.forgetSocket(asSocket(sock));
    expect(bp.__peekBytes(asSocket(sock), 'c1', 'a1')).toBe(0);
  });

  it('write-callback firing after forgetSocket is a no-op', () => {
    const bp = new OutputBackpressure({ highWaterBytes: 64, lowWaterBytes: 32 });
    const sock = makeFakeSocket();
    bp.emit(asSocket(sock), outputFrame(60));
    bp.forgetSocket(asSocket(sock));
    // ack the pending write — should not throw and should not
    // resurrect any state.
    expect(() => sock.__ack(1)).not.toThrow();
    expect(bp.__peekBytes(asSocket(sock), 'c1', 'a1')).toBe(0);
  });
});

describe('OutputBackpressure — config validation & logging', () => {
  it('rejects lowWaterBytes > highWaterBytes', () => {
    expect(
      () => new OutputBackpressure({ highWaterBytes: 100, lowWaterBytes: 200 }),
    ).toThrow(/lowWater/);
  });

  it('logDrop hook receives drop and summary events without payload bodies', () => {
    const entries: Array<Record<string, unknown>> = [];
    const bp = new OutputBackpressure({
      highWaterBytes: 64,
      lowWaterBytes: 32,
      logDrop: e => entries.push(e),
    });
    const sock = makeFakeSocket();
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = true;
    bp.emit(asSocket(sock), outputFrame(60));
    bp.emit(asSocket(sock), outputFrame(60));
    sock.writableNeedDrain = false;
    sock.__ack(1);
    const drops = entries.filter(e => e.kind === 'drop');
    const summaries = entries.filter(e => e.kind === 'summary');
    expect(drops).toHaveLength(2);
    expect(summaries).toHaveLength(1);
    // §3.4 logging contract: structured fields only, never the chunk body.
    for (const e of entries) {
      expect(JSON.stringify(e)).not.toContain('xxx');
      expect(JSON.stringify(e)).not.toContain('"chunk"');
      expect(JSON.stringify(e)).not.toContain('"payload"');
      expect(JSON.stringify(e)).not.toContain('"stdout"');
    }
  });
});
