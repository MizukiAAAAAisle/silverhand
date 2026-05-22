/**
 * In-memory `Transport` for HostClient unit tests.
 *
 * Lives under `tests/_helpers/` because production code should never
 * import it — the production path always uses `SocketTransport`.
 *
 * Provides a single end-to-end loop: the test creates a paired
 * `(transport, peer)`, hands `transport` to `new HostClient({
 * transportFactory: () => transport })`, and drives `peer.writeFrame(...)`
 * to simulate daemon-side responses. There is no `node:net`, no real
 * NDJSON splitter — frames are passed as objects so we test the client
 * state machine in isolation.
 */
import type {
  Transport,
  TransportEvents,
  DecodedFrame,
} from '../../src/client/transport.js';
import {
  AnyFrameSchema,
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
  type RequestFrame,
} from '../../src/protocol.js';

export interface FakeDaemonPeer {
  /** Inject a frame from the "daemon" side to the client. */
  send(frame: DecodedFrame): void;
  /** Simulate daemon-initiated disconnect. */
  disconnect(reason?: string): void;
  /** Decoded copy of every request frame the client sent. */
  readonly received: RequestFrame[];
}

export interface FakeTransportPair {
  transport: Transport;
  peer: FakeDaemonPeer;
}

export function createFakeTransportPair(opts?: {
  /** Cause `connect()` to reject with this error on next attempt
   *  (one-shot — cleared after firing). Use to drive reconnect tests. */
  connectErrorOnce?: Error;
  /** When true, `connect()` resolves but the transport never appears
   *  connected; the very first frame to write will silently no-op so
   *  the client surfaces the failure as a `disconnected` error. */
  silentlyBroken?: boolean;
  /** Auto-answer HostClient.connect()'s hello gate without recording
   *  the request, keeping non-handshake tests focused on their own
   *  first user intent. Disable to test protocol negotiation failures. */
  autoHello?: boolean;
}): FakeTransportPair {
  const handlers: { [K in keyof TransportEvents]: Set<TransportEvents[K]> } = {
    frame: new Set(),
    disconnect: new Set(),
    overflow: new Set(),
  };
  let connected = false;
  let connectErrorOnce = opts?.connectErrorOnce ?? null;
  const silentlyBroken = opts?.silentlyBroken ?? false;
  const autoHello = opts?.autoHello ?? true;
  const received: RequestFrame[] = [];

  const transport: Transport = {
    async connect(): Promise<void> {
      if (connectErrorOnce) {
        const err = connectErrorOnce;
        connectErrorOnce = null;
        throw err;
      }
      connected = !silentlyBroken;
    },
    write(line: string): boolean {
      if (!connected) return false;
      try {
        const parsed = JSON.parse(line.trim());
        const validated = AnyFrameSchema.safeParse(parsed);
        if (validated.success && 'intent' in validated.data) {
          const request = validated.data as RequestFrame;
          if (autoHello && request.intent === 'hello') {
            const requestId = request.id;
            queueMicrotask(() => {
              if (!connected) return;
              for (const h of handlers.frame) {
                h({
                  id: requestId,
                  result: {
                    protocol_version: HOST_PROTOCOL_VERSION,
                    daemon_version: '0.0.0-test-daemon',
                    daemon_id: 'local',
                    instance_id: 'test-instance',
                    host_descriptor: { name: 'local', kind: 'local' },
                    capabilities: [...KNOWN_CAPABILITIES_V1],
                  },
                });
              }
            });
            return true;
          }
          received.push(request);
        }
      } catch {
        /* ignore malformed test input */
      }
      return true;
    },
    close(): void {
      if (!connected) return;
      connected = false;
      for (const h of handlers.disconnect) h('local_close');
    },
    on(event, handler) {
      (handlers[event] as Set<unknown>).add(handler);
      return () => {
        (handlers[event] as Set<unknown>).delete(handler);
      };
    },
    isConnected(): boolean {
      return connected;
    },
  };

  const peer: FakeDaemonPeer = {
    send(frame) {
      if (!connected) return;
      for (const h of handlers.frame) h(frame);
    },
    disconnect(reason = 'peer_disconnect') {
      if (!connected) return;
      connected = false;
      for (const h of handlers.disconnect) h(reason);
    },
    received,
  };
  return { transport, peer };
}
