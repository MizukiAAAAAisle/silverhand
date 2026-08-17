// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: agent. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  AgentSessionScopeSchema,
  AgentMaterializationStatusSchema,
  ConversationAgentStatusSchema,
  ConversationPlacementKindSchema,
  ConversationRosterPolicySchema,
  FastModeSchema,
  ReasoningEffortTokenSchema,
  RuntimeKindSchema,
  WorkspaceKindSchema,
} from '../db/schema.js';
import { DisplayNameSchema } from './user.js';
import { ParticipantNameSchema } from './name.js';
import {
  reasoningEffortValidForRuntime,
  runtimeSupportsFastMode,
} from '../runtime-catalog.js';

export const AgentDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  runtime: RuntimeKindSchema,
  model: z.string().nullable(),
  reasoning_effort: ReasoningEffortTokenSchema.nullable(),
  fast_mode: FastModeSchema.nullable(),
  host_id: z.string(),
  description: z.string().nullable(),
  /** Immutable runtime-session identity selected when the Agent is created. */
  session_scope: AgentSessionScopeSchema,
  /** v26: id of the user who created this agent. The renderer uses it
   *  to decide whether to surface profile-edit affordances (Edit
   *  button, avatar upload). Backend `canEditAgent` is the source of
   *  truth; this field is the renderer's hint. */
  created_by_user_id: z.string(),
  /** v26: resolved avatar URL or null. Matches `UserDto.avatar_url` —
   *  cache-busted by `updated_at`. PR-1 always returns null (no
   *  storage wired); PR-2 flips this on once the storage / route
   *  pair lands. */
  avatar_url: z.string().nullable(),
  /** v33 (D4.d): agent-home materialization lifecycle. Required
   *  because every v33 row has a non-null status — default-list
   *  callers see `'active'`; the failed-row management view
   *  (Q6.a, §7.3) opts in via `?include_failed=1` and reads
   *  `'failed'` here together with the two diagnostic fields
   *  below. `'pending_materialization'` is reserved for the
   *  in-flight window between row reserve and L3a/L3b — readers
   *  see it only when the materialize wire round-trip is still
   *  pending. Note: `idempotency_key` is intentionally NOT
   *  exposed on the default DTO — same-key retry uses a
   *  route-local management payload (Cindy D1 round-2 P2). */
  materialization_status: AgentMaterializationStatusSchema,
  /** v33 (D4.d): populated only when
   *  `materialization_status='failed'`. Mirrors the §3.4 wire→HTTP
   *  error-code mapping plus server-side codes. Kept as
   *  `string | null` (not a narrow enum) so the row column / DTO
   *  / migration do not need a coordinated schema change when a
   *  new server-side code is added — the route layer pins the
   *  exact code set it produces. */
  materialization_failed_code: z.string().nullable(),
  /** v33 (D4.d): epoch ms set together with
   *  `materialization_failed_code`; NULL while the row is in
   *  `pending_materialization` or `active`. */
  materialization_failed_at: z.number().nullable(),
  /** Durable terminal-deletion intent. Non-null means host cleanup/DB commit
   *  is pending or retrying; management readers must not present it as active. */
  deletion_started_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;

export const CreateAgentInputSchema = z
  .object({
    name: ParticipantNameSchema,
    runtime: RuntimeKindSchema,
    model: z.string().optional(),
    reasoning_effort: ReasoningEffortTokenSchema.optional(),
    fast_mode: FastModeSchema.optional(),
    host_id: z.string().optional(), // defaults to the current user's owned local host
    description: z.string().optional(),
    /** Defaults to the established one-runtime-per-conversation model. */
    session_scope: AgentSessionScopeSchema.optional(),
  })
  // reasoning_effort is a bounded opaque token (see ReasoningEffortTokenSchema):
  // the schema accepts ANY structurally-valid token, and the SOLE legality gate
  // is per-runtime/model via `reasoningEffortValidForRuntime`. So a token like
  // Qoder's `none` parses structurally but is simply not in Codex's catalog set,
  // while Codex `max`/`ultra` are legal only on a verified 5.6 model. All fields
  // are present in the create payload, so the authoritative gate closes here.
  .superRefine((val, ctx) => {
    if (
      !reasoningEffortValidForRuntime(
        val.runtime,
        val.reasoning_effort,
        val.model,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasoning_effort'],
        message: `reasoning_effort '${val.reasoning_effort}' is not valid for runtime '${val.runtime}' and model '${val.model ?? 'driver default'}'`,
      });
    }
    if (!runtimeSupportsFastMode(val.runtime) && val.fast_mode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fast_mode'],
        message: `fast_mode is not supported by runtime '${val.runtime}'`,
      });
    }
  });
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

// PATCH /api/agents/:id — every field optional, only provided keys
// are written. `name`, `host_id`, and `runtime` are deliberately excluded:
// `name` is the immutable identifier (see migrations.ts v5 comment),
// `host_id` swap is out of v1 scope, and runtime changes require the dedicated
// transition command rather than an ordinary metadata patch.
//
// Unlike create/switch, this schema has NO reasoning superRefine: PATCH is
// partial, so the effective (runtime, model, token) tuple isn't fully known
// here (runtime is fixed, model may be absent). `reasoning_effort` is only
// bounded structurally by the token schema; its per-runtime/model legality is
// enforced downstream at the service boundary (`normalizeRuntimeTuning`), which
// resolves the token against the agent's current runtime + effective model.
export const UpdateAgentInputSchema = z
  .object({
    display_name: DisplayNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    runtime: z.never().optional(),
    model: z.string().nullable().optional(),
    reasoning_effort: ReasoningEffortTokenSchema.nullable().optional(),
    fast_mode: FastModeSchema.nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

/**
 * Dedicated runtime transition command. Every tuning key is required so a
 * missing field cannot silently select a default. `null` is the caller's
 * explicit "use the target driver's default" choice.
 */
export const SwitchAgentRuntimeInputSchema = z
  .object({
    runtime: RuntimeKindSchema,
    model: z.string().trim().min(1).nullable(),
    reasoning_effort: ReasoningEffortTokenSchema.nullable(),
    fast_mode: FastModeSchema.nullable(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      !reasoningEffortValidForRuntime(
        val.runtime,
        val.reasoning_effort,
        val.model,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasoning_effort'],
        message: `reasoning_effort '${val.reasoning_effort}' is not valid for runtime '${val.runtime}' and model '${val.model ?? 'driver default'}'`,
      });
    }
    if (!runtimeSupportsFastMode(val.runtime) && val.fast_mode !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fast_mode'],
        message: `fast_mode is not supported by runtime '${val.runtime}'`,
      });
    }
  });
export type SwitchAgentRuntimeInput = z.infer<
  typeof SwitchAgentRuntimeInputSchema
>;

export const SwitchAgentRuntimeResponseSchema = z.object({
  agent: AgentDtoSchema,
  cleared_sessions: z.number().int().nonnegative(),
  restarted_conversations: z.number().int().nonnegative(),
  restart_failures: z.number().int().nonnegative(),
});
export type SwitchAgentRuntimeResponse = z.infer<
  typeof SwitchAgentRuntimeResponseSchema
>;

// ── Self-profile (`silverhand profile get|update`, #task:1178) ─────────
//
// The executing subject's view of its OWN profile metadata. This is a
// SUBSET of AgentDto (identity + the editable text fields + the derived
// avatar_url) — deliberately not the full row, because `profile get` is
// "what can I see/change about myself", not the agent-admin DTO.
//
// `avatar_url` is the SAME derived read field as AgentDto: always our
// internal `/api/agents/:id/avatar?v=<updated_at>` route, never a foreign
// URL. The write side stores a blob; this read side only ever points at
// that blob (or null). See the avatar service for the storage truth.
export const AgentProfileDtoSchema = z.object({
  id: z.string(),
  /** Immutable mention handle — shown for context, not editable here. */
  name: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  avatar_url: z.string().nullable(),
});
export type AgentProfileDto = z.infer<typeof AgentProfileDtoSchema>;

// Text fields of `silverhand profile update`. Avatar is intentionally
// ABSENT — bytes ride the multipart avatar route, never base64 in JSON.
// Mirrors the display_name / description subset of UpdateAgentInputSchema
// so the two write paths share one validation contract (single source of
// truth for the field rules).
export const UpdateProfileInputSchema = z
  .object({
    display_name: DisplayNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;

/**
 * `agent_changed` — WS event on the **`app`** scope, published by the
 * backend on any identity write that changes what the agent directory
 * shows — UPDATE, CREATION, and DELETION:
 *   - update: human `PATCH /api/agents/:id`, human avatar upload/delete,
 *     the agent's own `silverhand profile update` (display_name /
 *     description / avatar), and a completed runtime transition — the
 *     callers of `AgentService.publishChanged`.
 *   - create: a genuine agent provisioning, published once as a
 *     post-commit effect of `createAgent`'s `created` result (after the
 *     dependent-row commit). An idempotent echo or a failed materialization
 *     builds no such effect, so it publishes nothing.
 *   - delete: a hard delete's terminal identity change, published as a
 *     post-commit effect of `deleteAgent` / the `deleteComputer` cascade
 *     (`AgentService.publishDeleted`) once the `agents` row is gone. A
 *     refused/rolled-back delete publishes nothing, so clients are never told
 *     "deleted" for an agent that still exists. On this signal the historical
 *     message/thread/saved/search/activity author carriers refetch and resolve
 *     the author to its server-authoritative `deleted` snapshot (#task:1791)
 *     instead of collapsing to a directory miss; a direct AgentDto refetch 404s
 *     and the roster simply drops the id.
 * `user_changed` has the same create+update producer boundary (#task:1707).
 *
 * Clients treat it as an invalidation signal and reseat every cache that
 * denormalizes an agent's identity — the agent-kind entries of the
 * renderer's carrier registry (`features/identity/identity-carrier-caches`),
 * which is `['agents']` plus DM favorites and the host status / resources
 * trees, and the both-kind entries shared with `user_changed` (rosters,
 * workspace members, Activity, reaction detail, the task trees). #task:1704
 * replaced the earlier `['agents']`-prefix-only consumer. Avatars converge
 * on their own because a refetched DTO carries a bumped `avatar_url` `?v=`
 * cache-buster.
 *
 * Payload is intentionally minimal — just the id, no private data — so it
 * is safe on the global `app` scope (mirrors `user_presence`). The backend
 * is the single source of refresh; renderer mutation `onSuccess` may keep
 * a local fast-path but is no longer the sole propagation mechanism. The
 * kind string is `'agent_changed'`. (#task:1178)
 */
export const AgentChangedEventSchema = z.object({
  agent_id: z.string(),
});
export type AgentChangedEvent = z.infer<typeof AgentChangedEventSchema>;

// GET /api/agents/:id/workspace/tree + GET /api/agents/:id/workspace/file —
// see "agent home workspace files (tree + read pair)" below for the wire
// contract that backs the two-column workspace pane in the renderer.

// Pair of read-only protocols that together back the two-column workspace
// pane. The renderer pulls a flat tree of every file under the agent's
// home directory ("agent home workspace files" — the agent's L1 dir, whose
// host-local coordinate only the daemon resolves), then reads any
// path the user clicks. This intentionally does NOT segment by
// `system_prompt` / `MEMORY` / `notes/`: the protocol speaks one virtual
// path namespace rooted at the agent home dir, and the UI categorizes
// (or doesn't) however it wants.
//
// Forward-compat: a future expansion that exposes a different file root
// (e.g. an L2 workspace dir) will introduce ADDITIVE selector params
// (`scope`, `workspace_id`) — it MUST NOT reinterpret the current path
// semantics: today `path: "MEMORY.md"` is unambiguously the agent-home
// `MEMORY.md`, and that meaning is frozen.
//
// Security (enforced daemon-side, mirrored in the route): every input
// path is parsed segment-by-segment, dot/dot-dot/dotfile segments are
// rejected, every step is `lstat`-ed to refuse symlinks (intermediate
// or leaf), and the realpath of the resolved target must stay strictly
// inside the realpath of the agent home base — a missing or out-of-base
// target is `not_found`, never a leak.

/**
 * One entry in the flat tree response. `path` is a `/`-joined virtual
 * path relative to the agent home (e.g. `system_prompt.md`,
 * `notes/work-log.md`); empty / leading-slash / `..` / dotfile
 * segments are rejected upstream so any value here is safe to feed
 * back into the read endpoint verbatim.
 */
export const AgentWorkspaceTreeNodeSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['file', 'directory']),
    size: z.number(),
    mtime: z.number(),
  })
  .strict();
export type AgentWorkspaceTreeNode = z.infer<
  typeof AgentWorkspaceTreeNodeSchema
>;

/**
 * Flat tree shape — every visible file/directory under the agent home,
 * ordered directories-first then alphabetical within a level. The
 * renderer is responsible for reconstructing the parent/child layout
 * via the `path` segments. Hidden entries (anything starting with `.`)
 * are filtered server-side and never appear here.
 */
export const AgentWorkspaceTreeSchema = z
  .object({
    nodes: z.array(AgentWorkspaceTreeNodeSchema),
  })
  .strict();
export type AgentWorkspaceTree = z.infer<typeof AgentWorkspaceTreeSchema>;

/**
 * Single-file read result. `truncated` flips when the file exceeds the
 * daemon's preview cap (`MAX_PREVIEW_BYTES`); the renderer just labels the
 * preview accordingly.
 * `path` is the canonical virtual path the caller asked for, echoed for
 * cache-key stability.
 */
export const AgentWorkspaceFileReadSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    size: z.number(),
    mtime: z.number(),
    truncated: z.boolean(),
  })
  .strict();
export type AgentWorkspaceFileRead = z.infer<
  typeof AgentWorkspaceFileReadSchema
>;

// One placement-aware participation projection for the Agent detail surface.
// It carries display/navigation coordinates only; runtime ownership and process
// state are represented independently by `AgentRuntimeSeatDtoSchema` below.
export const AgentRuntimeParticipationSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string().nullable(),
  workspace_name: z.string().nullable(),
  workspace_kind: WorkspaceKindSchema.nullable(),
  conversation_placement_kind: ConversationPlacementKindSchema,
  conversation_roster_policy: ConversationRosterPolicySchema,
  channel_id: z.string(),
  channel_title: z.string(),
  closed_at: z.number().nullable(),
});
export type AgentRuntimeParticipation = z.infer<
  typeof AgentRuntimeParticipationSchema
>;

export const AgentRuntimeSeatScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent') }),
  z.object({ kind: z.literal('conversation'), conversation_id: z.string() }),
]);
export type AgentRuntimeSeatScope = z.infer<typeof AgentRuntimeSeatScopeSchema>;

export const AgentRuntimeFocusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), conversation_id: z.string() }),
  z.object({ kind: z.literal('other') }),
]);
export type AgentRuntimeFocus = z.infer<typeof AgentRuntimeFocusSchema>;

/** One semantic runtime identity. Agent scope remains one row no matter how
 * many conversations it serves; `focus` is a viewer-redacted presentation
 * coordinate, never part of ownership. */
export const AgentRuntimeSeatDtoSchema = z.object({
  scope: AgentRuntimeSeatScopeSchema,
  generation: z.number().int().nonnegative(),
  status: ConversationAgentStatusSchema,
  pid: z.number().nullable(),
  cli_session_id: z.string().nullable(),
  focus: AgentRuntimeFocusSchema.nullable(),
  queue_depth: z.number().int().nonnegative(),
});
export type AgentRuntimeSeatDto = z.infer<typeof AgentRuntimeSeatDtoSchema>;

// GET /api/agents/:id/runtime-state deliberately returns two orthogonal read
// models. `participations`/`visible_participations` answer where the agent is a
// participant; `seats` answer which semantic runtimes exist. Neither is derived
// from the other, so an absent slot cannot erase membership and AgentSlot cannot
// fan out into one fake process row per conversation.
export const AgentRuntimeStateDtoSchema = z.object({
  participations: z.array(AgentRuntimeParticipationSchema),
  visible_participations: z.array(AgentRuntimeParticipationSchema),
  seats: z.array(AgentRuntimeSeatDtoSchema),
});
export type AgentRuntimeStateDto = z.infer<typeof AgentRuntimeStateDtoSchema>;

// GET /api/agents/:id/liveness (#task:2043 B) — the ONE process bit a viewer
// authorized on the agent may read, deliberately a value object of its own and
// NOT a field on the runtime-state DTO above. Both faces share the SAME
// `canViewAgent` gate; they differ in what they project. Runtime-state projects
// the agent's seats/participations and filters those per-conversation
// (`canViewConversation`), so its payload is viewer-dependent; this face
// projects a single tri-state derived from the host's authoritative
// active-runtime snapshot, which needs no such narrowing. (The genuinely
// owner-only face is `GET /api/hosts/:id/status` — a whole-host snapshot.)
// Three values, not a boolean: `unknown` means there is no live host snapshot to
// answer from (no read model / host revoked / disconnected / unreachable) and
// MUST NOT be folded to `offline` — "we cannot tell" is not "the process is
// down".
export const AgentLivenessSchema = z.enum(['online', 'offline', 'unknown']);
export type AgentLiveness = z.infer<typeof AgentLivenessSchema>;

export const AgentLivenessDtoSchema = z.object({
  liveness: AgentLivenessSchema,
});
export type AgentLivenessDto = z.infer<typeof AgentLivenessDtoSchema>;

// GET /api/agents/:id/availability (#task:2043) — the ONE reachability bit a
// viewer authorized on the agent may read. This is the SECOND, orthogonal axis
// to liveness above: liveness projects whether a live *process* exists right
// now; availability projects whether the agent's host is *reachable* right now
// (an authenticated outbound attachment is connected and the host is not
// revoked), which is a total function of transport + agent validity —
// independent of any runtime snapshot, hydration, or active-agent set. An
// idle-reaped or not-yet-hydrated agent on a connected host is AVAILABLE (the
// next inbound message re-spawns it), which is why availability must not be
// derived from the active-runtime snapshot the way liveness is.
//
// Deliberately TWO values, not three. The source is a total in-process fact:
// the attachment is either present or absent; "the authority could not read"
// is an infrastructure FAULT (HTTP 5xx), never a successful `{availability}`.
// Folding a fault into a domain value would license callers to disguise a
// backend failure as a normal answer. "We cannot tell right now" is a RENDERER
// query-projection state (pending / error / cached-stale ⇒ its own `unknown`),
// not a backend value. The UI composes THIS axis with liveness into the
// user-facing Online / Away / Offline / no-status projection.
export const AgentAvailabilitySchema = z.enum(['online', 'offline']);
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>;

export const AgentAvailabilityDtoSchema = z.object({
  availability: AgentAvailabilitySchema,
});
export type AgentAvailabilityDto = z.infer<typeof AgentAvailabilityDtoSchema>;

// Invalidation event for GET /api/agents/:id/availability (#task:2043). A pure
// CACHE-INVALIDATION frame, NOT a state patch: it carries only the agent id, so
// a subscriber's sole reaction is to refetch `/availability` for that id — the
// route stays the single source of the value. This mirrors `agent_changed`
// (identity) and `direct_pairs_changed` (list): the wire never ships the new
// value, only the id whose derived read is now stale.
//
// Fan-out is per-VIEWER, not global: unlike `agent_changed` (safe on `app`
// because the id alone leaks nothing), availability is a `canViewAgent`-gated
// read, so the backend publishes to `viewer:{userId}` for exactly the users who
// can currently see the agent (creator ∪ DirectPair human endpoints ∪
// shared-workspace members, each filtered through `canViewAgent`). The renderer
// composes the refetched availability with liveness into Online / Away /
// Offline / no-status. Emitted only on transport-reachability transitions
// (attachment connect / disconnect, host revoke) — never on runtime-liveness
// changes, which drive liveness, not this axis.
export const AGENT_AVAILABILITY_CHANGED_EVENT = 'agent_availability_changed';
export const AgentAvailabilityChangedEventSchema = z
  .object({
    agent_id: z.string(),
  })
  .strict();
export type AgentAvailabilityChangedEvent = z.infer<
  typeof AgentAvailabilityChangedEventSchema
>;

export const DeleteAgentInputSchema = z.object({
  confirm: z.literal(true),
});
export type DeleteAgentInput = z.infer<typeof DeleteAgentInputSchema>;

