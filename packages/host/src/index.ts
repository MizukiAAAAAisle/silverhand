/**
 * `@silverhand/host` — public surface.
 *
 * Two consumers:
 *
 *  - Backend / Electron main / dev:headless launcher: import the
 *    client and the spawn helper. They never need to know how the
 *    daemon parses argv or how it lays out its pid file.
 *
 *  - Tests + future remote-host adapters: import the protocol
 *    schemas so they can construct request/response frames without
 *    duplicating the wire format.
 *
 * The daemon entry script lives at `./daemon/entry.ts` and is NOT
 * re-exported here — it's a process, not a library. Anything that
 * needs to spawn it does so through `spawnDaemonChild`.
 */
export {
  HostClient,
  HostClientError,
  type HostClientOptions,
  type HostClientLogger,
} from './client/index.js';
export { SocketTransport } from './client/socket-transport.js';
export type { Transport, TransportEvents, DecodedFrame } from './client/transport.js';
export {
  spawnDaemonChild,
  type DaemonLauncher,
  type DaemonHandle,
  type SpawnDaemonOptions,
} from './spawn.js';
export {
  AnyFrameSchema,
  EventFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  intentSchemas,
  encodeFrame,
  splitNdjson,
  MAX_FRAME_BYTES,
  type IntentName,
  type IntentParams,
  type IntentResult,
  type RequestFrame,
  type ResponseFrame,
  type ResponseError,
  type EventFrame,
  type AnyFrame,
} from './protocol.js';
export { DAEMON_VERSION } from './daemon/version.js';
