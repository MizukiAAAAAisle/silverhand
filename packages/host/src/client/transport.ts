/**
 * Pluggable transport so the HostClient can be unit-tested against a
 * fake daemon without paying for `node:net`. Both implementations
 * (real Unix socket + in-memory fake) wrap a duplex byte stream and
 * surface only the four events the client cares about:
 *
 *   - `frame`        a complete NDJSON line arrived
 *   - `disconnect`   the underlying transport closed; reconnect logic
 *                    decides whether to retry
 *   - `overflow`     peer sent a line exceeding MAX_FRAME_BYTES; the
 *                    transport already destroyed the connection, the
 *                    client must trigger a reconnect
 *
 * Why pluggable: the real `node:net` Socket has subtle timing
 * (connect/error race, `.end()` half-close) that's annoying to mock
 * but easy to write a fake for in JS. The fake lets us cover client
 * state machine corners (pending request drained on reconnect, timeout
 * fires while disconnected) without flake.
 *
 * Implementations live in `client/socket-transport.ts` and
 * `client/in-memory-transport.ts` (test-only).
 */
import type { ResponseFrame, EventFrame } from '../protocol.js';

export type DecodedFrame = ResponseFrame | EventFrame;

export interface TransportEvents {
  frame: (frame: DecodedFrame) => void;
  disconnect: (reason: string) => void;
  overflow: () => void;
}

export interface Transport {
  /** Attempt to connect. Resolves on success; rejects on hard failure
   *  (ENOENT, EACCES, etc.). Reconnect policy is the client's job, not
   *  the transport's. */
  connect(): Promise<void>;
  /** Write an outgoing NDJSON line (frame already includes `\n`).
   *  Returns false when the transport is not connected; caller decides
   *  whether to queue. */
  write(encodedLine: string): boolean;
  /** Tear down the transport. After close, `connect()` may be called
   *  again to reopen. Idempotent. */
  close(): void;
  /** Subscribe to events. Returns an unsubscribe function. */
  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): () => void;
  /** True after `connect()` resolves and before `disconnect` fires. */
  isConnected(): boolean;
}
