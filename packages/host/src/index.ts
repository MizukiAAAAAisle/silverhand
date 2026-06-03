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
  type DaemonFatalExitInfo,
  type DaemonFatalExitKind,
  type DaemonGenerationInfo,
  type SpawnDaemonOptions,
} from './spawn.js';
export {
  AnyFrameSchema,
  EventFrameSchema,
  HelloParamsSchema,
  HelloResultSchema,
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
  LooseAnyFrameSchema,
  LooseResponseFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  intentErrorSchema,
  intentSchemas,
  encodeFrame,
  splitNdjson,
  MAX_FRAME_BYTES,
  type IntentName,
  type IntentParams,
  type IntentResult,
  type IntentError,
  type HelloParams,
  type HelloResult,
  type KnownCapabilityV1,
  type LooseAnyFrame,
  type LooseResponseFrame,
  type RequestFrame,
  type ResponseFrame,
  type ResponseError,
  type EventFrame,
  type AnyFrame,
  type ConversationLogDebugParams,
  type ConversationLogDebugResult,
  type HostStatusParams,
  type HostStatusResult,
  type RuntimeStateDto,
  type RuntimeStartParams,
  type RuntimeStartResult,
  type RuntimeStartErrorCode,
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
  type HostOutboundAttachParams,
  type HostOutboundAttachResult,
  type HostOutboundAttachFailureReason,
  type HostOutboundDetachParams,
  type HostOutboundDetachResult,
  type HostOutboundReloadParams,
  type HostOutboundReloadResult,
  type HostOutboundReloadFailureReason,
  type HostProxyConfig,
  type HostProxyConfigGetResult,
  type HostProxyConfigSetParams,
  type HostProxyConfigSetResult,
  type WorkspaceProvisionParams,
  type WorkspaceProvisionResult,
  type WorkspaceProvisionErrorCode,
  type AgentWorkspaceIndexParams,
  type AgentWorkspaceIndexResult,
  type AgentWorkspaceIndexEntry,
  type AgentWorkspaceIndexErrorCode,
  type AgentWorkspaceTreeParams,
  type AgentWorkspaceTreeResult,
  type AgentWorkspaceFileReadParams,
  type AgentWorkspaceFileReadResult,
  type AgentWorkspaceFsErrorCode,
  type AgentL2SeedParams,
  type AgentL2SeedResult,
  type AgentL2SeedErrorCode,
  type AgentFilesPurgeParams,
  type AgentFilesPurgeResult,
  type AgentFilesPurgeErrorCode,
} from './protocol.js';
export {
  OUTBOUND_DAEMON_EVENT_KINDS,
  OUTBOUND_PROTOCOL_VERSION,
  OUTBOUND_SERVER_COMMAND_KINDS,
  AgentMaterializeErrorCodeSchema,
  AgentMaterializeParamsSchema,
  AgentMaterializeResultSchema,
  AgentMaterializeWireErrorSchema,
  RuntimeStartWireErrorSchema,
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
  type AgentMaterializeErrorCode,
  type AgentMaterializeParams,
  type AgentMaterializeResult,
  type AgentMaterializeWireError,
  type RuntimeStartWireError,
  type OutboundCommandError,
  type OutboundDaemonEventKind,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundFrame,
  type OutboundHeartbeatFrame,
  type OutboundHeartbeatPingFrame,
  type OutboundHeartbeatPongFrame,
  type OutboundServerCommandError,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type OutboundServerToDaemonCommandFrame,
  type RotateTokenParams,
  type RotateTokenResult,
} from './outbound-protocol.js';
export { DAEMON_VERSION } from './daemon/version.js';
/**
 * D5.a-2 — daemon-side local outbound frame server + its default socket
 * path helper. The embedded backend (D5.a-3) starts the daemon with
 * `localOutboundSocketPath = deriveLocalOutboundFrameSocketPath()` and
 * dials it with `EmbeddedUnixOutboundFrameAdapter`, so embedded and
 * standalone share the one outbound frame envelope. The class is exported
 * for the host-side unit test; the path helper for backend wiring.
 */
export {
  LocalOutboundFrameServer,
  deriveLocalOutboundFrameSocketPath,
  type LocalOutboundFrameServerOptions,
} from './daemon/local-outbound-frame-server.js';
/**
 * D4.d D6 — re-export the daemon-side typed materialize error so
 * e2e tests that inject a deterministic typed-error fault via
 * `runDaemon`'s `testHooks.agentMaterializeFaultInjector` can
 * construct the typed instance the dispatcher narrows to a wire
 * `error.code` (per `dispatcher.ts` line 328); without a public
 * export, the only way to land on that branch would be to reach
 * into the internal subtree, which the
 * `dependency-guard-agent-materialize.test.ts` tripwire blocks
 * for backend code.
 *
 * Boundary: this export does NOT re-expose `materializeAgent`,
 * `getAgentHomeTemplate`, or any other implementation detail of
 * the agent-home subtree — only the throwable error class that's
 * part of the daemon ↔ embedder/test contract. Cindy D6-2 P1-1
 * (`d4IID_Nnn1VShRa5`): the only test-facing surface on
 * `RunDaemonOptions` is the narrow `testHooks` namespace; there
 * is no embedder-facing handler-replacement option.
 */
export { AgentMaterializeError } from './daemon/agent-materialize/index.js';
