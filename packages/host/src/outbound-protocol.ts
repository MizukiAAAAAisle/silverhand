/**
 * D2 daemon-outbound WebSocket protocol.
 *
 * This is the wire contract for the long-lived connection opened by
 * the desktop-local daemon to the server at `/api/hosts/connect`.
 * It deliberately reuses the existing runtime intent schemas from
 * `protocol.ts`; D2 adds a transport envelope and host-token rotation,
 * not a second runtime vocabulary.
 *
 * Envelope rule:
 *   - `direction` is the outer discriminator.
 *   - `type` separates command / command_response / event / heartbeat frames.
 *   - `kind` is scoped by `type`; server commands and daemon events
 *     are separate catalogues.
 */
import { z } from 'zod';
import {
  AgentRunStateSchema,
  ParsedEventKindSchema,
  ParsedEventSchema,
} from '@silverhand/shared';
import {
  AgentMaterializeErrorCodeSchema,
  AgentMaterializeParamsSchema,
  AgentMaterializeResultSchema,
  AgentWorkspaceIndexErrorCodeSchema,
  AgentWorkspaceIndexParamsSchema,
  AgentWorkspaceIndexResultSchema,
  AgentWorkspaceReadErrorCodeSchema,
  AgentWorkspaceReadParamsSchema,
  AgentWorkspaceReadResultSchema,
  AgentL2SeedErrorCodeSchema,
  AgentL2SeedParamsSchema,
  AgentL2SeedResultSchema,
  HelloResultSchema,
  MAX_FRAME_BYTES,
  ResponseErrorSchema,
  RuntimeClearSessionParamsSchema,
  RuntimeClearSessionResultSchema,
  RuntimeCloseActivityLogParamsSchema,
  RuntimeCloseActivityLogResultSchema,
  RuntimeOutputPauseParamsSchema,
  RuntimeOutputPauseResultSchema,
  RuntimeOutputResumeParamsSchema,
  RuntimeOutputResumeResultSchema,
  RuntimeStartParamsSchema,
  RuntimeStartResultSchema,
  RuntimeStatusParamsSchema,
  RuntimeStatusResultSchema,
  RuntimeStopAllParamsSchema,
  RuntimeStopAllResultSchema,
  RuntimeStopParamsSchema,
  RuntimeStopResultSchema,
  RuntimeWakeParamsSchema,
  RuntimeWakeResultSchema,
  WorkspaceProvisionErrorCodeSchema,
  WorkspaceProvisionParamsSchema,
  WorkspaceProvisionResultSchema,
} from './protocol.js';

// D4.d D2: agent_materialize schemas live in `protocol.ts` so the
// daemon's IPC `intentSchemas` catalogue can validate them through
// the same path as every other intent. We re-export from this file
// to keep the wire surface coherent (callers who only deal with
// outbound WS frames still see them here).
export {
  AgentMaterializeErrorCodeSchema,
  AgentMaterializeParamsSchema,
  AgentMaterializeResultSchema,
  type AgentMaterializeErrorCode,
  type AgentMaterializeParams,
  type AgentMaterializeResult,
} from './protocol.js';

// D4.e-1: workspace_provision + agent_workspace_index schemas also live
// in `protocol.ts` (same IPC-catalogue reason as agent_materialize);
// re-exported here so outbound-WS callers see them. D4.e-2 adds
// agent_workspace_read; D4.e-3 adds agent_l2_seed (same reason).
export {
  WorkspaceProvisionParamsSchema,
  WorkspaceProvisionResultSchema,
  WorkspaceProvisionErrorCodeSchema,
  AgentWorkspaceIndexParamsSchema,
  AgentWorkspaceIndexResultSchema,
  AgentWorkspaceIndexErrorCodeSchema,
  AgentWorkspaceReadParamsSchema,
  AgentWorkspaceReadResultSchema,
  AgentWorkspaceReadErrorCodeSchema,
  AgentL2SeedParamsSchema,
  AgentL2SeedResultSchema,
  AgentL2SeedErrorCodeSchema,
  type WorkspaceProvisionParams,
  type WorkspaceProvisionResult,
  type WorkspaceProvisionErrorCode,
  type AgentWorkspaceIndexParams,
  type AgentWorkspaceIndexResult,
  type AgentWorkspaceIndexErrorCode,
  type AgentWorkspaceReadParams,
  type AgentWorkspaceReadResult,
  type AgentWorkspaceReadErrorCode,
  type AgentL2SeedParams,
  type AgentL2SeedResult,
  type AgentL2SeedErrorCode,
} from './protocol.js';

const FrameIdSchema = z.string().min(1);

export const OUTBOUND_PROTOCOL_VERSION = 1;

// ── server → daemon command catalogue ──────────────────────────────

export const RotateTokenParamsSchema = z
  .object({
    host_id: z.string().min(1),
    host_token: z.string().min(1),
    /** Epoch ms when the server issued this replacement token. */
    issued_at: z.number().int().nonnegative(),
    /** Epoch ms until which the previous token remains valid. */
    grace_until: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.grace_until <= value.issued_at) {
      ctx.addIssue({
        code: 'custom',
        path: ['grace_until'],
        message: 'grace_until must be after issued_at',
      });
    }
  });
export type RotateTokenParams = z.infer<typeof RotateTokenParamsSchema>;

export const RotateTokenResultSchema = z.discriminatedUnion('rotated', [
  z
    .object({
      rotated: z.literal(true),
      host_id: z.string().min(1),
      /** Epoch ms after daemon atomically refreshed daemon-config.json. */
      config_refreshed_at: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      rotated: z.literal(false),
      reason: z.enum(['host_mismatch', 'invalid_config', 'write_failed']),
      message: z.string().optional(),
    })
    .strict(),
]);
export type RotateTokenResult = z.infer<typeof RotateTokenResultSchema>;

/**
 * Per-command error schema for `agent_materialize` (D4.d D1).
 *
 * Daemon-side typed errors travel in the response frame's `error`
 * slot, just like the five generic transport-level codes from
 * `ResponseErrorSchema`. The wire union accepts EITHER set so the
 * daemon handler can return e.g. `internal_error` (generic) OR
 * `agent_dir_collision` (command-specific). Per-route mapping in
 * §3.4 translates wire codes to HTTP.
 *
 * Scoped per-command (not global) so other commands (runtime_* /
 * rotate_token) do NOT accidentally accept `agent_dir_collision`
 * in their error arm — that was the Cindy D1 round-1 P1 failure
 * mode: a global union widened every command's error surface.
 */
export const AgentMaterializeWireErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorSchema.shape.code,
      AgentMaterializeErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();
export type AgentMaterializeWireError = z.infer<
  typeof AgentMaterializeWireErrorSchema
>;

/**
 * Per-command wire error schemas for the D4.e data-plane intents.
 * Each widens the 5 generic transport codes with ONLY its own taxonomy
 * (per-command scoping — Cindy D1 round-1 P1): a typed code from one
 * command cannot leak onto another's error arm.
 */
export const WorkspaceProvisionWireErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorSchema.shape.code,
      WorkspaceProvisionErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();
export type WorkspaceProvisionWireError = z.infer<
  typeof WorkspaceProvisionWireErrorSchema
>;

export const AgentWorkspaceIndexWireErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorSchema.shape.code,
      AgentWorkspaceIndexErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();
export type AgentWorkspaceIndexWireError = z.infer<
  typeof AgentWorkspaceIndexWireErrorSchema
>;

export const AgentWorkspaceReadWireErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorSchema.shape.code,
      AgentWorkspaceReadErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();
export type AgentWorkspaceReadWireError = z.infer<
  typeof AgentWorkspaceReadWireErrorSchema
>;

export const AgentL2SeedWireErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorSchema.shape.code,
      AgentL2SeedErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();
export type AgentL2SeedWireError = z.infer<
  typeof AgentL2SeedWireErrorSchema
>;

/**
 * Source of truth for D2 server-issued commands. The runtime_* entries
 * are the D2.0 request surface; rotate_token is D2.f's transport-local
 * credential refresh command. Each entry pins (a) the params shape,
 * (b) the success-result shape, and (c) the WIRE ERROR shape — the
 * error arm in the response frame is built from `error` rather than
 * a single global error schema, so command-specific typed codes
 * cannot leak across kinds (Cindy D1 round-1 P1).
 *
 * Default `error` is `ResponseErrorSchema` (the five generic
 * transport-level codes). Commands that may legitimately surface
 * typed daemon-business errors (`agent_materialize` plus the D4.e
 * workspace data-plane commands `workspace_provision` /
 * `agent_workspace_index` / `agent_workspace_read` / `agent_l2_seed`) override with their
 * own wider schema.
 */
export const outboundServerCommandSchemas = {
  runtime_start: {
    params: RuntimeStartParamsSchema,
    result: RuntimeStartResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_stop: {
    params: RuntimeStopParamsSchema,
    result: RuntimeStopResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_wake: {
    params: RuntimeWakeParamsSchema,
    result: RuntimeWakeResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_status: {
    params: RuntimeStatusParamsSchema,
    result: RuntimeStatusResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_clear_session: {
    params: RuntimeClearSessionParamsSchema,
    result: RuntimeClearSessionResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_stop_all: {
    params: RuntimeStopAllParamsSchema,
    result: RuntimeStopAllResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_close_activity_log: {
    params: RuntimeCloseActivityLogParamsSchema,
    result: RuntimeCloseActivityLogResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_output_pause: {
    params: RuntimeOutputPauseParamsSchema,
    result: RuntimeOutputPauseResultSchema,
    error: ResponseErrorSchema,
  },
  runtime_output_resume: {
    params: RuntimeOutputResumeParamsSchema,
    result: RuntimeOutputResumeResultSchema,
    error: ResponseErrorSchema,
  },
  rotate_token: {
    params: RotateTokenParamsSchema,
    result: RotateTokenResultSchema,
    error: ResponseErrorSchema,
  },
  agent_materialize: {
    params: AgentMaterializeParamsSchema,
    result: AgentMaterializeResultSchema,
    error: AgentMaterializeWireErrorSchema,
  },
  workspace_provision: {
    params: WorkspaceProvisionParamsSchema,
    result: WorkspaceProvisionResultSchema,
    error: WorkspaceProvisionWireErrorSchema,
  },
  agent_workspace_index: {
    params: AgentWorkspaceIndexParamsSchema,
    result: AgentWorkspaceIndexResultSchema,
    error: AgentWorkspaceIndexWireErrorSchema,
  },
  agent_workspace_read: {
    params: AgentWorkspaceReadParamsSchema,
    result: AgentWorkspaceReadResultSchema,
    error: AgentWorkspaceReadWireErrorSchema,
  },
  agent_l2_seed: {
    params: AgentL2SeedParamsSchema,
    result: AgentL2SeedResultSchema,
    error: AgentL2SeedWireErrorSchema,
  },
} as const;

export type OutboundServerCommandKind = keyof typeof outboundServerCommandSchemas;
export type OutboundServerCommandParams<K extends OutboundServerCommandKind> =
  z.infer<(typeof outboundServerCommandSchemas)[K]['params']>;
export type OutboundServerCommandResult<K extends OutboundServerCommandKind> =
  z.infer<(typeof outboundServerCommandSchemas)[K]['result']>;
export type OutboundServerCommandError<K extends OutboundServerCommandKind> =
  z.infer<(typeof outboundServerCommandSchemas)[K]['error']>;

export const OUTBOUND_SERVER_COMMAND_KINDS = Object.keys(
  outboundServerCommandSchemas,
) as OutboundServerCommandKind[];

const serverCommandFrameOptions = OUTBOUND_SERVER_COMMAND_KINDS.map(kind =>
  z
    .object({
      direction: z.literal('server_to_daemon'),
      type: z.literal('command'),
      id: FrameIdSchema,
      kind: z.literal(kind),
      params: outboundServerCommandSchemas[kind].params,
    })
    .strict(),
) as unknown as [
  z.ZodDiscriminatedUnionOption<'kind'>,
  ...z.ZodDiscriminatedUnionOption<'kind'>[],
];

export const OutboundServerToDaemonCommandFrameSchema = z.discriminatedUnion(
  'kind',
  serverCommandFrameOptions,
);

export type OutboundServerToDaemonCommandFrame = z.infer<
  typeof OutboundServerToDaemonCommandFrameSchema
>;

// ── daemon → server command responses ──────────────────────────────

/**
 * Aggregate wire error type for any outbound command response.
 *
 * Kept for callers that need a type covering "an error in any
 * response frame, regardless of kind" (e.g., the supervisor's
 * fallback / drift path). It is the union of every per-command
 * error schema — NOT a single schema used for all command arms.
 * The actual response frames use `outboundServerCommandSchemas[kind].error`
 * so command-specific codes are scoped per kind.
 */
export type OutboundCommandError = {
  [K in OutboundServerCommandKind]: OutboundServerCommandError<K>;
}[OutboundServerCommandKind];

const commandResponseFrameOptions = OUTBOUND_SERVER_COMMAND_KINDS.flatMap(kind => [
  z
    .object({
      direction: z.literal('daemon_to_server'),
      type: z.literal('command_response'),
      id: FrameIdSchema,
      kind: z.literal(kind),
      result: outboundServerCommandSchemas[kind].result,
    })
    .strict(),
  z
    .object({
      direction: z.literal('daemon_to_server'),
      type: z.literal('command_response'),
      id: FrameIdSchema,
      kind: z.literal(kind),
      error: outboundServerCommandSchemas[kind].error,
    })
    .strict(),
]) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];

export const OutboundDaemonToServerCommandResponseFrameSchema = z.union(
  commandResponseFrameOptions,
);
export type OutboundDaemonToServerCommandResponseFrame = z.infer<
  typeof OutboundDaemonToServerCommandResponseFrameSchema
>;

// ── heartbeat frames ───────────────────────────────────────────────

const HeartbeatTimestampSchema = z.number().int().nonnegative();

export const OutboundHeartbeatPingFrameSchema = z
  .object({
    direction: z.enum(['server_to_daemon', 'daemon_to_server']),
    type: z.literal('heartbeat'),
    kind: z.literal('ping'),
    ts: HeartbeatTimestampSchema,
  })
  .strict();
export type OutboundHeartbeatPingFrame = z.infer<
  typeof OutboundHeartbeatPingFrameSchema
>;

export const OutboundHeartbeatPongFrameSchema = z
  .object({
    direction: z.enum(['server_to_daemon', 'daemon_to_server']),
    type: z.literal('heartbeat'),
    kind: z.literal('pong'),
    ts: HeartbeatTimestampSchema,
    echo_ts: HeartbeatTimestampSchema,
  })
  .strict();
export type OutboundHeartbeatPongFrame = z.infer<
  typeof OutboundHeartbeatPongFrameSchema
>;

export const OutboundHeartbeatFrameSchema = z.discriminatedUnion('kind', [
  OutboundHeartbeatPingFrameSchema,
  OutboundHeartbeatPongFrameSchema,
]);
export type OutboundHeartbeatFrame = z.infer<typeof OutboundHeartbeatFrameSchema>;

// ── daemon → server event catalogue ────────────────────────────────

export const OutboundReadyEventFrameSchema = HelloResultSchema.extend({
  direction: z.literal('daemon_to_server'),
  type: z.literal('event'),
  kind: z.literal('ready'),
  protocol_version: z.literal(OUTBOUND_PROTOCOL_VERSION),
  daemon_pid: z.number().int(),
  started_at: z.number().int(),
}).strict();

export const OutboundShuttingDownEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('shutting_down'),
    reason: z.string(),
  })
  .strict();

export const OutboundRuntimeStateEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_state'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    state: AgentRunStateSchema,
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeOutputEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_output'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string(),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeExitEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_exit'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    code: z.number().int().nullable(),
    intentional: z.boolean(),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeReadyForDrainEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_ready_for_drain'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeStartupDeliveryConsumedEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_startup_delivery_consumed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeStartupDeliveryFailedEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_startup_delivery_failed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    reason: z.enum([
      'child_exit',
      'init_watchdog',
      'write_failed',
      'driver_refused',
    ]),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeInitTimeoutEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_init_timeout'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    timeout_reason: z.enum(['silence', 'pre_protocol_cap', 'post_protocol']),
    elapsed_ms: z.number().int().nonnegative(),
    timeout_ms: z.number().int().nonnegative(),
    retrying: z.boolean(),
    retry_attempt: z.number().int().nonnegative(),
    max_retries: z.number().int().nonnegative(),
    cooldown_until: z.number().int().positive().optional(),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeInitRetryingEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_init_retrying'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    retry_attempt: z.number().int().positive(),
    max_retries: z.number().int().nonnegative(),
    delay_ms: z.number().int().nonnegative(),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeInitCooldownEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_init_cooldown'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    cooldown_until: z.number().int().positive(),
    attempts_exhausted: z.number().int().nonnegative(),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeCompactionStaleEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_compaction_stale'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    elapsed_ms: z.number().int().nonnegative(),
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeOutputDroppedEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_output_dropped'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    dropped_count: z.number().int().nonnegative(),
    bytes_dropped: z.number().int().nonnegative(),
    since_ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeOutputPausedEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_output_paused'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();

export const OutboundRuntimeOutputResumedEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_output_resumed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();

export const OutboundRuntimeParsedEventFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_parsed_event'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    parsed: ParsedEventSchema,
    ts: z.number().int(),
  })
  .strict();

export const OutboundRuntimeParsedEventDroppedFrameSchema = z
  .object({
    direction: z.literal('daemon_to_server'),
    type: z.literal('event'),
    kind: z.literal('runtime_parsed_event_dropped'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    parsed_kind: ParsedEventKindSchema,
    encoded_bytes: z.number().int().nonnegative(),
    reason: z.literal('frame_too_large'),
    ts: z.number().int(),
  })
  .strict();

export const OutboundDaemonToServerEventFrameSchema = z.discriminatedUnion('kind', [
  OutboundReadyEventFrameSchema,
  OutboundShuttingDownEventFrameSchema,
  OutboundRuntimeStateEventFrameSchema,
  OutboundRuntimeOutputEventFrameSchema,
  OutboundRuntimeExitEventFrameSchema,
  OutboundRuntimeReadyForDrainEventFrameSchema,
  OutboundRuntimeStartupDeliveryConsumedEventFrameSchema,
  OutboundRuntimeStartupDeliveryFailedEventFrameSchema,
  OutboundRuntimeInitTimeoutEventFrameSchema,
  OutboundRuntimeInitRetryingEventFrameSchema,
  OutboundRuntimeInitCooldownEventFrameSchema,
  OutboundRuntimeCompactionStaleEventFrameSchema,
  OutboundRuntimeOutputDroppedEventFrameSchema,
  OutboundRuntimeOutputPausedEventFrameSchema,
  OutboundRuntimeOutputResumedEventFrameSchema,
  OutboundRuntimeParsedEventFrameSchema,
  OutboundRuntimeParsedEventDroppedFrameSchema,
]);

export type OutboundDaemonToServerEventFrame = z.infer<
  typeof OutboundDaemonToServerEventFrameSchema
>;

export type OutboundDaemonEventKind = OutboundDaemonToServerEventFrame['kind'];

export const OUTBOUND_DAEMON_EVENT_KINDS = OutboundDaemonToServerEventFrameSchema
  .options.map(option => option.shape.kind.value) as OutboundDaemonEventKind[];

export const OutboundFrameSchema = z.union([
  OutboundServerToDaemonCommandFrameSchema,
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
]);
export type OutboundFrame = z.infer<typeof OutboundFrameSchema>;

export function encodeOutboundFrame(frame: OutboundFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(`encoded outbound frame exceeds MAX_FRAME_BYTES=${MAX_FRAME_BYTES}`);
  }
  return line;
}
