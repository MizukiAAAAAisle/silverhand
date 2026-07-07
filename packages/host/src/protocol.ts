/**
 * Wire protocol between `silverhand-daemon` (process boundary) and
 * `HostClient` (callers inside `backend` / `electron main`).
 *
 * Why this is its own module (and not buried inside `client` or
 * `daemon`): the wire format is the contract. Two sides of an IPC
 * cannot share TypeScript types but a different parser — the only way
 * to keep them honest is to make the schema the single source of truth
 * that both sides import. This file MUST stay free of node:net /
 * node:child_process / fs imports so it can be unit-tested as a pure
 * encode/decode.
 *
 * ## Authority layering
 *
 * Two layers govern the contract — they are NOT redundant:
 *
 *   1. **This file (zod schemas)** — authoritative for what *shape*
 *      a frame may have. TypeScript daemon and TypeScript clients
 *      import these directly.
 *   2. **`tests/fixtures/wire/wire-fixtures.ts` (NDJSON byte
 *      fixtures)** — authoritative for what *bytes* a valid frame
 *      looks like on the socket. Locks the contract at the byte
 *      level so future re-implementations (Rust daemon, remote host
 *      agent, etc.) have an acceptance gate that does not depend on
 *      zod. See `tests/fixtures/wire/README.md` for the consumer
 *      recipe.
 *
 * When zod and the fixture catalogue disagree, the disagreement is a
 * bug — fix it in the same change. Adding a new schema arm here
 * without adding a fixture variant leaves cross-language consumers
 * blind to the new shape; adding a fixture without widening the
 * schema leaves the TS daemon refusing its own canonical wire bytes.
 *
 * ## Framing
 *
 * Newline-delimited JSON over a duplex byte stream. One JSON object
 * per `\n`-terminated chunk. Both sides decode by buffering bytes,
 * splitting on `\n`, and JSON.parse'ing each frame. We do NOT use
 * length-prefixed framing because (a) the message sizes for PR-1's
 * intent surface are < 1KB each and (b) NDJSON gives us trivial
 * tail-of-log debuggability.
 *
 * ## Three frame shapes
 *
 * - **Request** (`client → daemon`): correlation id + intent name + params.
 * - **Response** (`daemon → client`): same correlation id + result OR
 *   typed error.
 * - **Event** (`daemon → client`, unsolicited): no correlation id;
 *   discriminated by `event` field. PR-1 only emits `ready` (on
 *   socket bind) and `shutting_down` (on SIGTERM/SIGINT). Future
 *   PRs add `runtime_state` events here.
 *
 * Request ids are correlation handles, not security tokens — generated
 * by the client side via `randomBytes`. The daemon echoes them back on
 * the matching response so multiple in-flight requests on one socket
 * can be demultiplexed.
 */
import { z } from 'zod';
import {
  AgentRunStateSchema,
  AgentSendStaleResolutionReasonSchema,
  AgentWorkspaceFileReadSchema,
  AgentWorkspaceTreeSchema,
  ConversationKindSchema,
  HostProxyConfigSchema as SharedHostProxyConfigSchema,
  HostKindSchema,
  McpProbeResultSchema,
  MemberDtoSchema,
  ParsedEventKindSchema,
  ParsedEventSchema,
  ReasoningEffortSchema,
  RuntimeCatalogResponseSchema,
  RuntimeKindSchema,
  SendMessageTargetSchema,
  WorkspaceKindSchema,
} from '@silverhand/shared';

// ── Protocol handshake ─────────────────────────────────────────────
//
// Bumping the protocol version is a compatibility event, not a
// package-version bump: clients fail loud during `hello` if the daemon
// speaks a different version.
//
// v2 (reply-cluster §6.4): `runtime_start.startup_delivery.deliveries`,
// `runtime_wake.deliveries`, and the new `agent_stream_observed` intent were
// added to the strict command surface. A v1 daemon strict-parses the new keys
// as unknown and rejects the command (and has no handler for the new intent),
// so the version MUST gate at hello rather than silently breaking business
// commands. `agent_stream_observed` lands in the SAME v2 surface (it was added
// before v2 shipped to any deployment) — no further bump.
//
// v3 (#task:1063): `agent_message_send.target` became the public stream
// identity object (`{kind:'channel'}` / `{kind:'thread', message_id}`).
// Older v2 daemons would strict-reject the new object at business-command time,
// so this must also fail loud during hello.

export const HOST_PROTOCOL_VERSION = 3;

export const KNOWN_CAPABILITIES_V1 = [
  'runtime.claude',
  'runtime.codex',
  'runtime.cursor',
  'runtime.qoder',
  'transport.unix_socket',
  'fs.local',
  'proxy.env_inherit',
  'agent.freshness_authority',
] as const;
export type KnownCapabilityV1 = typeof KNOWN_CAPABILITIES_V1[number];

export const HelloParamsSchema = z.object({}).strict();
export type HelloParams = z.infer<typeof HelloParamsSchema>;

export const HelloResultSchema = z
  .object({
    protocol_version: z.number().int().positive(),
    daemon_version: z.string(),
    /**
     * Stable daemon-installation identity. For the bootstrap local
     * daemon this is `local`; future multi-daemon installs will each
     * report their own durable daemon_id.
     */
    daemon_id: z.string().min(1),
    /**
     * Ephemeral process-generation identity. Changes on every daemon
     * boot and lets backend drop stale per-daemon runtime snapshots
     * without confusing that with daemon placement.
     */
    instance_id: z.string().min(1),
    /**
     * Human-readable host claim. This is display / registry input,
     * not a placement policy by itself; placement must also consider
     * capabilities and backend-side assignment.
     */
    host_descriptor: z
      .object({
        name: z.string().min(1),
        kind: HostKindSchema,
      })
      .strict(),
    /**
     * Deliberately `string[]`, not an enum. Unknown capabilities must
     * remain wire-valid so older clients can ignore future daemon
     * feature flags instead of rejecting the whole handshake.
     */
    capabilities: z.array(z.string()),
  })
  .strict();
export type HelloResult = z.infer<typeof HelloResultSchema>;

// ── Intent registry ─────────────────────────────────────────────────
//
// PR-1 intent surface is intentionally tiny: hello gates protocol
// compatibility, then ping/status/echo prove the IPC carries
// structured payloads, plumbs lifecycle, and supports reconnect.
// PR-2 expands this with the runtime_* family that the
// design lock at `docs/remote-backend-architecture-notes.md §5` describes.
//
// PR-2 step 1 lands the wire schemas here PLUS a daemon-internal fake
// supervisor that satisfies the contract without doing any real
// process spawn. Step 2 wires the supervisor to the real
// ConversationManager execution-plane code carved out of
// `packages/backend/src/conversation-manager.ts`. Both steps share
// THIS file as the single source of truth — drift between client and
// daemon is impossible because both import from one registry.
//
// Naming convention: every PR-2 intent / event prefixes with
// `runtime_` so they are visually distinct from PR-1's
// hello / ping / status / echo lifecycle intents. The split is deliberate:
// runtime_* talk to a (conversation, agent) supervised process;
// PR-1 lifecycle intents talk to the daemon as a whole.

export const PingParamsSchema = z.object({}).strict();
export type PingParams = z.infer<typeof PingParamsSchema>;

export const PingResultSchema = z.object({
  pong: z.literal(true),
  daemon_pid: z.number().int(),
  daemon_version: z.string(),
  /** Epoch ms when the daemon process bound its socket. */
  started_at: z.number().int(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

export const StatusParamsSchema = z.object({}).strict();
export type StatusParams = z.infer<typeof StatusParamsSchema>;

export const StatusResultSchema = z.object({
  daemon_pid: z.number().int(),
  daemon_version: z.string(),
  started_at: z.number().int(),
  uptime_ms: z.number().int(),
  /** Number of intents the daemon has handled this lifetime. Useful
   *  for asserting reconnect tests actually re-issued requests. */
  intent_count: z.number().int(),
  /** Reserved for PR-2: list of currently-tracked (conversation,
   *  agent) runtime intents. Empty in PR-1. */
  runtimes: z.array(z.unknown()),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const EchoParamsSchema = z
  .object({
    message: z.string(),
  })
  .strict();
export type EchoParams = z.infer<typeof EchoParamsSchema>;

export const EchoResultSchema = z
  .object({
    echoed: z.string(),
  })
  .strict();
export type EchoResult = z.infer<typeof EchoResultSchema>;

// ── host_status (outbound command, #task:808) ────────────────────────
//
// Server → daemon RPC powering `GET /api/hosts/:id/status`. Distinct
// from the local inbound `status` intent — that one is HostClient
// (backend/test) → daemon-on-local-socket; this one rides the same
// `outboundServerCommandSchemas` channel as `runtime_start` / etc., so
// backend can dispatch it for ANY host (embedded local, future remote
// sandbox) through `OutboundFrameAdapter.sendCommand(hostId, ...)`.
//
// Payload is host-facts only: OS, architecture, daemon process info,
// uptime, plus the active agent_id set (which agents are currently
// spawned on this host). Backend joins that set against the
// registration table (`agents.host_id == hostId`) to enrich the
// per-row `online` flag in `AgentOnHostDto`. The daemon NEVER
// references agent names, conversation ids, or any other backend-
// owned semantic — those live above the host boundary.
export const HostStatusParamsSchema = z.object({}).strict();
export type HostStatusParams = z.infer<typeof HostStatusParamsSchema>;

export const HostStatusResultSchema = z
  .object({
    /** Human-readable OS string composed daemon-side
     *  (e.g. "macOS 14.5", "Linux Ubuntu 22.04"). Renderer shows verbatim.
     *  `.min(1)` pins the never-empty contract — the daemon helper always
     *  composes SOMETHING (falls back to `${platform} ${release}`), and an
     *  empty value reaching this schema is a daemon bug we want to fail
     *  loud at the IPC boundary instead of letting a blank cell render
     *  in ComputerPane. */
    os: z.string().min(1),
    /** `os.arch()` token; optional so older daemons stay forward-compatible. */
    os_arch: z.string().optional(),
    daemon_pid: z.number().int(),
    daemon_version: z.string(),
    started_at: z.number().int(),
    uptime_ms: z.number().int(),
    /** Subset of registered agents currently alive on this host. Backend
     *  intersects this with `agents.host_id == hostId` to compute
     *  per-agent `online` in `AgentOnHostDto`. Empty array = host has
     *  no live runtimes (renderer shows everything as offline). */
    active_agent_ids: z.array(z.string()),
  })
  .strict();
export type HostStatusResult = z.infer<typeof HostStatusResultSchema>;

// ── host_runtime_catalog (outbound command, #task:1375) ─────────────
//
// Server → daemon RPC powering per-computer runtime availability. This
// deliberately runs on the target host and uses the same host-side resolver
// as spawn, so "present" means the daemon can resolve the exact executable
// path it will later spawn. `force` bypasses the short resolver cache for
// manual refresh, create-time hard-block checks, and spawn-miss recovery.
export const HostRuntimeCatalogParamsSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();
export type HostRuntimeCatalogParams = z.infer<
  typeof HostRuntimeCatalogParamsSchema
>;

export const HostRuntimeCatalogResultSchema = RuntimeCatalogResponseSchema;
export type HostRuntimeCatalogResult = z.infer<
  typeof HostRuntimeCatalogResultSchema
>;

// ── conversation_log_debug ─────────────────────────────────────────

export const ConversationLogDebugParamsSchema = z.discriminatedUnion('enabled', [
  z
    .object({
      conversation_id: z.string().min(1),
      enabled: z.literal(true),
      expires_at: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      conversation_id: z.string().min(1),
      enabled: z.literal(false),
    })
    .strict(),
]);
export type ConversationLogDebugParams = z.infer<
  typeof ConversationLogDebugParamsSchema
>;

export const ConversationLogDebugResultSchema = z
  .object({
    ok: z.literal(true),
    enabled: z.boolean(),
    expires_at: z.number().int().positive().nullable(),
  })
  .strict();
export type ConversationLogDebugResult = z.infer<
  typeof ConversationLogDebugResultSchema
>;

// ── agent_message_send / agent_stale_resolve ───────────────────────
//
// Local agent-runtime → daemon intents for daemon-owned freshness
// authority. The CLI remains a short-lived shim; it submits the visible
// side-effect intent to the daemon, and the daemon stamps
// `seen_up_to_seq` from its runtime coordinator before forwarding to
// the backend. Backend HTTP failures intentionally travel as result
// arms, not host-transport errors, so the CLI can preserve the same
// user-facing error mapping it had on direct HTTP.

export const AgentBackendHttpErrorSchema = z
  .object({
    ok: z.literal(false),
    status: z.number().int().positive(),
    body_text: z.string(),
  })
  .strict();
export type AgentBackendHttpError = z.infer<typeof AgentBackendHttpErrorSchema>;

export const AgentMessageSendParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    content: z.string(),
    target: SendMessageTargetSchema.optional(),
    /** @deprecated Compatibility alias for old CLI/prompt builds. New
     *  callers use `target: {kind:'thread', message_id}`. */
    reply_to_message_id: z.string().min(1).optional(),
    attachment_ids: z.array(z.string().min(1)).optional(),
    stale_resolution_reason: AgentSendStaleResolutionReasonSchema.optional(),
    freshness_bypass: z.boolean().optional(),
  })
  .strict();
export type AgentMessageSendParams = z.infer<
  typeof AgentMessageSendParamsSchema
>;

export const AgentMessageSendResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      message_id: z.string().min(1),
      message_seq: z.number().int().nonnegative().optional(),
      /** Reply-cluster root the sent message belongs to (§6.4): null on
       *  the main line, else the cluster's root message id. Surfaced from
       *  the backend send response so a caller (CLI) can report which
       *  stream the message landed in. */
      thread_root_id: z.string().min(1).nullable().optional(),
    })
    .strict(),
  AgentBackendHttpErrorSchema,
]);
export type AgentMessageSendResult = z.infer<
  typeof AgentMessageSendResultSchema
>;

export const AgentStaleResolveParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    stale_event_id: z.string().min(1).optional(),
    resolution_reason: z.literal('obsolete'),
  })
  .strict();
export type AgentStaleResolveParams = z.infer<
  typeof AgentStaleResolveParamsSchema
>;

export const AgentStaleResolveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      resolved: z.literal(true),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      resolved: z.literal(false),
      reason: z.literal('no_pending_stale_event'),
    })
    .strict(),
  AgentBackendHttpErrorSchema,
]);
export type AgentStaleResolveResult = z.infer<
  typeof AgentStaleResolveResultSchema
>;

// ── agent_stream_observed (CLI→daemon, reply-cluster §6.4 B-light) ──
// A pull (`message history --target thread:<root>`) reaches the backend
// over plain HTTP, NOT through the daemon — so the daemon never learns
// that the agent observed the cluster. Without this the next
// `send --reply-to` would treat a just-read cluster as unknown (Case A
// loose), losing freshness protection on the read-then-reply path (THE
// main thread workflow). After a successful thread pull the CLI fires
// this daemon-local intent so the daemon advances the cluster's observed
// boundary and records the surfaced message ids as known reply targets.
// Purely daemon-local state: no backend call, no HTTP-error arm.
//
// Contract (Cindy 2026-06-11, msg UbcoVgS3ZQ4TivZ6):
//  - `observed_seq` is the max seq among REPLIES the pull returned
//    (`thread_root_id === root`); 0 when the cluster has no replies. The
//    root's own seq lives on the main line and MUST NOT be passed here.
//  - `reply_target_messages` is the root id PLUS the returned reply ids;
//    each maps to `thread:<root>` so a later `--reply-to` of any of them
//    resolves a known stream (root → seen=0 when there are no replies).
//    `.min(1)`: the root id is ALWAYS present (the caller prepends it from
//    the read DTO's target ref), so an empty array is a caller bug — fail
//    loud rather than record an observed boundary with no stream mapping
//    (Cindy 2026-06-11 non-blocking note, folded with the CLI producer).
export const AgentStreamObservedParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    thread_root_id: z.string().min(1),
    observed_seq: z.number().int().nonnegative(),
    reply_target_messages: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type AgentStreamObservedParams = z.infer<
  typeof AgentStreamObservedParamsSchema
>;

export const AgentStreamObservedResultSchema = z
  .object({ ok: z.literal(true) })
  .strict();
export type AgentStreamObservedResult = z.infer<
  typeof AgentStreamObservedResultSchema
>;

// ── PR-2 runtime_* surface ──────────────────────────────────────────
//
// Wire surface for the (conversation, agent) supervisor that the
// daemon owns. The shapes below match the design lock in
// `docs/remote-backend-architecture-notes.md §5` verbatim. Anything that
// looks "runtime_*" goes through one (conversation_id, agent_id) pair
// — the daemon serializes operations on that key with the same
// per-pair lifecycle lock CM uses today.

/**
 * Live-delivery text — the unencoded message text the daemon will
 * hand to its in-process driver's `encodeStdinMessage(text, ...)`
 * just before writing to stdin. Used by `runtime_wake.text` /
 * `runtime_start.startup_delivery.text` / `runtime_stop.soft_directive`.
 *
 * Why text and not pre-encoded stream-json bytes (Option A v2 — Cindy
 * `UMGu36zoTDVuKWXi`): stateful drivers (codex) carry `threadId` /
 * `activeTurnId` inside the driver instance that owns the child's
 * stdio. If backend pre-encodes by spinning up its own driver
 * instance, that instance has no `threadId` and `encodeStdinMessage`
 * returns `null`, so the wake silently dies (this was the codex
 * daemon-mode delivery blocker; see commit 2b-iii log). Moving the
 * encode into the daemon restores the legacy CM invariant — one
 * driver instance per (conv, agent), and whoever owns the child
 * process owns the driver state.
 *
 * `.min(1)` is intentional (Cindy `wYjG20JdGjLpwq8K`): every backend
 * call site (formatInboxBatch / combineGated / soft directive) yields
 * non-empty text. An empty string reaching the daemon is a caller
 * bug — fail loudly at schema validation, not at stdin encode.
 */
export const RuntimeMessageTextSchema = z.string().min(1);
export type RuntimeMessageText = z.infer<typeof RuntimeMessageTextSchema>;

const SilverhandCliLauncherSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    /**
     * Explicit launcher metadata for the per-spawn `silverhand` shim.
     * Named `env_vars` so the protocol can keep `env` itself reserved
     * for the forbidden pre-composed child environment map.
     */
    env_vars: z.record(z.string()).optional(),
  })
  .strict();

const RuntimeStartWorkspaceRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: WorkspaceKindSchema,
    // D4.e-6: SEMANTIC ref only — no `path`. The carve-out that let
    // `workspace.path` cross the boundary as "server DB metadata" is
    // REVOKED (design §3.5). The daemon is the sole authority for
    // host-local workspace paths: it resolves `regular` workspaces via
    // its registry (`registry.resolve(id)`) and `agent_home` via
    // `computeAgentDir(agentId)`. No path field travels on this wire.
  })
  .strict();

const RuntimeStartAgentRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    // D4.e-6: SEMANTIC ref only — no `home_dir`. Revokes the prior
    // carve-out (design §3.5). The daemon resolves the agent's L1
    // profile base locally as `computeAgentDir(agentId)` — identical
    // to how `agent_materialize`/`agent_workspace_tree` already resolve
    // it — and reads `system_prompt.md` under it.
  })
  .strict();

const RuntimeStartDriverOptionsSchema = z
  .object({
    kind: RuntimeKindSchema,
    cli_session_id: z.string().min(1).nullable(),
    model: z.string().nullable(),
    reasoning_effort: ReasoningEffortSchema.nullable(),
    fast_mode: z.boolean().nullable(),
  })
  .strict();

const RuntimeStartSessionSchema = z
  .object({
    conversation_id: z.string().min(1),
    kind: ConversationKindSchema,
    title: z.string(),
    spawned_by_agent_id: z.string().min(1).nullable(),
    members: z.array(MemberDtoSchema),
  })
  .strict();

const RuntimeStartEnvPolicySchema = z
  .object({
    silverhand: z
      .object({
        auth_token: z.string().min(1),
      })
      .strict(),
    // Host-local truth in standalone mode: the control plane provides
    // server URL/token, while the daemon resolves how to launch its own
    // bundled CLI. Embedded backends may still send an explicit launcher.
    silverhand_cli: SilverhandCliLauncherSchema.optional(),
  })
  .strict();

const FORBIDDEN_RUNTIME_START_OPTION_KEYS = new Set([
  'cwd',
  'workspace_path',
  // D4.e-6: `home_dir` joins the forbidden set — the agent L1 base is
  // daemon-resolved (`computeAgentDir`), never server-supplied. The
  // strict() ref schemas already reject it at the top level; listing it
  // here also bans it from appearing nested anywhere in options.
  'home_dir',
  'system_prompt_path',
  'spawn_dir',
  'system_prompt',
  'system_prompt_text',
  'memory_text',
  'consensus_text',
  'env',
]);

function rejectForbiddenRuntimeStartOptionKeys(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectForbiddenRuntimeStartOptionKeys(item, ctx, [...path, index]),
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (FORBIDDEN_RUNTIME_START_OPTION_KEYS.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: nextPath,
        message:
          `runtime_start.options.${nextPath.join('.')} is forbidden by the D2.0 path/byte boundary; ` +
          'daemon-host must derive cwd/spawn paths/prompt bytes/env locally.',
      });
    }
    rejectForbiddenRuntimeStartOptionKeys(nested, ctx, nextPath);
  }
}

/**
 * Runtime start metadata. This schema is deliberately strict and, as of
 * D4.e-6, carries NO host-local paths: `agent`/`workspace`/
 * `workspace_memory_index` are semantic refs (`id`/`name`/`kind`) and the
 * daemon resolves every absolute path locally (registry for `regular`,
 * `computeAgentDir` for `agent_home`). Server-derived execution artifacts
 * and prompt bytes were never allowed and remain forbidden below.
 */
export const StartOptionsSchema = z
  .object({
    agent: RuntimeStartAgentRefSchema,
    workspace: RuntimeStartWorkspaceRefSchema,
    workspace_memory_index: z.array(RuntimeStartWorkspaceRefSchema),
    session: RuntimeStartSessionSchema,
    driver: RuntimeStartDriverOptionsSchema,
    env_policy: RuntimeStartEnvPolicySchema,
  })
  .strict()
  .superRefine((val, ctx) =>
    rejectForbiddenRuntimeStartOptionKeys(val, ctx),
  );
export type StartOptions = z.infer<typeof StartOptionsSchema>;

/** A single (conversation, agent) supervised runtime as the daemon
 *  reports it via `runtime_status`. Mirrors the run-state DTO that
 *  backend already publishes to renderers. */
export const RuntimeStateDtoSchema = z.object({
  conversation_id: z.string().min(1),
  agent_id: z.string().min(1),
  pid: z.number().int().nullable(),
  /** Daemon's view of where this runtime is in its lifecycle. The
   *  enum mirrors the §3.2.1 startup/live exclusivity state machine
   *  so the operator can read intent vs implementation off one
   *  field. */
  phase: z.enum([
    'idle',
    'spawning',
    'startup_pending',
    'ready',
    'draining',
    'exited',
  ]),
  /** Last known AgentRunState; null until the driver emits its first
   *  run-state transition. */
  run_state: AgentRunStateSchema.nullable(),
  started_at: z.number().int().nullable(),
});
export type RuntimeStateDto = z.infer<typeof RuntimeStateDtoSchema>;

// ── runtime_start ───────────────────────────────────────────────────

/**
 * Per-delivery wire metadata attached to a startup/wake batch so the
 * daemon can maintain a PER-STREAM observed boundary and resolve
 * `--reply-to` targets it has seen (reply-cluster §6.4). One entry per
 * delivered inbox row; the entry set MUST match the batch's
 * `delivery_ids` exactly (daemon hard-rejects a mismatch — text and
 * metadata must not drift). `thread_root_id === null` ⇒ the message lives
 * on the main line. `delivery_kind` is decided at delivery creation and is
 * per-delivery, never batch-level (a startup batch can mix historical
 * `observe` rows with the current `turn` row). The scalar
 * `delivered_up_to_seq` stays as a legacy/diagnostic high-water; observed
 * authority is this array, advanced per stream.
 */
export const RuntimeDeliverySchema = z
  .object({
    delivery_id: z.number().int(),
    message_id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    thread_root_id: z.string().min(1).nullable(),
    delivery_kind: z.enum(['turn', 'observe']),
  })
  .strict();
export type RuntimeDelivery = z.infer<typeof RuntimeDeliverySchema>;

export const RuntimeStartParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    options: StartOptionsSchema,
    /** Optional spawn-time inbox drain, replacing CM's drainInbox().
     *  Carries unencoded text (Option A v2); daemon encodes on its
     *  side via the in-process driver instance whose state is the
     *  authoritative one. Ack is async via
     *  runtime_startup_delivery_consumed | _failed events. See
     *  design doc §3.1 + §3.2.1. */
    startup_delivery: z
      .object({
        delivery_ids: z.array(z.number().int()).min(1),
        delivered_up_to_seq: z.number().int().nonnegative().optional(),
        deliveries: z.array(RuntimeDeliverySchema).optional(),
        text: RuntimeMessageTextSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeStartParams = z.infer<typeof RuntimeStartParamsSchema>;

export const RuntimeStartResultSchema = z
  .discriminatedUnion('started', [
    z
      .object({
        started: z.literal(true),
        pid: z.number().int(),
        started_at: z.number().int(),
        /** True iff daemon accepted the startup_delivery payload for
         *  attempt. NOT a "consumed" signal — that's the async
         *  runtime_startup_delivery_consumed event. Absent when
         *  `startup_delivery` was not provided in params. */
        startup_delivery_accepted: z.boolean().optional(),
      })
      .strict(),
    /**
     * Cooldown-blocked arm (Cindy `-pdNvRYOWip5e9yA` + plan v2
     * `EOmOrJxeJUnbcmVR`): daemon is in init-failure cooldown for this
     * (conv, agent) and refuses to spawn. This is a BUSINESS state —
     * backend projects it to `agent_status reason:'init_cooldown'` SSE
     * — not a transport error, so it ships in the result union rather
     * than throwing an `internal_error` reply.
     *
     * Only the daemon's user-facing `runtime_start` gate produces
     * this arm. Daemon-internal retry respawns (attempt > 0) take a
     * separate code path that is NEVER blocked by this gate; the
     * watchdog failure decides retry eligibility at the moment of
     * failure. The gate ONLY fires when:
     *   - no live handle exists for (conv, agent), AND
     *   - this is a fresh user-initiated start (initAttempt === 0).
     * Idempotent return for an already-running handle is the success
     * arm even if a stale cooldown would otherwise apply.
     *
     * Programmer / deployment errors (missing `options.runtime`,
     * missing binary, unknown runtime kind) STILL throw and surface
     * as `internal_error` — they are not modeled as business state.
     */
    z
      .object({
        started: z.literal(false),
        reason: z.literal('init_cooldown'),
        /** Wall-clock epoch ms at which cooldown expires. Backend
         *  projects to `agent_status.cooldown_until`. Must be strictly
         *  in the future at emit time. */
        cooldown_until: z.number().int().positive(),
      })
      .strict(),
  ]);
export type RuntimeStartResult = z.infer<typeof RuntimeStartResultSchema>;

// ── runtime_stop ────────────────────────────────────────────────────

/**
 * Stop a (conv, agent) runtime. Two modes with distinct semantics
 * (locked by Cindy `vqDWkLFF6pAeIE5t` step 2 plan reply):
 *
 *  - **`hard`** — SIGTERM 5s → SIGKILL cascade. Result reports the
 *    process termination outcome via `{ stopped, exit_code }`.
 *  - **`soft`** — inject a directive user message into stdin (e.g.
 *    "[the user wants you to stop]") and let the agent wrap up.
 *    Backend MUST supply the directive in `soft_directive`. Result
 *    reports the write outcome via `{ directive_delivered, reason? }`.
 *    The runtime is NOT terminated by a soft stop; the agent's next
 *    `turn_end` or `runtime_exit` is what backend should react to.
 *
 * Why the result is a discriminated union rather than a flat object:
 * conflating "process stopped" with "directive written" lets backend
 * misinterpret a soft `write_failed` as "agent is now stopped" and
 * flip DB / SSE state incorrectly. Splitting on `mode` makes that
 * misuse a compile-time error.
 */
export const RuntimeStopParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    mode: z.enum(['soft', 'hard']),
    /** Unencoded directive text the daemon will hand to its driver's
     *  `encodeStdinMessage(text, cliSessionId)` and write to stdin
     *  as a user message. ONLY allowed when `mode === 'soft'`.
     *  Option A v2 (Cindy `UMGu36zoTDVuKWXi`): backend no longer
     *  pre-encodes — daemon owns the driver instance with state. */
    soft_directive: RuntimeMessageTextSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'hard' && val.soft_directive !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['soft_directive'],
        message:
          "soft_directive is only valid when mode === 'soft'; hard mode kills the process and ignores stdin.",
      });
    }
    if (val.mode === 'soft' && val.soft_directive === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['soft_directive'],
        message:
          "soft_directive is required when mode === 'soft'; backend MUST supply the directive bytes (default phrasing is backend's responsibility).",
      });
    }
  });
export type RuntimeStopParams = z.infer<typeof RuntimeStopParamsSchema>;

export const RuntimeStopResultSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('hard'),
        /** Whether the runtime was actually live and got the signal.
         *  False = nothing to stop (already exited / never started). */
        stopped: z.boolean(),
        /** Final exit code if known at response time. SIGTERM cascade
         *  may not have completed; daemon may report `null` and let the
         *  `runtime_exit` event carry the real value. */
        exit_code: z.number().int().nullable(),
      })
      .strict(),
    z
      .object({
        mode: z.literal('soft'),
        /** Whether the directive line was written to the child's stdin.
         *  False = runtime not running, write failed, or driver refused.
         *  IMPORTANT: directive_delivered === false does NOT mean the
         *  runtime is stopped — backend must NOT flip DB / SSE state
         *  to a stopped status on a soft failure. */
        directive_delivered: z.boolean(),
        /** Why the directive wasn't delivered. REQUIRED when
         *  directive_delivered === false; FORBIDDEN when
         *  directive_delivered === true. The pairing is enforced by
         *  the .superRefine() below (Cindy `eMcEhycw8fQwucis`) — a
         *  bare `optional()` would let backend silently emit either
         *  `{delivered:false}` (no reason) or
         *  `{delivered:true, reason:'write_failed'}`, both of which
         *  defeat the whole point of the discriminated soft result. */
        reason: z
          .enum(['not_running', 'write_failed', 'driver_refused'])
          .optional(),
      })
      .strict(),
  ])
  .superRefine((val, ctx) => {
    if (val.mode !== 'soft') return;
    if (val.directive_delivered === false && val.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message:
          "soft result with directive_delivered=false must carry a typed reason ('not_running' | 'write_failed' | 'driver_refused')",
      });
    }
    if (val.directive_delivered === true && val.reason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message:
          'soft result with directive_delivered=true must not carry a reason',
      });
    }
  });
export type RuntimeStopResult = z.infer<typeof RuntimeStopResultSchema>;

// ── runtime_wake ────────────────────────────────────────────────────

/**
 * Live-delivery primitive. BATCH-NATIVE — single-row delivery is
 * `delivery_ids: [id]`. Backend owns the inbox; daemon never reads
 * or writes inbox rows. See design doc §3.1.
 *
 * Result is all-or-nothing: success returns the same `delivery_ids`
 * caller passed in (so the response carries enough context to
 * `markDelivered` even if the request was retried over a reconnect).
 * Failure carries a typed `reason` and the same `delivery_ids` so
 * the caller keeps every row pending — no partial mark.
 */
export const RuntimeWakeParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    delivered_up_to_seq: z.number().int().nonnegative().optional(),
    deliveries: z.array(RuntimeDeliverySchema).optional(),
    kind: z.enum(['message', 'schedule_fire']),
    /** Unencoded message text (Option A v2). Daemon's
     *  `Supervisor.wake()` calls
     *  `handle.driver.encodeStdinMessage(text, handle.cliSessionId)`
     *  using its in-process driver instance whose runtime state
     *  (codex threadId / activeTurnId etc.) was set during spawn /
     *  bindIO. backend MUST NOT pre-encode — see
     *  RuntimeMessageTextSchema doc for the why. */
    text: RuntimeMessageTextSchema,
  })
  .strict();
export type RuntimeWakeParams = z.infer<typeof RuntimeWakeParamsSchema>;

export const RuntimeWakeReasonSchema = z.enum([
  'not_running',
  'not_initialized',
  'startup_pending',
  'draining',
  /**
   * Option A v2 (Cindy `UMGu36zoTDVuKWXi`): driver's
   * `encodeStdinMessage` returned null AND `driver.readyToEncode()`
   * was false (e.g. codex pre-`thread/started`). Distinct from
   * `driver_refused` (encode null AFTER ready) because backend's
   * response is different: `driver_not_ready` is recoverable —
   * backend keeps the DB row pending and waits for the daemon's next
   * `runtime_ready_for_drain` to re-attempt; `driver_refused` is a
   * config / programming error and warrants a louder backend signal.
   *
   * Daemon explicitly does NOT keep its own re-delivery queue here:
   * the DB inbox is the single durable source of truth (Cindy
   * `UMGu36zoTDVuKWXi`). Avoiding a second queue prevents
   * crash-loses-memory, ready_for_drain-replays-duplicate, and ack-
   * race-with-DB classes of bugs that a daemon-side queue would
   * introduce.
   */
  'driver_not_ready',
  'driver_refused',
]);
export type RuntimeWakeReason = z.infer<typeof RuntimeWakeReasonSchema>;

export const RuntimeWakeResultSchema = z.union([
  z
    .object({
      delivered: z.literal(true),
      delivery_ids: z.array(z.number().int()).min(1),
    })
    .strict(),
  z
    .object({
      delivered: z.literal(false),
      reason: RuntimeWakeReasonSchema,
      delivery_ids: z.array(z.number().int()).min(1),
    })
    .strict(),
]);
export type RuntimeWakeResult = z.infer<typeof RuntimeWakeResultSchema>;

// ── runtime_status ──────────────────────────────────────────────────

export const RuntimeStatusParamsSchema = z
  .object({
    conversation_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeStatusParams = z.infer<typeof RuntimeStatusParamsSchema>;

export const RuntimeStatusResultSchema = z
  .object({
    runtimes: z.array(RuntimeStateDtoSchema),
  })
  .strict();
export type RuntimeStatusResult = z.infer<typeof RuntimeStatusResultSchema>;

// ── runtime_clear_session ───────────────────────────────────────────

export const RuntimeClearSessionParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();
export type RuntimeClearSessionParams = z.infer<
  typeof RuntimeClearSessionParamsSchema
>;

export const RuntimeClearSessionResultSchema = z
  .object({ cleared: z.boolean() })
  .strict();
export type RuntimeClearSessionResult = z.infer<
  typeof RuntimeClearSessionResultSchema
>;

// ── runtime_stop_all / runtime_close_activity_log ───────────────────

export const RuntimeStopAllParamsSchema = z.object({}).strict();
export type RuntimeStopAllParams = z.infer<typeof RuntimeStopAllParamsSchema>;

export const RuntimeStopAllResultSchema = z
  .object({ stopped_count: z.number().int().nonnegative() })
  .strict();
export type RuntimeStopAllResult = z.infer<typeof RuntimeStopAllResultSchema>;

export const RuntimeCloseActivityLogParamsSchema = z.object({}).strict();
export type RuntimeCloseActivityLogParams = z.infer<
  typeof RuntimeCloseActivityLogParamsSchema
>;

export const RuntimeCloseActivityLogResultSchema = z
  .object({ flushed: z.boolean() })
  .strict();
export type RuntimeCloseActivityLogResult = z.infer<
  typeof RuntimeCloseActivityLogResultSchema
>;

// ── output flow control (intents bodies present, v0 unused) ─────────

export const RuntimeOutputPauseParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();
export type RuntimeOutputPauseParams = z.infer<
  typeof RuntimeOutputPauseParamsSchema
>;

export const RuntimeOutputPauseResultSchema = z
  .object({ paused: z.boolean() })
  .strict();
export type RuntimeOutputPauseResult = z.infer<
  typeof RuntimeOutputPauseResultSchema
>;

export const RuntimeOutputResumeParamsSchema = RuntimeOutputPauseParamsSchema;
export type RuntimeOutputResumeParams = RuntimeOutputPauseParams;

export const RuntimeOutputResumeResultSchema = z
  .object({ resumed: z.boolean() })
  .strict();
export type RuntimeOutputResumeResult = z.infer<
  typeof RuntimeOutputResumeResultSchema
>;

// ── host_outbound_attach (Stage D3.a Commit 3) ─────────────────────
//
// Late-attach control intent the desktop main process uses to tell a
// running daemon "you now have credentials; load this host config and
// open the outbound websocket". Decouples daemon spawn from credential
// availability so the desktop launcher does not have to either (a)
// hold the spawn until after login, or (b) spawn the daemon with a
// stale `daemon-config.json` left over from a previous user.
//
// Contract:
//   - `config_path` MUST be an absolute path to a regular file (a
//     symlink-to-file is fine; a directory is rejected).
//   - The daemon validates the path, reads + parses the config, and
//     **only on success** swaps the active outbound client. If
//     validation or parsing fails, the existing outbound client (if
//     any) keeps running untouched — a bad Settings change must not
//     take down a working daemon.
//   - Idempotency:
//       - same path, client already attached → `{ attached: true,
//         action: 'noop' }`.
//       - same path, client not yet started → `{ attached: true,
//         action: 'started' }`.
//       - different valid path → `{ attached: true, action:
//         'switched' }` (graceful stop of the previous client, then
//         start with the new config).
//   - Errors carry a typed `reason` so callers don't have to string-
//     match. None of the error reasons cause side effects on the
//     existing client.

export const HostOutboundAttachParamsSchema = z
  .object({
    config_path: z.string().min(1),
  })
  .strict();
export type HostOutboundAttachParams = z.infer<
  typeof HostOutboundAttachParamsSchema
>;

export const HostOutboundAttachFailureReasonSchema = z.enum([
  'path_not_absolute',
  'path_not_found',
  'path_not_a_file',
  'parse_failed',
  'invalid_server_url',
]);
export type HostOutboundAttachFailureReason = z.infer<
  typeof HostOutboundAttachFailureReasonSchema
>;

export const HostOutboundAttachResultSchema = z.discriminatedUnion('attached', [
  z
    .object({
      attached: z.literal(true),
      config_path: z.string().min(1),
      /**
       * What the daemon did with the request. Mirrors the idempotency
       * matrix above so callers can log it and tests can assert
       * branch coverage.
       */
      action: z.enum(['started', 'switched', 'noop']),
    })
    .strict(),
  z
    .object({
      attached: z.literal(false),
      reason: HostOutboundAttachFailureReasonSchema,
      message: z.string().optional(),
    })
    .strict(),
]);
export type HostOutboundAttachResult = z.infer<
  typeof HostOutboundAttachResultSchema
>;


// ── host_outbound_detach (Stage D3.b Commit 3) ─────────────────────
//
// Counterpart to `host_outbound_attach`: tell a running daemon to
// gracefully stop its currently-attached outbound websocket so the
// backend can drop the attachment without waiting for heartbeat /
// socket-close timeout. The desktop main process sends this from its
// `before-quit` cleanup path as a **latency optimization hint** — it
// is NOT a backend correctness dependency. The server-side cleanup
// still falls back to WS-close detection and heartbeat timeout if
// the hint never lands.
//
// Contract:
//   - No params. Detach is unconditional: there is nothing to
//     validate, no file to read, no URL to parse.
//   - Idempotent. With an active client: stop it cleanly, return
//     `action: 'detached'`. With no client: noop, return
//     `action: 'noop'`. Both arms have `detached: true` because the
//     post-condition ("no active outbound client") is satisfied
//     either way.
//   - **Domain result has no failure arm** because there are no
//     input or I/O failure modes. Transport / dispatcher errors
//     (`shutting_down`, `internal_error`, `closed`, network etc.)
//     still surface as `ResponseError` frames per the standard
//     response envelope — callers must treat those as failures, not
//     as a missing result.
//   - Detach does NOT make the daemon's `OutboundSupervisor`
//     terminal. The supervisor can be re-attached later via
//     `host_outbound_attach` in the same daemon process (e.g.
//     log-out → log-in-as-different-user). Daemon shutdown is a
//     separate path — `OutboundSupervisor.stop()` (called from
//     `runDaemon` shutdown) is the one-way close.

export const HostOutboundDetachParamsSchema = z.object({}).strict();
export type HostOutboundDetachParams = z.infer<
  typeof HostOutboundDetachParamsSchema
>;

export const HostOutboundDetachResultSchema = z
  .object({
    detached: z.literal(true),
    /**
     * `detached` = there was an active outbound client and it was
     *              stopped as part of this call.
     * `noop`     = no active client (pre-attach state, or already
     *              detached). The hint is harmless either way.
     */
    action: z.enum(['detached', 'noop']),
  })
  .strict();
export type HostOutboundDetachResult = z.infer<
  typeof HostOutboundDetachResultSchema
>;


// ── host_outbound_reload (Stage D3.c Commit 2) ─────────────────────
//
// Tell a running daemon "re-read the SAME daemon-config.json you're
// already attached to, validate it, and swap to the new bytes if and
// only if everything checks out". The desktop main process sends this
// from its Settings save path AFTER it has atomically rewritten
// `daemon-config.json` (write-temp + fsync + rename → reload IPC).
//
// Why a separate intent rather than re-using `host_outbound_attach`:
//   - **Hard-rejects `not_attached`**: if no client is currently
//     attached, reload must FAIL — it MUST NOT silently fall through
//     to "attach". The caller (desktop main) needs to decide
//     explicitly whether the right verb here is `attach`
//     (post-login bootstrap) or `reload` (Settings save / token
//     rotation). Silent fallback hides logout-races and stale-state
//     bugs.
//   - **Validate-first-then-swap**: any I/O / parse / URL validation
//     failure leaves the existing client running untouched. A bad
//     Settings save must not take down a working outbound — the user
//     gets a typed error in Settings, and the daemon keeps streaming.
//   - **Result success ≠ connected**: `action: 'reloaded'` means the
//     daemon started a NEW client with the new config. WS open /
//     attachment-fresh is a separate signal the desktop verifies via
//     backend `HostWsServerController.getAttachment(hostId)` after
//     the reload returns (Commit 3 concern; this intent's job is to
//     hand the new bytes to the daemon, not to wait for socket
//     handshake).
//
// Contract:
//   - No params: reload re-reads the daemon's CURRENT config_path.
//     Path changes belong to `host_outbound_attach` — by design,
//     reload cannot swap to a different config file.
//   - Success arms:
//       - `action: 'reloaded'` — config bytes differ from the
//         in-memory fingerprint; new client started after old client
//         was stopped (validate-first-then-swap order strict).
//       - `action: 'unchanged'` — config bytes are byte-identical
//         to the in-memory fingerprint (rotate / no-op). Old client
//         keeps running uninterrupted; no WS bounce.
//   - Failure arms (typed business state, NOT ResponseError):
//       - `not_attached`         — no current client; caller must use
//                                  `host_outbound_attach` instead.
//       - `config_unreadable`    — disk read failed (ENOENT after
//                                  attach, EACCES, FIFO substitution,
//                                  etc.). Old client kept.
//       - `parse_failed`         — config JSON / shape invalid. Old
//                                  client kept.
//       - `invalid_server_url`   — `hostConnectWebSocketUrl` threw on
//                                  the NEW server_url (e.g. user edited
//                                  to insecure remote HTTP). Old client
//                                  kept.
//
// Result shape mirrors `host_outbound_attach`: discriminated on a
// boolean flag so callers branch on `result.reloaded` without
// inspecting nested fields. Failure arm includes `message` for log /
// diagnostic continuity; success arm includes `host_id` so the
// caller (desktop main, Commit 3) can hand it straight to the
// backend attachment-freshness check without re-reading the config.

export const HostOutboundReloadParamsSchema = z.object({}).strict();
export type HostOutboundReloadParams = z.infer<
  typeof HostOutboundReloadParamsSchema
>;

export const HostOutboundReloadFailureReasonSchema = z.enum([
  'not_attached',
  'config_unreadable',
  'parse_failed',
  'invalid_server_url',
]);
export type HostOutboundReloadFailureReason = z.infer<
  typeof HostOutboundReloadFailureReasonSchema
>;

export const HostOutboundReloadResultSchema = z.discriminatedUnion('reloaded', [
  z
    .object({
      reloaded: z.literal(true),
      /**
       * `reloaded`  — config bytes differed; old client stopped, new
       *               client started. WS handshake not yet complete.
       * `unchanged` — config bytes identical to in-memory fingerprint;
       *               old client kept untouched. Caller can skip the
       *               attachment-freshness poll Commit 3 runs for the
       *               `reloaded` case (nothing reconnected).
       */
      action: z.enum(['reloaded', 'unchanged']),
      /**
       * The config_path the reload was performed against — echoed back
       * for log correlation. Always the daemon's currently-attached
       * path; reload cannot change paths.
       */
      config_path: z.string().min(1),
      /**
       * `host_id` from the (re)loaded config. The caller uses it as
       * the key for backend `HostWsServerController.getAttachment`
       * polling after a `reloaded` response. For `unchanged` it's the
       * same host_id that was already attached — caller can use it to
       * sanity-check no concurrent attach swapped under it.
       */
      host_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      reloaded: z.literal(false),
      reason: HostOutboundReloadFailureReasonSchema,
      /** Free-text diagnostic. Renderer should branch on `reason`
       *  for UI copy; `message` is for logs / dev console only. */
      message: z.string().optional(),
    })
    .strict(),
]);
export type HostOutboundReloadResult = z.infer<
  typeof HostOutboundReloadResultSchema
>;

// ── host_proxy_config_* (daemon-host local truth) ──────────────────
//
// Proxy configuration is daemon-host local truth: it lives in a file on
// the physical computer that spawns runtimes. The server owns authz and
// dispatch only; it does not persist proxy bytes. The URL is an opaque
// host-local value and is intentionally not parsed for credentials.

export const HostProxyConfigSchema = SharedHostProxyConfigSchema;
export type HostProxyConfig = z.infer<typeof HostProxyConfigSchema>;

export const HostProxyConfigGetParamsSchema = z.object({}).strict();
export type HostProxyConfigGetParams = z.infer<
  typeof HostProxyConfigGetParamsSchema
>;

export const HostProxyConfigGetResultSchema = z
  .object({ config: HostProxyConfigSchema })
  .strict();
export type HostProxyConfigGetResult = z.infer<
  typeof HostProxyConfigGetResultSchema
>;

export const HostProxyConfigSetParamsSchema = HostProxyConfigSchema;
export type HostProxyConfigSetParams = z.infer<
  typeof HostProxyConfigSetParamsSchema
>;

export const HostProxyConfigSetResultSchema = HostProxyConfigGetResultSchema;
export type HostProxyConfigSetResult = HostProxyConfigGetResult;


// ── D4.d: agent_materialize (server↔daemon formal semantics) ──────
//
// Unlike the runtime_* intents (local supervisor / control —
// scheduling, lifecycle, output paging) and the `host_outbound_*`
// intents (transport plumbing), `agent_materialize` IS formal
// server↔daemon semantics by design: it is the canonical way the
// server asks the daemon-owning host to create an agent's L1 home
// (= the DM workspace path; CLAUDE.md §3 / docs/agent-system-prompt-
// memory.md). The schemas live here so the IPC dispatcher can
// validate them through the same `intentSchemas` catalogue used by
// every other intent; the outbound WS frame layer re-exports them
// from `outbound-protocol.ts` so the wire surface (additive,
// per-command error scoping — see Cindy D1 round-1 P1) stays a
// thin envelope around the same Zod definitions.
//
// See `docs/remote-backend-architecture-notes.md §3.4`.

export const AgentMaterializeParamsSchema = z
  .object({
    /**
     * Server-allocated; base64url 16-char string from
     * randomBytes(12).toString('base64url')
     * (packages/backend/src/repos/agent-repo.ts).
     * Schema-level validation is intentionally loose (`min(1)`);
     * the route layer is responsible for tighter format checks
     * (Cindy round-2 P1 #5).
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
     * MEMORY.md, notes/ skeleton). D2 implements 'default' only;
     * 'onboarding' and 'minimal' return `unsupported_template`
     * until they get a template.
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
     *
     * Cindy D2 P1-2: the equality is enforced by the schema's
     * `superRefine` below, NOT just by convention. A handler that
     * drifts (or a future stub that diverges the two strings)
     * would otherwise let a wrong workspace path land in the
     * server's L3a `workspace` row — the kind of silent
     * corruption a schema constraint is supposed to catch.
     */
    agent_home_workspace_path: z.string().min(1),
    /**
     * Opaque-to-server timestamp used only for audit. The row's
     * `created_at` remains the server's authoritative time.
     */
    materialized_at: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.agent_home_workspace_path !== value.agent_dir) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent_home_workspace_path'],
        message:
          'agent_home_workspace_path must equal agent_dir (§6.5 invariant: the DM workspace path IS the L1 dir)',
      });
    }
  });
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
   * `.materialized` sentinel, or the sentinel exists but does
   * not match the requested (agent_id, template_choice, runtime)
   * triple (sentinel "template_match" per §4.6 / §14 Q3).
   * Idempotent re-call of an already-materialized `agent_id`
   * (all three sentinel fields match) returns `ok: true` and is
   * NOT an error.
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
 * Canonical generic-error code taxonomy. The 5 transport-level codes
 * the daemon may emit independent of any intent. Kept small and
 * stable so the client can branch on them without scanning
 * `message` strings:
 *
 *  - `unknown_intent`     — `intent` name not in the registry
 *  - `invalid_params`     — params failed zod validation
 *  - `internal_error`     — handler threw / returned an unexpected error
 *  - `shutting_down`      — request arrived after SIGTERM/SIGINT
 *  - `request_too_large`  — incoming frame exceeded the per-frame cap
 *
 * Single source of truth — referenced by `ResponseErrorSchema`
 * (generic frame) AND by per-intent typed-error schemas (e.g.
 * `AgentMaterializeIpcErrorSchema`) so a new generic code added here
 * automatically widens both surfaces. Cindy D2 round-2 P2 caught
 * the previous hand-copy in `AgentMaterializeIpcErrorSchema`; the
 * extract removes that drift axis.
 */
export const ResponseErrorCodeSchema = z.enum([
  'unknown_intent',
  'invalid_params',
  'internal_error',
  'shutting_down',
  'request_too_large',
]);
export type ResponseErrorCode = z.infer<typeof ResponseErrorCodeSchema>;


/**
 * Per-intent typed-error schemas.
 *
 * Default = `ResponseErrorSchema` (the 5 transport-level codes).
 * Intents that may legitimately surface daemon-business typed
 * codes — `agent_materialize` and the D4.e workspace data-plane
 * intents (`workspace_provision`, `agent_workspace_index`,
 * `agent_l2_seed`, `agent_files_purge`) — override with a wider schema that unions
 * the 5 generic codes with the intent's own taxonomy (e.g.
 * `AgentMaterializeErrorCodeSchema`).
 *
 * Why per-intent and NOT a single global widened union (Cindy
 * D2 P1-1 + D1 round-1 P1): a global union would let any intent
 * carry any other intent's typed code on the wire — exactly the
 * scoping failure Cindy caught at D1 round-1. Per-intent scoping
 * keeps each intent's error surface narrow at validation time.
 *
 * This registry is consumed by:
 *   - `IntentDispatcher.dispatch` (daemon side) — to validate the
 *     error code it's about to emit on the wire.
 *   - `HostClient.handleFrame` (client side) — to validate
 *     incoming `error.code` against the intent the caller
 *     dispatched, before resolving as a typed `HostClientError`.
 *   - `SocketTransport.deliverFrame` does NOT consult this map;
 *     it uses `LooseAnyFrameSchema` so a typed code doesn't get
 *     silently dropped at the transport layer. Validation happens
 *     at the client layer above, where the intent name is known.
 */
const AgentMaterializeIpcErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorCodeSchema,
      AgentMaterializeErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();

// ── D4.e-6: runtime_start typed-error taxonomy ───────────────────────
//
// Before D4.e-6 `runtime_start` shipped paths and could not fail on path
// resolution, so it used only the 5 generic codes. Now the daemon
// resolves `workspace.path`/`home_dir` itself (registry + computeAgentDir)
// and FAILS CLOSED when it can't — design §3.5 / Cindy criterion 2. Two
// daemon-business codes carry that failure with the same per-command
// scoping as agent_materialize (a typed code here cannot leak onto any
// other intent's wire error):
//   - `workspace_not_provisioned`: the regular workspace id is not bound
//     in the daemon registry (legacy row never provisioned / never
//     read-path-backfilled). Recoverable: the backend may backfill via
//     `workspace_provision` and retry.
//   - `workspace_path_missing`: the daemon resolved a semantic workspace
//     ref, but the host-local path no longer exists or is not a directory
//     (for example an old agent_home row created under another
//     `SILVERHAND_DIR`). Not recoverable by registry backfill; the local
//     files need to be restored/materialized.
//   - `registry_unavailable`: the registry itself can't be consulted
//     (daemon not attached to a control plane, or foreign/corrupt
//     registry file). Hard fail-closed.
export const RuntimeStartErrorCodeSchema = z.enum([
  'workspace_not_provisioned',
  'workspace_path_missing',
  'registry_unavailable',
]);
export type RuntimeStartErrorCode = z.infer<typeof RuntimeStartErrorCodeSchema>;

const RuntimeStartIpcErrorSchema = z
  .object({
    code: z.union([ResponseErrorCodeSchema, RuntimeStartErrorCodeSchema]),
    message: z.string(),
  })
  .strict();


// ── D4.e-1: workspace_provision + agent_workspace_index ───────────────
//
// Data-plane intents that make the daemon the sole authority for
// host-local path resolution of regular workspaces (design rev3
// 0e995ac §2/§3.1/§3.4). Both are server↔daemon formal semantics like
// `agent_materialize` (NOT runtime_* control / host_outbound_* plumbing):
// the backend speaks only semantic ids; the daemon resolves the
// absolute path via its local workspace registry. Per-command typed
// error scoping mirrors agent_materialize.

export const WorkspaceProvisionParamsSchema = z
  .object({
    workspace_id: z.string().min(1),
    /**
     * Semantic classification (backend-owned, from the DB) — NOT a path.
     * Only `regular` is provisioned here; `agent_home` is materialized
     * via `agent_materialize` and is rejected with `unsupported_kind`.
     */
    kind: WorkspaceKindSchema,
    /**
     * OPTIONAL caller-PROPOSED host path for the workspace root (M1
     * folder-picker on local desktop, or an advanced typed path on a
     * sandbox/remote host). When ABSENT the daemon self-picks a
     * deterministic managed path under its own root (the zero-choice
     * default). When PRESENT the daemon RE-VALIDATES it host-side — a
     * registry structural check (absolute / not root / not home / not
     * inside the silverhand state dir except under `workspaces/` / not
     * inside the managed root / not overlapping another workspace's root)
     * — it never blindly trusts a backend-supplied path. Creatability /
     * writability is NOT probed in the registry; it is proven at the
     * skeleton-creation stage, where an fs errno classifies as
     * `fs_unavailable` / `fs_quota_exceeded`. The authoritative result is
     * always `bound_workspace_path`, NOT this field. Legacy backfill of a
     * pre-D4.e `workspaces.workspace_path` is just a call that passes the
     * old path here (idempotent on the same id→path). The backend NEVER
     * interprets this path; it only decides whether to forward one.
     */
    requested_path: z.string().min(1).optional(),
  })
  .strict();
export type WorkspaceProvisionParams = z.infer<
  typeof WorkspaceProvisionParamsSchema
>;

export const WorkspaceProvisionResultSchema = z
  .object({
    ok: z.literal(true),
    /**
     * true when this call newly bound the workspace in the registry;
     * false on idempotent re-provision of an already-bound workspace
     * (same id → same path, whether daemon-managed or caller-proposed).
     */
    provisioned: z.boolean(),
    /**
     * D4.e-1 (Cindy #720 Q1): the daemon-managed-or-validated workspace
     * root the daemon just bound/created — the AUTHORITATIVE path (the
     * daemon self-picked it, or accepted+validated the caller's
     * `requested_path`). **Transitional seam, NOT a return to server path
     * authority.** Path authority stays with the daemon; the backend is
     * only permitted to cache this into the legacy NOT-NULL
     * `workspaces.workspace_path` column to keep pre-migration consumers
     * (member-add seed / delete / runtime_start) working until their own
     * D4.e-3/-4/-6 slices migrate them. It MUST NOT be used to assemble
     * `agent_dir`, any agent-facing DTO, or a runtime formal payload —
     * those go through `agent_workspace_index` / the registry. Same class
     * of exception as D4.d `agent_materialize` returning `agent_dir`.
     */
    bound_workspace_path: z.string().min(1),
  })
  .strict();
export type WorkspaceProvisionResult = z.infer<
  typeof WorkspaceProvisionResultSchema
>;

export const WorkspaceProvisionErrorCodeSchema = z.enum([
  /** `kind: 'agent_home'` routed here — must go via `agent_materialize`. */
  'unsupported_kind',
  /**
   * A caller-supplied `requested_path` failed daemon-side STRUCTURAL
   * validation (relative / root / home / inside the silverhand state dir
   * except under `workspaces/` / inside the managed root). Creatability is
   * NOT checked here — that surfaces as `fs_unavailable` /
   * `fs_quota_exceeded` from the skeleton stage; a same-/nested-root
   * collision with another workspace is `path_conflict`, not this. Cannot
   * occur on the no-path default branch (daemon-chosen path is always
   * valid).
   */
  'invalid_path',
  /**
   * Path-vs-id binding conflict: this `workspace_id` is already bound to
   * a DIFFERENT path, OR the `requested_path` overlaps (equals OR nests
   * with) a path already bound to a DIFFERENT workspace — two workspaces
   * may never share or nest roots (a recursive purge of the outer would
   * delete the inner). Refused, never silently overwritten. Same id→same
   * path is idempotent (`provisioned:false`), not a conflict.
   */
  'path_conflict',
  'fs_quota_exceeded',
  'fs_unavailable',
  /** Foreign/corrupt daemon registry — fail closed. */
  'registry_unavailable',
  'internal_error',
]);
export type WorkspaceProvisionErrorCode = z.infer<
  typeof WorkspaceProvisionErrorCodeSchema
>;

const WorkspaceProvisionIpcErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorCodeSchema,
      WorkspaceProvisionErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();

export const AgentWorkspaceIndexParamsSchema = z
  .object({
    agent_id: z.string().min(1),
    /** Workspace ids the backend's ACL/DB list already authorized. */
    workspace_ids: z.array(z.string().min(1)),
  })
  .strict();
export type AgentWorkspaceIndexParams = z.infer<
  typeof AgentWorkspaceIndexParamsSchema
>;

export const AgentWorkspaceIndexEntrySchema = z
  .object({
    workspace_id: z.string().min(1),
    /**
     * Daemon-resolved absolute `agent_dir` for this (agent, workspace):
     * agent-home → the agent's L1 dir; regular → `<ws>/.silverhand/
     * agents/<agent_id>`. Stamped daemon-side; the backend never
     * assembles it from `workspace_path`.
     */
    agent_dir: z.string().min(1),
  })
  .strict();
export type AgentWorkspaceIndexEntry = z.infer<
  typeof AgentWorkspaceIndexEntrySchema
>;

export const AgentWorkspaceIndexResultSchema = z
  .object({
    ok: z.literal(true),
    entries: z.array(AgentWorkspaceIndexEntrySchema),
    /**
     * Regular workspaces that are neither provisioned nor adopted on this
     * daemon (read fail-closed: no managed-path guess). The backend
     * decides how to surface these — it MUST NOT fall back to a
     * `workspace_path`-derived path (that would re-pierce I1).
     */
    unresolved: z.array(z.string().min(1)),
  })
  .strict();
export type AgentWorkspaceIndexResult = z.infer<
  typeof AgentWorkspaceIndexResultSchema
>;

export const AgentWorkspaceIndexErrorCodeSchema = z.enum([
  /** Foreign/corrupt daemon registry — fail closed (whole call). */
  'registry_unavailable',
  'internal_error',
]);
export type AgentWorkspaceIndexErrorCode = z.infer<
  typeof AgentWorkspaceIndexErrorCodeSchema
>;

const AgentWorkspaceIndexIpcErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorCodeSchema,
      AgentWorkspaceIndexErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();

// ── #task:811 — agent_workspace_tree + agent_workspace_file_read ─────
// Two-protocol read pair backing the two-column AgentWorkspacePane: one
// intent returns the flat tree of every visible file under the agent
// home dir; the other reads any of those files by virtual path. This is
// intentionally NOT segmented by `system_prompt`/`MEMORY`/`notes` — the
// protocol speaks one virtual path namespace, the UI categorizes (or
// doesn't).
//
// Forward-compat: a future expansion that exposes a different file
// root (e.g. an L2 workspace dir) MUST be additive selectors (`scope`,
// `workspace_id`) — never reinterpret an existing path. Today
// `path: "MEMORY.md"` unambiguously means the agent-home `MEMORY.md`,
// and that meaning is frozen.
//
// Security: every input path is validated by
// `parseAndResolveVirtualPath` daemon-side — segment-by-segment shape
// rules (no empty/`.`/`..`/dotfile/NUL/backslash), per-segment lstat
// to refuse symlinks intermediate or leaf, and a final
// `path.relative` boundary check against the realpath of the agent
// home base. Fail-closed: any escape is `forbidden_path`, never a
// silent fallthrough.

export const AgentWorkspaceTreeParamsSchema = z
  .object({
    /** The agent whose home dir is walked. The daemon owns path
     *  resolution (`computeAgentDir`) — no server-derived path
     *  crosses the wire. */
    agent_id: z.string().min(1),
    /** Optional L2 scope. Omitted = the agent home/L1 dir. Present =
     *  resolve this workspace id daemon-side to the agent's per-workspace
     *  memory dir. Agent-home/DM workspace ids naturally resolve back to the
     *  same home dir; regular workspace ids resolve through the daemon
     *  workspace registry. No filesystem path crosses the wire. */
    workspace_id: z.string().min(1).optional(),
  })
  .strict();
export type AgentWorkspaceTreeParams = z.infer<
  typeof AgentWorkspaceTreeParamsSchema
>;

export const AgentWorkspaceTreeResultSchema = z
  .object({
    ok: z.literal(true),
    /** Flat list of every visible entry under the agent home dir,
     *  ordered (parent-dir, kind=directory-first, name). Hidden
     *  entries (anything starting with '.') and symlinks (intermediate
     *  or leaf) are filtered server-side. */
    tree: AgentWorkspaceTreeSchema,
  })
  .strict();
export type AgentWorkspaceTreeResult = z.infer<
  typeof AgentWorkspaceTreeResultSchema
>;

export const AgentWorkspaceFileReadParamsSchema = z
  .object({
    /** The agent whose home dir is the read base. */
    agent_id: z.string().min(1),
    /** Optional L2 scope. Omitted = read from the agent home/L1 dir. Present =
     *  read from the daemon-resolved per-workspace memory dir. */
    workspace_id: z.string().min(1).optional(),
    /** Virtual path under the agent home (e.g. `system_prompt.md`,
     *  `notes/work-log.md`). The daemon parses + resolves with the
     *  per-segment rules described above. */
    path: z.string().min(1),
  })
  .strict();
export type AgentWorkspaceFileReadParams = z.infer<
  typeof AgentWorkspaceFileReadParamsSchema
>;

export const AgentWorkspaceFileReadResultSchema = z
  .object({
    ok: z.literal(true),
    /** Single-file read: 64KB preview cap with a `truncated` flag the
     *  renderer surfaces as a banner. */
    file: AgentWorkspaceFileReadSchema,
  })
  .strict();
export type AgentWorkspaceFileReadResult = z.infer<
  typeof AgentWorkspaceFileReadResultSchema
>;

/**
 * Shared error taxonomy for the two new intents. The daemon never
 * distinguishes "your path was malformed" from "you tried to escape"
 * on the wire — both look like `forbidden_path` so a probe can't use
 * the error class to enumerate filesystem layout.
 */
export const AgentWorkspaceFsErrorCodeSchema = z.enum([
  /** Caller-supplied path is shape-rejected OR resolution would escape
   *  the agent home base (symlink in chain, realpath crossed the
   *  boundary). Route projects 400/403. */
  'forbidden_path',
  /** Graceful missing along the walk (ENOENT/ENOTDIR on a non-leaf,
   *  the leaf is a directory when the read endpoint asked for a file,
   *  etc). Route projects 404. */
  'not_found',
  /** A scoped regular workspace id exists in the control plane but has no
   *  daemon registry binding, so the daemon refuses to guess a path. Route
   *  projects 409. */
  'workspace_not_provisioned',
  /** The daemon cannot consult its workspace registry (no control-plane
   *  binding yet, foreign/corrupt registry file). Route projects 503. */
  'registry_unavailable',
  /** Hard host-local fs failure (perm/IO/EROFS/…). Route projects 503. */
  'fs_unavailable',
  'internal_error',
]);
export type AgentWorkspaceFsErrorCode = z.infer<
  typeof AgentWorkspaceFsErrorCodeSchema
>;

const AgentWorkspaceFsIpcErrorSchema = z
  .object({
    code: z.union([
      ResponseErrorCodeSchema,
      AgentWorkspaceFsErrorCodeSchema,
    ]),
    message: z.string(),
  })
  .strict();

// ── D4.e-3: agent_l2_seed ────────────────────────────────────────────
// Seeds a member agent's L2 (per-workspace) memory dir
// `<workspace>/.silverhand/agents/<agent_id>/` (MEMORY.md + notes/) on the
// OWNING daemon. Replaces backend `seedAgentL2` (G1). The backend forwards
// only semantic ids; the daemon resolves the workspace path from its
// registry (regular-only — agent-home L2 == L1 and is already materialized
// by `agent_materialize`, so it is never seeded here) and writes the L2
// template, which is the L1 template MINUS `system_prompt.md` (L1-only
// invariant). Idempotent: existing files are preserved, never overwritten.
export const AgentL2SeedParamsSchema = z
  .object({
    /** The member agent whose L2 dir is seeded under the workspace. */
    agent_id: z.string().min(1),
    /**
     * The REGULAR workspace to seed into. The daemon resolves its
     * host-local path from the registry (fail-closed if not provisioned);
     * no path crosses the wire (I1). An agent-home id is not in the
     * registry → `workspace_not_provisioned` (this intent is regular-only;
     * the backend never sends `kind`).
     */
    workspace_id: z.string().min(1),
    /** Template identifier (matches `agent_materialize`'s wire enum). */
    template_choice: z
      .enum(['default', 'onboarding', 'minimal'])
      .default('default'),
  })
  .strict();
export type AgentL2SeedParams = z.infer<typeof AgentL2SeedParamsSchema>;

export const AgentL2SeedResultSchema = z
  .object({
    ok: z.literal(true),
    /** True when this call wrote at least one new file (false on an
     *  idempotent re-seed where everything already existed). */
    seeded: z.boolean(),
    /** True when the L2 `MEMORY.md` is present after the call (always true
     *  on success — a sanity flag the route/tests assert). */
    l2_present: z.boolean(),
  })
  .strict();
export type AgentL2SeedResult = z.infer<typeof AgentL2SeedResultSchema>;

export const AgentL2SeedErrorCodeSchema = z.enum([
  /**
   * The workspace has no registry binding (never provisioned / adopted).
   * Fail-closed: the daemon never derives a path from a backend-supplied
   * value, and the L2 seed cannot proceed without the bound path.
   */
  'workspace_not_provisioned',
  /** Whole-registry failure (foreign identity / corrupt file). */
  'registry_unavailable',
  /** `template_choice` is structurally valid but has no host-side entry. */
  'unsupported_template',
  /** A host-local fs write failed HARD (perm/IO/EROFS/ENOSPC). */
  'fs_unavailable',
  'internal_error',
]);
export type AgentL2SeedErrorCode = z.infer<typeof AgentL2SeedErrorCodeSchema>;

const AgentL2SeedIpcErrorSchema = z
  .object({
    code: z.union([ResponseErrorCodeSchema, AgentL2SeedErrorCodeSchema]),
    message: z.string(),
  })
  .strict();

// ── D4.e-4: agent_files_purge ────────────────────────────────────────
// Removes an agent's host-local files on the OWNING daemon. Replaces the
// backend `DELETE /api/agents/:id` `fs.rm(l1_path / l2_paths)` block (G3):
// the backend forwards only semantic ids + scope; the daemon resolves L1
// (its homedir, `<home>/.silverhand/agents/<agent_id>`) and each L2
// (`<workspace>/.silverhand/agents/<agent_id>`, workspace path from the
// registry) itself — no fs path crosses the wire (I1). `scope:'all'` purges
// L1 + the listed workspaces' L2; `scope:'l2'` purges only the listed L2
// (L1 untouched). Idempotent: a target that is already gone (ENOENT) counts
// as success, not a failure. Fail-closed (§3.3): a HARD fs error on any
// target → typed `partial_purge` so the route keeps the DB row for retry; a
// workspace with no registry binding has no daemon-managed L2 dir to purge
// and is reported (`skipped_unprovisioned`), never silently dropped.
export const AgentFilesPurgeParamsSchema = z
  .object({
    /** The agent whose host-local files are removed. */
    agent_id: z.string().min(1),
    /**
     * `all` → purge the agent's L1 home dir AND each listed workspace's L2;
     * `l2` → purge only the listed workspaces' L2 (L1 preserved).
     */
    scope: z.enum(['all', 'l2']),
    /**
     * REGULAR workspace ids whose L2 dir for this agent should be purged.
     * The daemon resolves each one's host-local path from the registry
     * (fail-closed — no path crosses the wire, I1). An id with no binding
     * has no daemon-managed L2 dir and is counted in
     * `skipped_unprovisioned`. Defaults to `[]` (e.g. `scope:'all'` with no
     * regular memberships → L1-only purge).
     */
    workspace_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type AgentFilesPurgeParams = z.infer<typeof AgentFilesPurgeParamsSchema>;

export const AgentFilesPurgeResultSchema = z
  .object({
    ok: z.literal(true),
    /** Number of target dirs that existed and were removed (ENOENT targets
     *  are NOT counted — there was nothing to purge). */
    purged_count: z.number().int().nonnegative(),
    /** Number of listed workspaces with no registry binding (no
     *  daemon-managed L2 dir to purge). Reported, never silently dropped. */
    skipped_unprovisioned: z.number().int().nonnegative(),
  })
  .strict();
export type AgentFilesPurgeResult = z.infer<typeof AgentFilesPurgeResultSchema>;

export const AgentFilesPurgeErrorCodeSchema = z.enum([
  /**
   * One or more target dirs could not be removed because of a HARD fs error
   * (perm/IO/EROFS/ENOSPC — NOT ENOENT). Fail-closed (§3.3): the route keeps
   * the DB row so a later retry has its routing anchor. May be raised even
   * when zero targets succeeded (the purge did not fully complete).
   */
  'partial_purge',
  /** Whole-registry failure (foreign identity / corrupt file) — cannot
   *  safely resolve ANY L2 path, so the purge is blocked fail-closed. */
  'registry_unavailable',
  'internal_error',
]);
export type AgentFilesPurgeErrorCode = z.infer<
  typeof AgentFilesPurgeErrorCodeSchema
>;

const AgentFilesPurgeIpcErrorSchema = z
  .object({
    code: z.union([ResponseErrorCodeSchema, AgentFilesPurgeErrorCodeSchema]),
    message: z.string(),
  })
  .strict();


// ── #task:1135: profile MCP read / write ─────────────────────────────
// Backs `silverhand profile mcp get|set`. The subject's raw MCP config is
// host-local L1 truth (`<home>/.silverhand/agents/<id>/mcp.json`); the backend
// never stores raw bytes. Read returns the raw text (or null when absent — the
// normal "no MCP" case, NOT an error). Write validates the canonical schema
// (fail-loud `invalid_config`) and atomically replaces the file. The daemon
// resolves the L1 dir itself (`resolveAgentDir`) — no fs path crosses the wire.
export const AgentProfileMcpReadParamsSchema = z
  .object({ agent_id: z.string().min(1) })
  .strict();
export type AgentProfileMcpReadParams = z.infer<
  typeof AgentProfileMcpReadParamsSchema
>;

export const AgentProfileMcpReadResultSchema = z
  .object({
    ok: z.literal(true),
    /** Raw file text, or null when no `mcp.json` exists yet. */
    raw: z.string().nullable(),
  })
  .strict();
export type AgentProfileMcpReadResult = z.infer<
  typeof AgentProfileMcpReadResultSchema
>;

export const AgentProfileMcpWriteParamsSchema = z
  .object({
    agent_id: z.string().min(1),
    /** Raw JSON text to persist. The daemon re-validates (belt) and writes
     *  atomically; the backend route is the primary validation authority. */
    raw: z.string(),
  })
  .strict();
export type AgentProfileMcpWriteParams = z.infer<
  typeof AgentProfileMcpWriteParamsSchema
>;

export const AgentProfileMcpWriteResultSchema = z
  .object({
    ok: z.literal(true),
    bytes_written: z.number().int().nonnegative(),
  })
  .strict();
export type AgentProfileMcpWriteResult = z.infer<
  typeof AgentProfileMcpWriteResultSchema
>;

export const AgentProfileMcpErrorCodeSchema = z.enum([
  /** Raw failed canonical validation (bad JSON / schema). Write-only;
   *  fail-loud, nothing is persisted. Route projects 400. */
  'invalid_config',
  /** Hard host-local fs failure (perm/IO/EROFS). Route projects 503. */
  'fs_unavailable',
  'internal_error',
]);
export type AgentProfileMcpErrorCode = z.infer<
  typeof AgentProfileMcpErrorCodeSchema
>;

const AgentProfileMcpIpcErrorSchema = z
  .object({
    code: z.union([ResponseErrorCodeSchema, AgentProfileMcpErrorCodeSchema]),
    message: z.string(),
  })
  .strict();

// ── #task:1137: live MCP probe ───────────────────────────────────────
// Backs `silverhand profile mcp probe` and the agent-pane "Test connection" /
// "List tools" buttons. The daemon opens ONE short-lived MCP connection to the
// named server, runs `initialize` (+ optional `tools/list`), and closes it
// immediately. The probe SOURCE is scope-discriminated so a future workspace
// layer reuses the command: v1 ships the `profile` arm only (the agent's L1
// `mcp.json`); a workspace arm slots in alongside without re-signing the
// command. The server is named by its RAW name — a probe connects to the real
// endpoint, never the `silverhand_<scope>__` runtime name.
export const McpProbeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), agent_id: z.string().min(1) }).strict(),
  // future: z.object({ kind: z.literal('workspace'), workspace_id: ... })
]);
export type McpProbeSource = z.infer<typeof McpProbeSourceSchema>;

export const McpProbeParamsSchema = z
  .object({
    source: McpProbeSourceSchema,
    /** Raw (user-visible) server name to probe. */
    server_name: z.string().min(1),
    /** When true, also run `tools/list` after `initialize`. */
    include_tools: z.boolean().optional(),
  })
  .strict();
export type McpProbeParams = z.infer<typeof McpProbeParamsSchema>;

// The probe RESULT shape is canonical in `@silverhand/shared` (shared with the
// backend route, CLI, and renderer). Re-export it here so the intent registry
// and dispatcher source all three of an intent's types from one module.
export type { McpProbeResult } from '@silverhand/shared';

// Outcome of the connect/initialize/tools walk (canonical shape in
// `@silverhand/shared`): connection/handshake/tools failures live INSIDE the
// result (`ok:false` + `phase`), they are not IPC errors.

export const McpProbeErrorCodeSchema = z.enum([
  /** Host-local fs fault that prevents reading the source config at all
   *  (perm/IO; ENOENT is handled as a normal `not_found` result). 503. */
  'fs_unavailable',
  'internal_error',
]);
export type McpProbeErrorCode = z.infer<typeof McpProbeErrorCodeSchema>;

const McpProbeIpcErrorSchema = z
  .object({
    code: z.union([ResponseErrorCodeSchema, McpProbeErrorCodeSchema]),
    message: z.string(),
  })
  .strict();


/**
 * Single source of truth for the intent ↔ params / result / error
 * type triple. The client uses it to enforce that
 * `host.call('echo', {...})` only accepts echo-shaped params and
 * returns echo-shaped results; the daemon dispatcher uses it to
 * parse incoming params before handing to a handler, AND to
 * validate the typed error code it is about to emit on the wire.
 *
 * `error` is OPTIONAL on the entry shape. Intents without an
 * explicit `error` entry use `ResponseErrorSchema` (the 5
 * transport-level codes) at IPC validation time. Only intents
 * that may legitimately surface daemon-business typed codes —
 * `agent_materialize` (D4.d) plus the D4.e workspace data-plane
 * intents `workspace_provision` / `agent_workspace_index` /
 * `agent_l2_seed` / `agent_files_purge` — declare their own widened error schema. The wire surface stays
 * per-intent-scoped (Cindy D2 P1-1 + D1 round-1 P1): a typed code
 * in one intent's error arm cannot leak into another intent's
 * error arm at validation time.
 */
export const intentSchemas = {
  hello: {
    params: HelloParamsSchema,
    result: HelloResultSchema,
  },
  ping: {
    params: PingParamsSchema,
    result: PingResultSchema,
  },
  status: {
    params: StatusParamsSchema,
    result: StatusResultSchema,
  },
  echo: {
    params: EchoParamsSchema,
    result: EchoResultSchema,
  },
  // #task:808 — host snapshot for the ComputerPane. Dispatched here so the
  // shared `IntentDispatcher` validates params/result via the same registry
  // every other intent uses; the outbound WS surface re-references the same
  // schemas in `outboundServerCommandSchemas` so embedded local-socket and
  // standalone WSS reach the same handler path. Generic error taxonomy is
  // sufficient — failures are transport-level (timeout / disconnected /
  // shutting_down) and surface through the adapter wrapper.
  host_status: {
    params: HostStatusParamsSchema,
    result: HostStatusResultSchema,
  },
  host_runtime_catalog: {
    params: HostRuntimeCatalogParamsSchema,
    result: HostRuntimeCatalogResultSchema,
  },
  conversation_log_debug: {
    params: ConversationLogDebugParamsSchema,
    result: ConversationLogDebugResultSchema,
  },
  agent_message_send: {
    params: AgentMessageSendParamsSchema,
    result: AgentMessageSendResultSchema,
  },
  agent_stale_resolve: {
    params: AgentStaleResolveParamsSchema,
    result: AgentStaleResolveResultSchema,
  },
  agent_stream_observed: {
    params: AgentStreamObservedParamsSchema,
    result: AgentStreamObservedResultSchema,
  },
  runtime_start: {
    params: RuntimeStartParamsSchema,
    result: RuntimeStartResultSchema,
    // D4.e-6 — daemon now resolves all paths and fails closed on
    // unresolvable workspaces; the typed taxonomy lets the backend
    // tell `workspace_not_provisioned` (backfill + retry),
    // `workspace_path_missing` (host-local files missing), and
    // `registry_unavailable` (hard fail) apart from a generic
    // `internal_error`. Per-command scoped like agent_materialize.
    error: RuntimeStartIpcErrorSchema,
  },
  runtime_stop: {
    params: RuntimeStopParamsSchema,
    result: RuntimeStopResultSchema,
  },
  runtime_wake: {
    params: RuntimeWakeParamsSchema,
    result: RuntimeWakeResultSchema,
  },
  runtime_status: {
    params: RuntimeStatusParamsSchema,
    result: RuntimeStatusResultSchema,
  },
  runtime_clear_session: {
    params: RuntimeClearSessionParamsSchema,
    result: RuntimeClearSessionResultSchema,
  },
  runtime_stop_all: {
    params: RuntimeStopAllParamsSchema,
    result: RuntimeStopAllResultSchema,
  },
  runtime_close_activity_log: {
    params: RuntimeCloseActivityLogParamsSchema,
    result: RuntimeCloseActivityLogResultSchema,
  },
  runtime_output_pause: {
    params: RuntimeOutputPauseParamsSchema,
    result: RuntimeOutputPauseResultSchema,
  },
  runtime_output_resume: {
    params: RuntimeOutputResumeParamsSchema,
    result: RuntimeOutputResumeResultSchema,
  },
  host_outbound_attach: {
    params: HostOutboundAttachParamsSchema,
    result: HostOutboundAttachResultSchema,
  },
  host_outbound_detach: {
    params: HostOutboundDetachParamsSchema,
    result: HostOutboundDetachResultSchema,
  },
  host_outbound_reload: {
    params: HostOutboundReloadParamsSchema,
    result: HostOutboundReloadResultSchema,
  },
  host_proxy_config_get: {
    params: HostProxyConfigGetParamsSchema,
    result: HostProxyConfigGetResultSchema,
  },
  host_proxy_config_set: {
    params: HostProxyConfigSetParamsSchema,
    result: HostProxyConfigSetResultSchema,
  },
  // D4.d D2: agent_materialize is server↔daemon formal semantics
  // (see comment block above `AgentMaterializeParamsSchema`). The
  // handler is wired through DispatcherOptions.agentMaterializeHandler
  // in `daemon/dispatcher.ts`; when the slot is empty (e.g., legacy
  // test wiring), the dispatcher returns `internal_error` like every
  // other handler slot. `error` widens to the 5 generic codes plus
  // the materialize-specific taxonomy (Cindy D2 P1-1: this is what
  // lets `HostClient.handleFrame` reject typed codes via the wire
  // for the local IPC adapter — without the per-intent error entry
  // here, the transport would silently drop typed-error frames
  // because the strict `ResponseErrorSchema` wouldn't accept them).
  agent_materialize: {
    params: AgentMaterializeParamsSchema,
    result: AgentMaterializeResultSchema,
    error: AgentMaterializeIpcErrorSchema,
  },
  // D4.e-1: data-plane path-authority intents. Same per-command typed
  // error scoping as agent_materialize — each widens the 5 generic codes
  // with its own taxonomy and nothing else, so a typed code from one
  // intent cannot leak onto another's wire error. `workspace_provision`
  // also carries the OPTIONAL caller-proposed `requested_path` (M1
  // folder-picker / sandbox typed path / legacy backfill all unify here);
  // when absent the daemon self-picks the managed default. There is NO
  // separate adopt/bind intent — path provisioning is one operation.
  workspace_provision: {
    params: WorkspaceProvisionParamsSchema,
    result: WorkspaceProvisionResultSchema,
    error: WorkspaceProvisionIpcErrorSchema,
  },
  agent_workspace_index: {
    params: AgentWorkspaceIndexParamsSchema,
    result: AgentWorkspaceIndexResultSchema,
    error: AgentWorkspaceIndexIpcErrorSchema,
  },
  agent_workspace_tree: {
    params: AgentWorkspaceTreeParamsSchema,
    result: AgentWorkspaceTreeResultSchema,
    error: AgentWorkspaceFsIpcErrorSchema,
  },
  agent_workspace_file_read: {
    params: AgentWorkspaceFileReadParamsSchema,
    result: AgentWorkspaceFileReadResultSchema,
    error: AgentWorkspaceFsIpcErrorSchema,
  },
  agent_l2_seed: {
    params: AgentL2SeedParamsSchema,
    result: AgentL2SeedResultSchema,
    error: AgentL2SeedIpcErrorSchema,
  },
  agent_files_purge: {
    params: AgentFilesPurgeParamsSchema,
    result: AgentFilesPurgeResultSchema,
    error: AgentFilesPurgeIpcErrorSchema,
  },
  agent_profile_mcp_read: {
    params: AgentProfileMcpReadParamsSchema,
    result: AgentProfileMcpReadResultSchema,
    error: AgentProfileMcpIpcErrorSchema,
  },
  agent_profile_mcp_write: {
    params: AgentProfileMcpWriteParamsSchema,
    result: AgentProfileMcpWriteResultSchema,
    error: AgentProfileMcpIpcErrorSchema,
  },
  mcp_probe: {
    params: McpProbeParamsSchema,
    result: McpProbeResultSchema,
    error: McpProbeIpcErrorSchema,
  },
} as const;

export type IntentName = keyof typeof intentSchemas;
export type IntentParams<N extends IntentName> = z.infer<
  (typeof intentSchemas)[N]['params']
>;
export type IntentResult<N extends IntentName> = z.infer<
  (typeof intentSchemas)[N]['result']
>;
export type IntentError<N extends IntentName> =
  (typeof intentSchemas)[N] extends { error: infer E extends z.ZodType }
    ? z.infer<E>
    : ResponseError;

/**
 * Resolve the per-intent typed-error schema, falling back to
 * `ResponseErrorSchema` for intents whose entry has no `error`
 * field. Consumed by `IntentDispatcher.dispatch` to validate the
 * typed code it emits, and by `HostClient.handleFrame` to validate
 * the typed code it receives. The fallback is the load-bearing
 * piece — without it the 17 intents that don't override would each
 * need a no-op `error: ResponseErrorSchema` line just to keep the
 * lookup total.
 *
 * Also tolerates `intent` strings NOT in the registry (e.g. an
 * older client dispatching a removed-since-v0 name like
 * `runtime_inject_env`): the daemon answers `unknown_intent`,
 * which IS in the generic taxonomy, so `ResponseErrorSchema` is
 * the right default. Without this tolerance the lookup would crash
 * with `Cannot read properties of undefined (reading 'error')` and
 * the client would translate a clean rejection into a hang.
 */
export function intentErrorSchema(
  intent: string,
): z.ZodType<{ code: string; message: string }> {
  const entry = (intentSchemas as Record<string, { error?: unknown } | undefined>)[
    intent
  ];
  const error = entry?.error;
  if (error) return error as z.ZodType<{ code: string; message: string }>;
  return ResponseErrorSchema;
}

// ── Frame schemas ───────────────────────────────────────────────────

export const RequestFrameSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  params: z.unknown(),
});
export type RequestFrame = z.infer<typeof RequestFrameSchema>;

/**
 * Generic-error frame. The `code` enum lives at
 * `ResponseErrorCodeSchema` above so per-intent typed-error
 * schemas (e.g. `AgentMaterializeIpcErrorSchema`) can reference
 * the same enum without drift.
 */
export const ResponseErrorSchema = z.object({
  code: ResponseErrorCodeSchema,
  message: z.string(),
});
export type ResponseError = z.infer<typeof ResponseErrorSchema>;

export const ResponseFrameSchema = z.union([
  z
    .object({
      id: z.string().min(1),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      error: ResponseErrorSchema,
    })
    .strict(),
]);
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;

/**
 * Transport-layer loose variant of `ResponseFrame` (Cindy D2 P1-1).
 *
 * The strict `ResponseFrameSchema` above only admits the 5 generic
 * `ResponseErrorSchema` codes in the `error.code` field. The
 * transport layer (`SocketTransport.deliverFrame`) sits BELOW the
 * intent dispatcher, so at frame-arrival time it does not yet know
 * which intent the response correlates to — and therefore which
 * typed-error code set is legal. Using the strict frame schema at
 * that layer would cause it to silently drop response frames
 * carrying per-intent typed codes (e.g. `agent_dir_collision` from
 * `agent_materialize`), leaving the pending IPC request to time
 * out. That's the bug Cindy identified.
 *
 * The loose schema accepts `error.code: string` so the transport
 * can deliver the frame upward; `HostClient.handleFrame` then
 * looks up the pending request's intent name and validates the
 * received code against `intentErrorSchema(intent)` before
 * rejecting the typed `HostClientError`. Drift (unknown code for
 * that intent) is itself surfaced as a typed `internal_error` so
 * the caller still gets a clean reject path.
 */
const LooseResponseErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

export const LooseResponseFrameSchema = z.union([
  z
    .object({
      id: z.string().min(1),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      error: LooseResponseErrorSchema,
    })
    .strict(),
]);
export type LooseResponseFrame = z.infer<typeof LooseResponseFrameSchema>;

/**
 * Unsolicited events. Two categories:
 *
 *  - **droppable** = legacy `runtime_output` only. Production
 *    supervisor wiring no longer emits raw child stdout/stderr by
 *    default: tool output is unbounded and would duplicate the
 *    structured parsed/state stream. The frame remains in the schema
 *    for compatibility and targeted diagnostics; when emitted it is
 *    still subject to the per-(conv,agent) 4 MiB un-flushed buffer cap
 *    (§2.2.2 of design lock). Daemon may emit
 *    `runtime_output_dropped` when bytes are discarded — that ack
 *    itself is non-droppable.
 *  - **non-droppable** = everything else. Daemon must never sacrifice
 *    one of these to relieve backpressure.
 *
 *  PR-1 surface kept verbatim:
 *
 *  - `ready`         — daemon socket is bound; handshake signal mirrored
 *                      to stdout for the spawn helper.
 *  - `shutting_down` — daemon received SIGTERM/SIGINT and is draining.
 *
 *  PR-2 step 1 surface (matches design doc §3.2):
 *
 *  - `runtime_state` / `runtime_output` / `runtime_exit` / `runtime_ready_for_drain`
 *  - `runtime_startup_delivery_consumed` / `runtime_startup_delivery_failed`
 *  - `runtime_output_dropped` / `runtime_output_paused` / `runtime_output_resumed`
 *
 *  PR-2 step 2 surface (Cindy `vqDWkLFF6pAeIE5t`):
 *
 *  - `runtime_init_timeout` / `runtime_init_retrying` / `runtime_init_cooldown`
 *    — daemon-internal init-watchdog / retry / cooldown loop exposed
 *    to backend so backend can drive UI (`agent_status` SSE) + DB
 *    projection without owning the retry state machine.
 *
 *  PR-2 step 2 commit 3b (Cindy `OQCA05pivtB8nSTC` + `C2BZGDbQWfnq-bKJ`):
 *
 *  - `runtime_parsed_event` — non-droppable structured runtime
 *    projection. Each line the driver's `parseLine` recognizes
 *    becomes one of these frames. This is the production activity /
 *    coordination surface; raw `runtime_output` is legacy/diagnostic.
 *  - `runtime_parsed_event_dropped` — non-droppable metadata-only
 *    frame the daemon emits when a parsed event's encoded form
 *    exceeds `MAX_FRAME_BYTES`. Carries `parsed_kind` + `encoded_bytes`
 *    + `reason:'frame_too_large'` ONLY; explicitly NO payload (no
 *    raw line, no tool input, no text) so we never half-leak a
 *    truncated event onto the wire.
 */
export const EventFrameSchema = z.discriminatedUnion('event', [
  HelloResultSchema.extend({
    event: z.literal('ready'),
    socket_path: z.string(),
    daemon_pid: z.number().int(),
    started_at: z.number().int(),
  }),
  z.object({
    event: z.literal('shutting_down'),
    reason: z.string(),
  }),
  // ── runtime_* events ────────────────────────────────────────────
  z.object({
    event: z.literal('runtime_state'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    state: AgentRunStateSchema,
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_output'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    /** Raw bytes from the child process, base64-free utf-8 string.
     *  This is the ONLY droppable field on the wire — see the per-
     *  stream cap in design doc §2.2.2. */
    chunk: z.string(),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_exit'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    code: z.number().int().nullable(),
    intentional: z.boolean(),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_ready_for_drain'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_startup_delivery_consumed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_startup_delivery_failed'),
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
  }).strict(),
  // ── runtime init lifecycle (locked by Cindy `vqDWkLFF6pAeIE5t`) ──
  //
  // These three events surface the daemon-internal init watchdog +
  // retry loop to backend. Init lifecycle is ORTHOGONAL to
  // `runtime_startup_delivery_*`: empty-inbox and self-init paths
  // have no startup_delivery to attach to but still get watchdog
  // timeouts / retries / cooldown. Backend doesn't own retry — daemon
  // does — but backend translates each event into UI / DB projection
  // (`agent_status` SSE, `updateAgentRuntime` columns, crash
  // notifications) since it owns those surfaces.
  //
  // Sequence over a typical failure path (retry_attempt is 0-indexed,
  // matching CM's `handle.initAttempt`):
  //   runtime_init_timeout (retry_attempt=0, retrying=true) →
  //   runtime_init_retrying (retry_attempt=1 of N) →
  //   runtime_init_timeout (retry_attempt=1, retrying=true) →
  //   ... →
  //   runtime_init_timeout (retry_attempt=N-1, retrying=false, cooldown_until=…) →
  //   runtime_init_cooldown (attempts_exhausted = N).
  // The cooldown path may also fire with retry_attempt=0 if max_retries=0.
  // The terminal `runtime_exit` follows separately when the daemon
  // gives up and the child process is gone.
  z.object({
    event: z.literal('runtime_init_timeout'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** Which watchdog tier tripped (mirrors CM's three-tier
     *  PR-A watchdog: silence between bytes / pre-protocol cap /
     *  post-protocol stall). Names match CM's `InitTimeoutReason` so
     *  backend can pass the value straight through to `agent_init_timeout`
     *  SSE without translation (Cindy `4CJATqU0DdbsGVXW`). */
    timeout_reason: z.enum(['silence', 'pre_protocol_cap', 'post_protocol']),
    /** Wall-clock ms between spawn and watchdog firing — only the
     *  daemon has the precise spawn timestamp, so we ship it on the
     *  same event rather than asking backend to reconstruct it. */
    elapsed_ms: z.number().int().nonnegative(),
    /** The configured timeout value (ms) for the tier that fired —
     *  varies per driver and may be overridden by daemon config. */
    timeout_ms: z.number().int().nonnegative(),
    /** True iff the daemon has already decided to re-spawn after this
     *  timeout. False means cooldown / give-up — a `runtime_exit`
     *  follows and no `runtime_init_retrying` will. Lets backend mark
     *  the projection terminal in a single hop without buffering. */
    retrying: z.boolean(),
    /** 0-indexed attempt number that just timed out (first attempt
     *  is 0). Matches CM's `handle.initAttempt` semantics. */
    retry_attempt: z.number().int().nonnegative(),
    /** Total retry budget the daemon will honor before cooldown. */
    max_retries: z.number().int().nonnegative(),
    /** Optional: present iff this timeout transition also engaged
     *  cooldown — wall-clock epoch ms when backend / user may
     *  attempt a fresh start. Carrying it on the same event keeps the
     *  cooldown-on-timeout path self-contained; backend never has to
     *  wait for a follow-up `runtime_init_cooldown` to know whether
     *  to publish `agent_status:crashed reason=init_cooldown` vs
     *  `init_timeout`. */
    cooldown_until: z.number().int().positive().optional(),
    ts: z.number().int(),
  }).strict(),
  z.object({
    event: z.literal('runtime_init_retrying'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** The attempt number about to start (= the previous timeout's
     *  retry_attempt + 1). */
    retry_attempt: z.number().int().positive(),
    max_retries: z.number().int().nonnegative(),
    /** How long the daemon will wait before re-spawning, ms. */
    delay_ms: z.number().int().nonnegative(),
    ts: z.number().int(),
  }).strict(),
  z.object({
    event: z.literal('runtime_init_cooldown'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** Wall-clock epoch ms after which backend / user may attempt a
     *  fresh start. Daemon will NOT auto-retry past this point. */
    cooldown_until: z.number().int().positive(),
    /** Total attempts that failed before cooldown engaged (== max_retries). */
    attempts_exhausted: z.number().int().nonnegative(),
    ts: z.number().int(),
  }).strict(),
  // ── runtime_compaction_stale (Cindy `-pdNvRYOWip5e9yA` 3c plan
  //     refinement) ───────────────────────────────────────────────
  //
  // Per-handle compaction watchdog (5 min, matches CM
  // COMPACTION_STALE_MS) fired without observing `compaction_finished`.
  // CRITICAL: this is observational only — daemon DOES NOT kill the
  // child or change phase. CM's `recordCompactionStale` preserves
  // `compacting: true` and only stacks `compactionStale: true` on the
  // run-state, so the UI can show "still compacting, but stale"
  // instead of "no longer compacting". Backend maps this 1:1 onto
  // the existing `compaction_stale` SSE event.
  //
  // Non-droppable: backend depends on this to refresh `compactionStale`
  // in its RunStateCache; dropping would leave the UI showing fresh
  // compacting state indefinitely. Single implicit reason
  // (watchdog timeout) — additional reasons would each get their own
  // strict() variant.
  z.object({
    event: z.literal('runtime_compaction_stale'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** Ms elapsed since `compaction_started` was observed, at the
     *  moment the watchdog fired. */
    elapsed_ms: z.number().int().nonnegative(),
    ts: z.number().int(),
  }).strict(),
  z.object({
    event: z.literal('runtime_output_dropped'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    dropped_count: z.number().int().nonnegative(),
    bytes_dropped: z.number().int().nonnegative(),
    since_ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_output_paused'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  z.object({
    event: z.literal('runtime_output_resumed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  // ── runtime parsed event fanout (locked by Cindy `OQCA05pivtB8nSTC` +
  //     `C2BZGDbQWfnq-bKJ`) ─────────────────────────────────────────
  //
  // `runtime_parsed_event` is the structured runtime projection
  // surface: each line the driver's `parseLine` recognizes becomes
  // one of these frames. Production no longer forwards raw child
  // stdout/stderr by default (`runtime_output` is a legacy/diagnostic
  // compatibility arm) because tool output is unbounded and can fill
  // the outbound socket buffer. Backend observability / activity UI /
  // delivery coordination must use parsed/state events instead.
  //
  // Non-droppable: backend's `handleParsedEvent` drives the
  // AgentRunState lifecycle (thinking / tool_running / compacting /
  // turn_end) and the `session_events` DB projection. Dropping one
  // would leave run-state stuck or DB out of sync, neither of which
  // is recoverable from `runtime_output` alone (only the driver
  // knows the schema).
  //
  // No `raw_line` field: carrying raw bytes here would reintroduce
  // the same unbounded tool-output channel this split is meant to
  // avoid. The `parsed` payload is the bounded structured contract.
  z
    .object({
      event: z.literal('runtime_parsed_event'),
      conversation_id: z.string().min(1),
      agent_id: z.string().min(1),
      parsed: ParsedEventSchema,
      ts: z.number().int(),
    })
    .strict(),
  // `runtime_parsed_event_dropped` is the safety valve when a parsed
  // event's encoded payload exceeds MAX_FRAME_BYTES. We CANNOT silently
  // truncate the `parsed` payload (Cindy: "frame 保护不要静默改写任意
  // ParsedEvent") — that would let backend believe it received a
  // complete `tool_call` / `text` / `unknown.raw` when it didn't.
  //
  // The dropped frame is metadata-only by hard rule (Cindy
  // `C2BZGDbQWfnq-bKJ`): `parsed_kind` lets backend project a
  // best-effort run-state hint (e.g. "we know a tool_call happened
  // even though we lost the input"), `encoded_bytes` lets backend
  // logs surface the size budget, and `reason` is a single-arm enum.
  // NO payload — explicitly NO `unknown.raw`, NO tool input, NO text.
  //
  // Note: this dropped frame is on the WIRE only. Supervisor
  // still updates its in-memory AgentRunState from the original
  // ParsedEvent before encoding — frame-too-large is a broadcast
  // concern, not a run-state concern (Cindy `C2BZGDbQWfnq-bKJ`).
  z
    .object({
      event: z.literal('runtime_parsed_event_dropped'),
      conversation_id: z.string().min(1),
      agent_id: z.string().min(1),
      parsed_kind: ParsedEventKindSchema,
      encoded_bytes: z.number().int().nonnegative(),
      reason: z.literal('frame_too_large'),
      ts: z.number().int(),
    })
    .strict(),
]);
export type EventFrame = z.infer<typeof EventFrameSchema>;

/**
 * Any frame either side may put on the wire. Daemon sends Response
 * (always) or Event (occasionally); client sends Request only. Treat
 * `event` field's presence as the discriminator over `id`.
 */
export const AnyFrameSchema = z.union([
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
]);
export type AnyFrame = z.infer<typeof AnyFrameSchema>;

/**
 * Transport-layer loose variant of `AnyFrameSchema` (Cindy D2 P1-1).
 * Substitutes `LooseResponseFrameSchema` for `ResponseFrameSchema`
 * so per-intent typed error codes survive the transport-layer
 * frame validation. The intent-aware validation happens one layer
 * up, in `HostClient.handleFrame`. See `LooseResponseFrameSchema`
 * for the full rationale.
 */
export const LooseAnyFrameSchema = z.union([
  RequestFrameSchema,
  LooseResponseFrameSchema,
  EventFrameSchema,
]);
export type LooseAnyFrame = z.infer<typeof LooseAnyFrameSchema>;

// ── Wire encoding ───────────────────────────────────────────────────

/** Hard cap on one frame's encoded size. Guards both directions from
 *  pathological payloads and gives us a clean error to surface
 *  instead of letting the splitter buffer grow without bound.
 *  1 MiB is generous for PR-2's intent surface — `runtime_wake` and
 *  `runtime_start.startup_delivery` carry one stream-json line each,
 *  which is well under the cap in practice. */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024;

/** Encode an outgoing frame to its NDJSON wire form (single line +
 *  trailing newline). Throws if the encoded payload would exceed the
 *  per-frame cap so we fail loud at the caller instead of silently
 *  emitting an oversized line the peer will reject. */
export function encodeFrame(frame: AnyFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(
      `host frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  return `${line}\n`;
}

/**
 * Incremental NDJSON splitter — pure function over (buffer, chunk) →
 * (frames[], leftover). Same logic both sides need; lifted out so we
 * can unit-test it on its own.
 *
 * The buffer is held by the caller. We return UTF-8 string frames; the
 * caller JSON.parses + schema-validates each one. Lines longer than
 * `MAX_FRAME_BYTES` are reported via `overflow` so the caller can
 * close the socket with a typed reason rather than letting the buffer
 * grow without bound.
 */
export interface SplitResult {
  /** Newly complete frame strings (without trailing `\n`). */
  frames: string[];
  /** Leftover unterminated bytes — pass back as `buffer` next call. */
  leftover: string;
  /** True if a single line exceeded MAX_FRAME_BYTES while accumulating.
   *  When true, caller must close the socket; further frames cannot be
   *  trusted because we had to drop the overflowing prefix. */
  overflow: boolean;
}

export function splitNdjson(buffer: string, chunk: string): SplitResult {
  const combined = buffer + chunk;
  const frames: string[] = [];
  let start = 0;
  let overflow = false;
  while (true) {
    const nl = combined.indexOf('\n', start);
    if (nl === -1) break;
    const line = combined.slice(start, nl);
    start = nl + 1;
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      overflow = true;
      // Stop accumulating further frames once we detect overflow; the
      // caller is contractually required to tear down the socket.
      return { frames, leftover: '', overflow };
    }
    frames.push(line);
  }
  const leftover = combined.slice(start);
  // Defensive: if the still-unterminated tail already exceeds the cap,
  // we will never close it (no `\n` will arrive in time). Signal
  // overflow now so the caller drops the connection.
  if (Buffer.byteLength(leftover, 'utf8') > MAX_FRAME_BYTES) {
    return { frames, leftover: '', overflow: true };
  }
  return { frames, leftover, overflow };
}
