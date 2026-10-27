/**
 * Per-(conv, agent) outgoing buffer cap for `runtime_output` frames.
 *
 * Per design doc §2.2.2 — "drop only `runtime_output`; control events
 * never participate in backpressure". This module IS the enforcement
 * point. Server.broadcast() routes every frame through `emit()`; for
 * non-droppable frames we write straight through, for droppable
 * `runtime_output` we apply the cap.
 *
 * Scope (locked by shiki `kh7mQQIUi8WxFoPX`): the counter tracks
 * **un-flushed bytes only** — bytes the daemon has handed to
 * `socket.write()` but the kernel has NOT yet acknowledged via the
 * write-callback. Once the kernel takes the bytes, they no longer
 * count. **It is NOT a session-cumulative byte total.** Under normal
 * flow (backend reading at line rate) the counter sits near 0 and the
 * 4 MiB threshold is never approached.
 *
 * Model:
 *
 *  - `bytes_in_node_buffer` — sum of in-flight `runtime_output` byte
 *    counts for which the write-callback has not yet fired. Increments
 *    on enqueue, decrements in callback.
 *  - `dropping_window` — `null` while we're under threshold. When a
 *    new chunk would push us above 4 MiB **AND** the socket reports
 *    `writableNeedDrain` (i.e. the kernel itself is back-pressuring),
 *    we drop the chunk, accumulate `dropped_count` / `bytes_dropped`,
 *    and remember `since_ts` so the recovery summary frame carries
 *    "drops started at T".
 *  - When the in-flight counter recovers below the 2 MiB low-water,
 *    we emit ONE `runtime_output_dropped` summary event with the
 *    accumulated stats, then clear `dropping_window`. Subsequent
 *    drops would start a new window.
 *
 * Drop policy — drop NEW chunks (not "oldest queued chunks"). The
 * design-doc text §2.2.2 originally said "drop the oldest" but the
 * real contract that ships is solely "(`dropped_count`,
 * `bytes_dropped`) are accurate AND one `runtime_output_dropped`
 * lands per recovery window". Dropping new chunks reaches that
 * contract WITHOUT carrying an app-level FIFO that would itself need
 * bounding. Design doc has been updated to match (`drop_policy:
 * incoming` per Cindy `POiN_oGtyDjr3Sni`).
 *
 * Storage — a nested `Map<convId, Map<agentId, KeyState>>` rather
 * than a flat `Map<string, KeyState>` with a composite string key.
 * Composite keys force a separator character; visible ASCII (`|`,
 * `:`) collide with valid id chars, control bytes (`\x00`, `\x1f`)
 * make the source file binary-flagged in `git diff`. Nested maps
 * sidestep that entirely.
 *
 * Edge cases:
 *
 *  - Socket closes mid-window: `forgetSocket()` purges all per-key
 *    state for that socket so a reconnect starts fresh. Pending
 *    write-callbacks that fire after close are no-ops (the state
 *    they'd target is already gone).
 *  - Multiple sockets (e.g. a test client + the real backend): per-
 *    socket buckets — one slow consumer cannot starve another. State
 *    is keyed by `(socket, conv, agent)`.
 */
import { encodeFrame, type EventFrame, type RuntimeScope } from '../protocol.js';
import type { Socket } from 'node:net';

/** Hard ceiling on un-flushed runtime_output bytes per (conv, agent). */
export const OUTPUT_BUFFER_HIGH_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Recovery low-water; once we drop below this, we emit the summary
 *  and stop dropping new chunks. */
export const OUTPUT_BUFFER_LOW_BYTES = 2 * 1024 * 1024; // 2 MiB

interface DropWindow {
  runtime_scope: RuntimeScope;
  since_ts: number;
  dropped_count: number;
  bytes_dropped: number;
}

interface KeyState {
  bytes_in_node_buffer: number;
  dropping_window: DropWindow | null;
}

/** Per-socket nested map: conversation_id → agent_id → KeyState. */
type SocketState = Map<string, Map<string, KeyState>>;

export interface OutputBackpressureOptions {
  /** Time supplier; injected so tests can pin `since_ts`. Default Date.now. */
  now?: () => number;
  /** Override the high-water threshold (tests use small values to
   *  trigger drops with a few KiB instead of 4 MiB). */
  highWaterBytes?: number;
  /** Override the recovery low-water threshold. Must be ≤ high-water. */
  lowWaterBytes?: number;
  /** Optional structured logger hook; receives `{ conversationId, agent_id,
   *  bytes_dropped, dropped_count, buffer_bytes }` per dropped chunk
   *  and per emitted summary. */
  logDrop?: (entry: {
    kind: 'drop' | 'summary';
    conversation_id: string;
    agent_id: string;
    buffer_bytes: number;
    bytes_dropped: number;
    dropped_count: number;
  }) => void;
  /**
   * Optional hook invoked with the synthesized
   * `runtime_output_dropped` summary frame just before it is written
   * to the socket. The server wires this to the §3.4 `logEvent`
   * helper so the summary appears in the structured event log
   * alongside every other broadcast event (Cindy `POiN_oGtyDjr3Sni`
   * note — previously this path bypassed `logEvent`).
   */
  onSummaryEvent?: (event: EventFrame) => void;
}

export class OutputBackpressure {
  private readonly now: () => number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly logDrop: OutputBackpressureOptions['logDrop'];
  private readonly onSummaryEvent: OutputBackpressureOptions['onSummaryEvent'];
  private readonly bySocket = new WeakMap<Socket, SocketState>();

  constructor(opts: OutputBackpressureOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.highWater = opts.highWaterBytes ?? OUTPUT_BUFFER_HIGH_BYTES;
    this.lowWater = opts.lowWaterBytes ?? OUTPUT_BUFFER_LOW_BYTES;
    if (this.lowWater > this.highWater) {
      throw new Error(
        `OutputBackpressure: lowWaterBytes (${this.lowWater}) must be ≤ highWaterBytes (${this.highWater})`,
      );
    }
    this.logDrop = opts.logDrop;
    this.onSummaryEvent = opts.onSummaryEvent;
  }

  /**
   * Send `event` on `socket`, applying the per-key cap when
   * `event.event === 'runtime_output'`. Non-droppable events are
   * written directly. Returns:
   *
   *  - `'sent'` — bytes were enqueued on the socket (or written through
   *    successfully).
   *  - `'dropped'` — the chunk was dropped due to the cap; caller need
   *    not act, the summary frame is emitted automatically on recovery.
   *  - `'closed'` — socket was destroyed; nothing happened.
   */
  emit(socket: Socket, event: EventFrame): 'sent' | 'dropped' | 'closed' {
    if (socket.destroyed || !socket.writable) return 'closed';
    const encoded = encodeFrame(event);

    if (event.event !== 'runtime_output') {
      // Non-droppable — never participates in the cap.
      try {
        socket.write(encoded);
      } catch {
        return 'closed';
      }
      return 'sent';
    }

    const conv = event.conversation_id;
    const agent = event.agent_id;
    const state = this.getOrCreateKeyState(socket, conv, agent);

    const wouldExceed = state.bytes_in_node_buffer + encoded.length > this.highWater;
    // Two-condition gate: drop only when the kernel itself is signaling
    // back-pressure (writableNeedDrain) AND our application-side counter
    // is over the high-water mark. This means a momentary burst that
    // the kernel still accepts won't trigger a drop.
    if (wouldExceed && socket.writableNeedDrain) {
      if (!state.dropping_window) {
        state.dropping_window = {
          runtime_scope: event.runtime_scope,
          since_ts: this.now(),
          dropped_count: 0,
          bytes_dropped: 0,
        };
      }
      state.dropping_window.dropped_count += 1;
      state.dropping_window.bytes_dropped += encoded.length;
      this.logDrop?.({
        kind: 'drop',
        conversation_id: conv,
        agent_id: agent,
        buffer_bytes: state.bytes_in_node_buffer,
        bytes_dropped: state.dropping_window.bytes_dropped,
        dropped_count: state.dropping_window.dropped_count,
      });
      return 'dropped';
    }

    // Accept the chunk. Track its byte count against the in-flight
    // counter; release it when the kernel acknowledges via the
    // write-callback.
    state.bytes_in_node_buffer += encoded.length;
    let writeOk = true;
    try {
      socket.write(encoded, () => {
        // Callback may fire after the socket was closed; treat as
        // best-effort cleanup. Look up state freshly so a
        // forgetSocket() between enqueue and ack is a no-op.
        const stateNow = this.peekKeyState(socket, conv, agent);
        if (!stateNow) return;
        stateNow.bytes_in_node_buffer = Math.max(0, stateNow.bytes_in_node_buffer - encoded.length);
        // Recovery: if we were dropping and we've now dropped below
        // the low-water mark, emit ONE summary frame and reset the
        // window. Subsequent drops start a fresh window.
        if (stateNow.dropping_window && stateNow.bytes_in_node_buffer <= this.lowWater) {
          this.emitSummary(socket, conv, agent, stateNow);
        }
      });
    } catch {
      writeOk = false;
    }
    if (!writeOk) {
      // Roll back the counter; the bytes never made it onto the wire.
      state.bytes_in_node_buffer = Math.max(0, state.bytes_in_node_buffer - encoded.length);
      return 'closed';
    }
    return 'sent';
  }

  /**
   * Drop all per-key state for `socket`. Call on socket-close so a
   * reconnect starts with a fresh ledger. Pending write-callbacks
   * scheduled before this no-op safely (they look up state by
   * `(conv, agent)` and find it absent).
   */
  forgetSocket(socket: Socket): void {
    this.bySocket.delete(socket);
  }

  private peekKeyState(socket: Socket, conv: string, agent: string): KeyState | undefined {
    return this.bySocket.get(socket)?.get(conv)?.get(agent);
  }

  private getOrCreateKeyState(socket: Socket, conv: string, agent: string): KeyState {
    let sock = this.bySocket.get(socket);
    if (!sock) {
      sock = new Map();
      this.bySocket.set(socket, sock);
    }
    let byAgent = sock.get(conv);
    if (!byAgent) {
      byAgent = new Map();
      sock.set(conv, byAgent);
    }
    let state = byAgent.get(agent);
    if (!state) {
      state = { bytes_in_node_buffer: 0, dropping_window: null };
      byAgent.set(agent, state);
    }
    return state;
  }

  private emitSummary(socket: Socket, conv: string, agent: string, state: KeyState): void {
    if (!state.dropping_window) return;
    const summary: EventFrame = {
      event: 'runtime_output_dropped',
      runtime_scope: state.dropping_window.runtime_scope,
      conversation_id: conv,
      agent_id: agent,
      dropped_count: state.dropping_window.dropped_count,
      bytes_dropped: state.dropping_window.bytes_dropped,
      since_ts: state.dropping_window.since_ts,
    };
    this.logDrop?.({
      kind: 'summary',
      conversation_id: conv,
      agent_id: agent,
      buffer_bytes: state.bytes_in_node_buffer,
      bytes_dropped: state.dropping_window.bytes_dropped,
      dropped_count: state.dropping_window.dropped_count,
    });
    // §3.4 event log — emit once before the socket write so the
    // summary appears in the structured event stream even if the
    // socket is gone by the time we try to write.
    this.onSummaryEvent?.(summary);
    state.dropping_window = null;
    if (!socket.destroyed && socket.writable) {
      try {
        socket.write(encodeFrame(summary));
      } catch {
        /* socket gone — discard summary */
      }
    }
  }
}
