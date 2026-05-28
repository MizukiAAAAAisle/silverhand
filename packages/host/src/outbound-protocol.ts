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
  RuntimeKindSchema,
} from '@silverhand/shared';
import {
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

// ── D4.d: agent_materialize (server↔daemon formal semantics) ──────
//
// Unlike the rest of the server↔daemon commands in this catalogue,
// `agent_materialize` is NOT a control-plane / supervisor message —
// it IS the formal semantics for creating an agent's L1 home on the
// daemon-owning host. The route `POST /api/agents` reserves an
// `agents` row in `materialization_status='pending_materialization'`
// and then sends this intent over the same outbound WS that carries
// runtime_* frames; the daemon's handler creates `agent_dir` (which
// is also the DM workspace path, see design §6.5 / §8) and writes
// the agent-home bootstrap (system_prompt + MEMORY + notes/ +
// .materialized sentinel) before acking. Daemon-side idempotency
// (§4.6) uses the sentinel to distinguish "same agent_id seen
// before, already materialized" (idempotent ok) from "agent_dir
// pre-populated by something else" (`agent_dir_collision` error).
//
// See docs/remote-backend-d4d-design.md §3.1 / §6 / §8 for the
// design contract. This schema is additive under the R4 acceptance
// gate (Cindy I1 / round-2 review): same outbound envelope, no
// protocol fork.

export const AgentMaterializeParamsSchema = z
  .object({
    /**
     * Server-allocated; base64url 16-char string from
     * randomBytes(12).toString('base64url')
     * (packages/backend/src/repos/agent-repo.ts).
     * Schema-level validation is intentionally loose
     * (`min(1)`); the route layer is responsible for tighter
     * format checks. Cindy round-2 P1 #5.
     */
    agent_id: z.string().min(1),
    /**
     * Server-allocated; follows the existing helper
     * `agentHomeWorkspaceId(agentId)` → `wsah_<agentId>`.
     */
    agent_home_workspace_id: z.string().min(1),
    name: z.string().min(1).max(64),
    runtime: RuntimeKindSchema,
    model: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    /**
     * Template choice for the agent-home bootstrap (system_prompt,
     * MEMORY.md, notes/ skeleton). Defaults to 'default' for first
     * cut; richer choices land with D2.
     */
    template_choice: z
      .enum(['default', 'onboarding', 'minimal'])
      .default('default'),
  })
  .strict();
export type AgentMaterializeParams = z.infer<typeof AgentMaterializeParamsSchema>;

export const AgentMaterializeResultSchema = z
  .object({
    ok: z.literal(true),
    /**
     * Absolute path to the materialized agent home / L1 dir,
     * daemon-side. The server never inspects what the daemon
     * wrote here — `agent_dir` is opaque from the server's
     * perspective.
     */
    agent_dir: z.string().min(1),
    /**
     * MUST equal `agent_dir`. Per `docs/agent-system-prompt-memory.md`
     * and CLAUDE.md §3, the DM workspace path coincides with L1
     * (`agent_home` workspace's `workspace_path` IS the agent's L1
     * dir). The daemon returns the same string for both fields to
     * make this invariant explicit on the wire — the server uses
     * `agent_home_workspace_path` verbatim when it INSERTs the
     * `agent_home` workspace row (see design §6.5).
     */
    agent_home_workspace_path: z.string().min(1),
    /**
     * Opaque-to-server timestamp used only for audit. The row's
     * `created_at` remains the server's authoritative time.
     */
    materialized_at: z.number().int().positive(),
  })
  .strict();
export type AgentMaterializeResult = z.infer<typeof AgentMaterializeResultSchema>;

/**
 * Typed error codes returned by the daemon's `agent_materialize`
 * handler. The HTTP-layer wrapper in `POST /api/agents` adds
 * server-side codes (materialize_timeout, host_attach_pending,
 * dependent_row_insert_failed, backend_crash_during_materialize)
 * that never appear on the wire — they describe failures the
 * server observes locally. See design §3.4 for the
 * wire→HTTP mapping table.
 */
export const AgentMaterializeErrorCodeSchema = z.enum([
  'fs_quota_exceeded',
  'fs_unavailable',
  /**
   * `agent_dir_collision` (not `already_exists`): the dir is
   * unexpectedly populated by foreign content without the
   * `.materialized` sentinel. Idempotent re-call of an
   * already-materialized `agent_id` returns `ok: true` and is NOT
   * an error.
   */
  'agent_dir_collision',
  'unsupported_template',
  'unsupported_runtime',
  'internal_error',
]);
export type AgentMaterializeErrorCode = z.infer<
  typeof AgentMaterializeErrorCodeSchema
>;

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
 * typed daemon-business errors (currently just `agent_materialize`)
 * override with their own wider schema.
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
