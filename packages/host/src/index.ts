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
  ProtocolVersionMismatchError,
  type HostClientOptions,
  type HostClientLogger,
  type HostClientNegotiatedProtocol,
  type ProtocolVersionMismatchReason,
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
  HelloParamsSchema,
  HelloResultSchema,
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
  RequestFrameSchema,
  ResponseFrameSchema,
  intentSchemas,
  encodeFrame,
  splitNdjson,
  MAX_FRAME_BYTES,
  type IntentName,
  type IntentParams,
  type IntentResult,
  type HelloParams,
  type HelloResult,
  type KnownCapabilityV1,
  type RequestFrame,
  type ResponseFrame,
  type ResponseError,
  type EventFrame,
  type AnyFrame,
  type ConversationLogDebugParams,
  type ConversationLogDebugResult,
  type RuntimeStateDto,
  type RuntimeStartParams,
  type RuntimeStartResult,
  type RuntimeStopParams,
  type RuntimeStopResult,
  type RuntimeWakeParams,
  type RuntimeWakeResult,
  type RuntimeWakeReason,
  type RuntimeStatusParams,
  type RuntimeStatusResult,
  type RuntimeClearSessionParams,
  type RuntimeClearSessionResult,
  type RuntimeStopAllParams,
  type RuntimeStopAllResult,
  type RuntimeCloseActivityLogParams,
  type RuntimeCloseActivityLogResult,
  type RuntimeOutputPauseParams,
  type RuntimeOutputPauseResult,
  type RuntimeOutputResumeParams,
  type RuntimeOutputResumeResult,
} from './protocol.js';
export {
  OUTBOUND_DAEMON_EVENT_KINDS,
  OUTBOUND_PROTOCOL_VERSION,
  OUTBOUND_SERVER_COMMAND_KINDS,
  OutboundCommandErrorSchema,
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundHeartbeatPingFrameSchema,
  OutboundHeartbeatPongFrameSchema,
  OutboundReadyEventFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  RotateTokenParamsSchema,
  RotateTokenResultSchema,
  encodeOutboundFrame,
  outboundServerCommandSchemas,
  type OutboundCommandError,
  type OutboundDaemonEventKind,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundFrame,
  type OutboundHeartbeatFrame,
  type OutboundHeartbeatPingFrame,
  type OutboundHeartbeatPongFrame,
  type OutboundServerCommandKind,
  type OutboundServerToDaemonCommandFrame,
  type RotateTokenParams,
  type RotateTokenResult,
} from './outbound-protocol.js';
export { DAEMON_VERSION } from './daemon/version.js';
