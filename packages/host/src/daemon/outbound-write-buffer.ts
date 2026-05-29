/**
 * D5.a-2 P1-2 — shared outbound write buffer + backpressure.
 *
 * Extracted from `outbound-client.ts` so BOTH outbound transports apply
 * the SAME bounded write-buffer / backpressure policy, not just the same
 * frame envelope:
 *
 *   - standalone WSS (`OutboundDaemonClient`) over a `ws.WebSocket`;
 *   - embedded local Unix (`LocalOutboundFrameServer`) over a
 *     `net.Socket`.
 *
 * Without this, a slow/stuck embedded backend would let the daemon build
 * an unbounded in-process write queue (Node buffers writes in RAM once
 * the kernel buffer is full) — and embedded would silently diverge from
 * standalone, which already drops `runtime_output` at the cap and closes
 * the connection on a non-droppable overflow. Transport parity means
 * flow-control parity, so the buffer is transport-neutral: it talks to an
 * {@link OutboundFrameWriter} (`bufferedAmount()` + `send()`), and each
 * transport supplies a thin writer adapter.
 */
import { WebSocket } from 'ws';
import type { Socket } from 'node:net';
import {
  encodeOutboundFrame,
  type OutboundDaemonToServerEventFrame,
} from '../outbound-protocol.js';
import type { EventFrame } from '../protocol.js';
import type { DaemonLogger } from './logger.js';

export interface OutboundWriteBufferOptions {
  maxFrames: number;
  maxBytes: number;
}

export const DEFAULT_OUTBOUND_WRITE_BUFFER: OutboundWriteBufferOptions = {
  maxFrames: 1024,
  maxBytes: 4 * 1024 * 1024,
};

export interface OutboundEventMetadata {
  kind: string;
  conversation_id?: string;
  agent_id?: string;
  ts?: number;
}

export type SendResult = 'sent' | 'dropped' | 'overflow' | 'failed';

/**
 * Transport-neutral write sink. `bufferedAmount()` is the bytes already
 * queued in the underlying transport but not yet flushed to the kernel
 * (`ws.bufferedAmount` / `socket.writableLength`); `send()` enqueues the
 * encoded frame and invokes `cb` once it is flushed (or errored).
 */
export interface OutboundFrameWriter {
  bufferedAmount(): number;
  send(encoded: string, cb: (err?: Error | null) => void): void;
}

/** WebSocket writer adapter (standalone WSS). Message-framed: no newline. */
export function webSocketFrameWriter(ws: WebSocket): OutboundFrameWriter {
  return {
    bufferedAmount: () => ws.bufferedAmount,
    send: (encoded, cb) => ws.send(encoded, cb),
  };
}

/**
 * Unix-socket writer adapter (embedded local outbound). The socket is
 * line-delimited, so the NDJSON newline is appended here (the encoder
 * itself does not append one — WSS relies on message boundaries). The
 * byte accounting in {@link OutboundWriteBuffer} uses the pre-newline
 * length, off by one byte per frame, which is immaterial against a
 * multi-KiB/MiB cap.
 */
export function unixSocketFrameWriter(socket: Socket): OutboundFrameWriter {
  return {
    bufferedAmount: () => socket.writableLength,
    send: (encoded, cb) => {
      socket.write(`${encoded}\n`, cb);
    },
  };
}

export function eventMetadata(event: EventFrame): OutboundEventMetadata {
  return {
    kind: event.event,
    conversation_id:
      'conversation_id' in event ? event.conversation_id : undefined,
    agent_id: 'agent_id' in event ? event.agent_id : undefined,
    ts: 'ts' in event && typeof event.ts === 'number' ? event.ts : undefined,
  };
}

/**
 * Per-connection bounded write buffer. One instance per live outbound
 * connection (WSS has exactly one; the local server holds one per live
 * socket and forgets it on close). `runtime_output` is the only droppable
 * event kind — at the cap it is dropped and the caller keeps the
 * connection open. Any other (non-droppable) event at the cap returns
 * `'overflow'`, and the caller MUST close the connection rather than grow
 * the queue without bound.
 */
export class OutboundWriteBuffer {
  pendingFrames = 0;
  pendingBytes = 0;
  private droppedRuntimeOutput = 0;
  private readonly logKind: string;

  constructor(
    private readonly opts: OutboundWriteBufferOptions,
    logKind = 'outbound_ws',
  ) {
    this.logKind = logKind;
  }

  send(input: {
    writer: OutboundFrameWriter;
    frame: OutboundDaemonToServerEventFrame;
    metadata: OutboundEventMetadata;
    logger: DaemonLogger;
  }): SendResult {
    let encoded: string;
    try {
      encoded = encodeOutboundFrame(input.frame);
    } catch (err) {
      if (input.metadata.kind === 'runtime_output') {
        this.logRuntimeOutputDrop(input, 0, (err as Error).message);
        return 'dropped';
      }
      this.logOverflow(input, 0, (err as Error).message);
      return 'overflow';
    }

    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    // Conservative on purpose: pendingBytes and the transport's own queue
    // can overlap briefly for in-flight sends; prefer early backpressure
    // to unbounded RAM.
    const totalBytes =
      this.pendingBytes + encodedBytes + Math.max(0, input.writer.bufferedAmount());
    const totalFrames = this.pendingFrames + 1;
    if (totalBytes > this.opts.maxBytes || totalFrames > this.opts.maxFrames) {
      if (input.metadata.kind === 'runtime_output') {
        this.logRuntimeOutputDrop(input, encodedBytes, 'buffer_limit');
        return 'dropped';
      }
      this.logOverflow(input, encodedBytes, 'buffer_limit');
      return 'overflow';
    }

    this.pendingFrames++;
    this.pendingBytes += encodedBytes;
    try {
      input.writer.send(encoded, err => {
        this.pendingFrames = Math.max(0, this.pendingFrames - 1);
        this.pendingBytes = Math.max(0, this.pendingBytes - encodedBytes);
        if (err) {
          input.logger.warn(
            {
              kind: this.logKind,
              action: 'event_send_callback_error',
              err: err.message,
              event_kind: input.metadata.kind,
              conversation_id: input.metadata.conversation_id,
              agent_id: input.metadata.agent_id,
              ts: input.metadata.ts,
            },
            'daemon outbound event send callback failed',
          );
        }
      });
      return 'sent';
    } catch (err) {
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
      this.pendingBytes = Math.max(0, this.pendingBytes - encodedBytes);
      input.logger.warn(
        {
          kind: this.logKind,
          action: 'event_send_failed',
          err: (err as Error).message,
          event_kind: input.metadata.kind,
          conversation_id: input.metadata.conversation_id,
          agent_id: input.metadata.agent_id,
          ts: input.metadata.ts,
        },
        'daemon outbound event send failed',
      );
      return 'failed';
    }
  }

  reset(): void {
    this.pendingFrames = 0;
    this.pendingBytes = 0;
  }

  private logRuntimeOutputDrop(
    input: { metadata: OutboundEventMetadata; logger: DaemonLogger },
    encodedBytes: number,
    reason: string,
  ): void {
    this.droppedRuntimeOutput++;
    input.logger.warn(
      {
        kind: this.logKind,
        action: 'runtime_output_dropped',
        event_kind: input.metadata.kind,
        conversation_id: input.metadata.conversation_id,
        agent_id: input.metadata.agent_id,
        ts: input.metadata.ts,
        encoded_bytes: encodedBytes,
        pending_frames: this.pendingFrames,
        pending_bytes: this.pendingBytes,
        dropped_count: this.droppedRuntimeOutput,
        reason,
      },
      'daemon outbound runtime_output dropped under write-buffer pressure',
    );
  }

  private logOverflow(
    input: { metadata: OutboundEventMetadata; logger: DaemonLogger },
    encodedBytes: number,
    reason: string,
  ): void {
    input.logger.warn(
      {
        kind: this.logKind,
        action: 'non_droppable_overflow',
        event_kind: input.metadata.kind,
        conversation_id: input.metadata.conversation_id,
        agent_id: input.metadata.agent_id,
        ts: input.metadata.ts,
        encoded_bytes: encodedBytes,
        pending_frames: this.pendingFrames,
        pending_bytes: this.pendingBytes,
        reason,
      },
      'daemon outbound non-droppable event exceeded write-buffer cap',
    );
  }
}
