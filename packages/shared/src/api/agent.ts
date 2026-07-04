// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: agent. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  AgentMaterializationStatusSchema,
  ConversationAgentStatusSchema,
  ConversationKindSchema,
  FastModeSchema,
  ReasoningEffortSchema,
  RuntimeKindSchema,
  WorkspaceKindSchema,
} from '../db/schema.js';
import { DisplayNameSchema } from './user.js';
import { reasoningEffortValidForRuntime } from '../runtime-catalog.js';

export const AgentDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  runtime: RuntimeKindSchema,
  model: z.string().nullable(),
  reasoning_effort: ReasoningEffortSchema.nullable(),
  fast_mode: FastModeSchema.nullable(),
  host_id: z.string(),
  description: z.string().nullable(),
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
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;

export const CreateAgentInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore'),
    runtime: RuntimeKindSchema,
    model: z.string().optional(),
    reasoning_effort: ReasoningEffortSchema.optional(),
    fast_mode: FastModeSchema.optional(),
    host_id: z.string().optional(), // defaults to the current user's owned local host
    description: z.string().optional(),
  })
  // reasoning_effort must be valid for the chosen runtime — the shared enum
  // is the union across runtimes, so a value like qoder's `max` would parse
  // structurally but be meaningless for codex. Both fields are present in the
  // create payload, so this closes at the schema (route + CLI get it free).
  .superRefine((val, ctx) => {
    if (!reasoningEffortValidForRuntime(val.runtime, val.reasoning_effort)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasoning_effort'],
        message: `reasoning_effort '${val.reasoning_effort}' is not valid for runtime '${val.runtime}'`,
      });
    }
  });
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

// PATCH /api/agents/:id — every field optional, only provided keys
// are written. `name`, `host_id`, and `runtime` are deliberately excluded:
// `name` is the immutable identifier (see migrations.ts v5 comment),
// `host_id` swap is out of v1 scope, and runtime is a create-time driver
// boundary rather than profile metadata.
export const UpdateAgentInputSchema = z
  .object({
    display_name: DisplayNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    runtime: z.never().optional(),
    model: z.string().nullable().optional(),
    reasoning_effort: ReasoningEffortSchema.nullable().optional(),
    fast_mode: FastModeSchema.nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

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
 * backend whenever an agent's stored `AgentDto` changes through ANY write
 * path: human `PATCH /api/agents/:id`, human avatar upload/delete, or the
 * agent's own `silverhand profile update` (display_name / description /
 * avatar). Clients invalidate the
 * `['agents']` query prefix (covering the list, the `['agents', id]`
 * detail, and the avatar object-url, which re-fetches on its own because
 * the refetched DTO carries a bumped `avatar_url` `?v=` cache-buster).
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
// home directory ("agent home workspace files" — agent-home L1 in
// today's topology, i.e. `~/.silverhand/agents/<id>/`), then reads any
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
 * 64KB preview cap; the renderer just labels the preview accordingly.
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

// GET /api/agents/:id/runtime-state — every (conversation, agent) pair
// involving this agent, with workspace/channel names denormalized so
// the UI can render the "where it runs" table without N+1 queries.
export const AgentRuntimeConversationSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  workspace_kind: WorkspaceKindSchema,
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  channel_title: z.string(),
  status: ConversationAgentStatusSchema,
  pid: z.number().nullable(),
  closed_at: z.number().nullable(),
});
export type AgentRuntimeConversation = z.infer<
  typeof AgentRuntimeConversationSchema
>;

export const AgentRuntimeStateDtoSchema = z.object({
  conversation_agents: z.array(AgentRuntimeConversationSchema),
});
export type AgentRuntimeStateDto = z.infer<typeof AgentRuntimeStateDtoSchema>;

// GET /api/agents/:id/delete-impact — drives the destructive
// confirmation dialog. Counts the user actually needs to see before
// agreeing to a permanent delete.
export const AgentDeleteImpactDtoSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  agent_display_name: z.string(),
  dm_channel: z
    .object({
      id: z.string(),
      name: z.string(),
      conversation_count: z.number(),
      message_count: z.number(),
    })
    .nullable(),
  regular_workspaces: z.array(
    z.object({ id: z.string(), name: z.string() }),
  ),
  regular_memberships: z.array(
    z.object({ id: z.string(), name: z.string() }),
  ),
  // D4.e-4 (P1-2): a NARROW window of the owned agent-home workspace, not the
  // full WorkspaceDto. The delete-impact must NOT carry any host-local path
  // (`workspace_path`) or other host-resolution fields (I6) — the daemon owns
  // path resolution. `computeDeleteImpact` explicitly maps these fields rather
  // than returning the repo DTO, so a future WorkspaceDto field can never leak
  // a host path back into this payload.
  owned_home: z
    .object({
      id: z.string(),
      name: z.string(),
      workspace_kind: WorkspaceKindSchema,
      owner_agent_id: z.string().nullable(),
    })
    .nullable(),
  attachments_count: z.number(),
  running_conversation_agents: z.array(AgentRuntimeConversationSchema),
  pending_inbox_count: z.number(),
  // D4.e-4: host-local L1/L2 fs paths are NO LONGER part of the delete
  // impact. The daemon resolves and removes them via `agent_files_purge`
  // (I1/I6) — the backend never derives an agent-host path. The number of
  // L2 dirs equals `regular_memberships.length`; render from that.
});
export type AgentDeleteImpactDto = z.infer<typeof AgentDeleteImpactDtoSchema>;

export const DeleteAgentInputSchema = z.object({
  confirm: z.literal(true),
});
export type DeleteAgentInput = z.infer<typeof DeleteAgentInputSchema>;
