import { z } from 'zod';

export const RuntimeKindSchema = z.enum(['claude', 'codex', 'cursor', 'gemini', 'qoder']);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

// Canonical reasoning-effort values. `none/xhigh/max` beyond the classic
// low/medium/high come from qoder's canonical set (verified from the
// qodercli binary). Stored/sent verbatim (lowercase); per-runtime which
// subset is user-facing lives in the runtime catalog. `null` (unset) is
// distinct from `'none'` (explicitly disabled) — unset means the driver
// doesn't pass `--reasoning-effort` at all.
export const ReasoningEffortSchema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/** Tri-state fast_mode for the codex driver: NULL = use codex's own
 *  default (currently enabled by the catalog), true = `--enable
 *  fast_mode`, false = `--disable fast_mode`. */
export const FastModeSchema = z.boolean();
export type FastMode = z.infer<typeof FastModeSchema>;

export const HostKindSchema = z.enum(['local', 'remote']);
export type HostKind = z.infer<typeof HostKindSchema>;

export const HostProvisioningSourceSchema = z.enum([
  'app_install',
  'user_invite',
  'system',
]);
export type HostProvisioningSource = z.infer<
  typeof HostProvisioningSourceSchema
>;

export const HostCredentialKindSchema = z.enum(['long_lived', 'bootstrap']);
export type HostCredentialKind = z.infer<typeof HostCredentialKindSchema>;

export const WorkspaceKindSchema = z.enum(['regular', 'agent_home']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const ConversationKindSchema = z.enum(['channel', 'dm_channel']);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ConversationStatusSchema = z.enum([
  'starting',
  'active',
  'idle',
  'archived',
  'crashed',
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ConversationAgentStatusSchema = z.enum([
  'idle',
  'starting',
  'active',
  'crashed',
]);
export type ConversationAgentStatus = z.infer<typeof ConversationAgentStatusSchema>;

export const FromKindSchema = z.enum(['user', 'agent', 'system']);
export type FromKind = z.infer<typeof FromKindSchema>;

export const TaskStatusSchema = z.enum([
  'todo',
  'in_progress',
  'in_review',
  'done',
  'closed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskAssigneeTypeSchema = z.enum(['agent', 'user']);
export type TaskAssigneeType = z.infer<typeof TaskAssigneeTypeSchema>;

export const ConversationEventKindSchema = z.enum([
  'session_init',
  'thinking',
  'text',
  'tool_call',
  'tool_output',
  'file_change',
  'shell',
  'stderr',
  'compaction_started',
  'compaction_finished',
  'turn_end',
  'error',
  'unknown',
  'parsed_event_dropped',
]);
export type ConversationEventKind = z.infer<typeof ConversationEventKindSchema>;

/**
 * D4.d v33 (additive): agent-materialization lifecycle on the
 * server side. Existing rows backfill to 'active' (they went
 * through the legacy backend-direct-fs path so the L1 already
 * exists). New rows START in 'pending_materialization' and flip
 * to 'active' on daemon ack (L3a) or 'failed' on typed error /
 * timeout (L3b). See `docs/remote-backend-architecture-notes.md §3.4`.
 */
export const AgentMaterializationStatusSchema = z.enum([
  'pending_materialization',
  'active',
  'failed',
]);
export type AgentMaterializationStatus = z.infer<
  typeof AgentMaterializationStatusSchema
>;

export interface HostRow {
  id: string;
  name: string;
  kind: HostKind;
  /** User that owns this host. NULL only for pre-claim legacy/local rows. */
  user_id: string | null;
  /** Stable local install id used to deduplicate desktop local-host claims. */
  installation_id: string | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  created_at: number;
  /** User-managed computer lifecycle marker. NULL means pending attach;
   *  non-null means this host has completed at least one authenticated daemon
   *  attachment. */
  activated_at: number | null;
  /** User confirmation marker. User-invited computers stay setup drafts until
   *  the modal finalizes them; runtime readiness composes this with
   *  activated_at, revoked_at, and owner ACL. */
  finalized_at: number | null;
  /** Lifecycle/origin metadata only. Must not gate runtime capability,
   *  placement, routing, or ACL decisions. */
  provisioning_source: HostProvisioningSource;
  /** v36 (#task:808): user-facing rename target for the ComputerPane
   *  / host registry view. `name` stays the stable normalized identifier
   *  used by `claimOrCreateLocal` and future ref resolvers. Renderer
   *  reads `display_label ?? name`. NULL on rows claimed before this
   *  column existed (and after a rename clears the label back to default).
   *  Length 1-64; CJK/spaces allowed (display field, not an identifier). */
  display_label: string | null;
}

export interface HostCredentialRow {
  id: string;
  host_id: string;
  token_hash: string;
  kind: HostCredentialKind;
  expires_at: number | null;
  consumed_at: number | null;
  revoked_at: number | null;
}

export interface AgentRow {
  id: string;
  name: string;
  display_name: string;
  runtime: RuntimeKind;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  fast_mode: FastMode | null;
  host_id: string;
  description: string | null;
  /** v26: human who created the agent (a `users.id`). Source of truth
   *  for `canEditAgent` — only the creator and the agent itself may
   *  edit profile / replace avatar. NOT NULL with `ON DELETE RESTRICT`
   *  (deleting the user is blocked while their agents still reference
   *  it; v2 multi-human flows must reassign or hard-delete first). */
  created_by_user_id: string;
  /** v26: storage key inside the configured BlobFileStorage; NULL when
   *  no avatar is set. Coupled with `avatar_content_type` via CHECK
   *  (mirrors `users` v21). */
  avatar_storage_key: string | null;
  avatar_content_type: string | null;
  /** v33 (D4.d): agent-home materialization lifecycle on the
   *  server side. Existing rows backfill to 'active'; new rows
   *  start at 'pending_materialization' and flip on daemon ack
   *  (L3a → 'active') or typed error / timeout (L3b → 'failed').
   *  Default-hidden from list/get; explicit `?include_failed=1`
   *  opt-in is ACL/creator-scoped (see §4.1 / §7.3). */
  materialization_status: AgentMaterializationStatus;
  /** v33 (D4.d): populated only when `materialization_status='failed'`.
   *  Mirrors the wire `AgentMaterializeErrorCodeSchema` plus
   *  server-side codes (`materialize_timeout` /
   *  `host_attach_pending` / `dependent_row_insert_failed` /
   *  `backend_crash_during_materialize`). Kept as `string | null`
   *  in shared schema — the route layer pins the exact code set
   *  it produces; this row column intentionally accepts the
   *  superset so the boot reconciler / future codes do not need
   *  a coordinated migration. */
  materialization_failed_code: string | null;
  /** v33 (D4.d): epoch ms set together with
   *  `materialization_failed_code`; NULL while the row is in
   *  `pending_materialization` or `active`. */
  materialization_failed_at: number | null;
  /** v33 (D4.d): client-supplied opaque retry key, 1..64 chars,
   *  `[A-Za-z0-9_-]`, stored verbatim. Unique per creator (NOT
   *  globally) — `idx_agents_idempotency_key_per_user` on
   *  `(created_by_user_id, idempotency_key) WHERE NOT NULL`. All
   *  lookup paths MUST filter by `(created_by_user_id, idempotency_key)`
   *  — never by key alone (Cindy round-2 P1 #5). */
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserRow {
  id: string;
  /** Mention name. Decided once at registration (V1 first launch / V2
   *  signup) and never editable after — no rename endpoint, no service
   *  method. Globally unique across `users.name` ⊕ `agents.name` — see
   *  migration v21 cross-namespace uniqueness triggers. */
  name: string;
  display_name: string;
  /** Storage key inside the configured BlobFileStorage; NULL when no
   *  avatar is set. Coupled with `avatar_content_type` via CHECK. */
  avatar_storage_key: string | null;
  avatar_content_type: string | null;
  /** Canonical login handle for remote auth. NULL rows are profile-only. */
  email: string | null;
  /** Last offline transition timestamp for human presence. NULL until first disconnect. */
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UserPasswordCredentialRow {
  user_id: string;
  password_hash: string;
  /** JSON-encoded Argon2id parameter record selected by the env benchmark. */
  password_hash_params: string;
  password_updated_at: number;
}

export interface AuthSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  last_used_at: number;
  revoked_at: number | null;
  user_agent: string | null;
  ip_first_seen: string | null;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  workspace_kind: WorkspaceKind;
  workspace_path: string;
  workspace_host_id: string;
  owner_agent_id: string | null;
  /**
   * Human governance owner (graded-permissions Layer A, v40). The live
   * "who owns this workspace" pointer; `null` only on rows created
   * before an owner is assigned (no such row exists post-migration on
   * the current install — the single local human owns every workspace).
   * Denormalized convenience + the anchor for the "exactly one owner"
   * invariant; the authoritative governance gate reads
   * `workspace_users.role`, not this column.
   */
  owner_user_id: string | null;
  dm_channel_id?: string | null;
  dm_channel_ids?: string[];
  pinned_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  agent_id: string;
  joined_at: number;
}

/**
 * Human membership row for `workspace_users` (v25). Mirrors
 * `WorkspaceMemberRow` but for users instead of agents. Unlike
 * `workspace_members`, this table accepts ALL workspace kinds —
 * including `agent_home` and DM workspaces — because humans have no
 * `owner_agent_id` equivalent that would let them access a workspace
 * implicitly.
 */
export interface WorkspaceUserMemberRow {
  workspace_id: string;
  user_id: string;
  joined_at: number;
  /**
   * Workspace governance role (graded-permissions Layer A, v40).
   * Defaults to `member` for new rows; the workspace creator / migrated
   * single local human is `owner`. This column is the authoritative
   * source for `canGovernWorkspace`.
   */
  role: WorkspaceRole;
}

/**
 * Workspace governance role (graded-permissions Layer A, v40). Two
 * orthogonal authority axes exist: this human role axis (coarse,
 * governance-scoped) and the per-(workspace, agent) capability axis
 * (fine, agent-scoped, landed in Layer A cut 2). They never collapse.
 *
 * - `owner`  — existence + human-roster control (archive/delete the
 *              workspace, add/remove human members, grant admin).
 *              Exactly one per workspace.
 * - `admin`  — day-to-day governance (create/delete channels, add/remove
 *              agent members, edit settings incl. rename, edit agent
 *              capabilities). Fully modeled in backend; NOT surfaced in
 *              the UI yet (amendment 4).
 * - `member` — view / post only (subject to conversation membership);
 *              the default role for a newly added human.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member';

/**
 * The agent-capability axis (graded-permissions Layer A cut 2, v41). The
 * 11 coarse capability buckets (doc §2.2) that gate what an agent may do
 * in a given workspace. CANONICAL definition — the migration CHECK
 * constraint, the DTO zod enum, and the backend route registry all derive
 * from this one list, so adding a bucket is a single-edit change.
 *
 * Orthogonal to {@link WorkspaceRole}: the human axis is coarse and
 * governance-scoped (who may *edit* capabilities); this axis is fine and
 * per-(workspace, agent) (what an agent may *do*). The two never collapse
 * — see docs/graded-permissions-v1.md §2 and the §6.3 orthogonality test.
 */
export const AGENT_CAPABILITIES = [
  'read_messages',
  'send_messages',
  'read_tasks',
  'create_tasks',
  'write_tasks',
  'read_attachments',
  'upload_attachments',
  'create_threads',
  'create_channels',
  'manage_conversation_members',
  'manage_schedules',
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * One granted capability for an (agent, workspace) pair (v41). PRESENCE =
 * GRANTED — there is no `granted` boolean; a missing row means the agent
 * lacks that capability in that workspace. The composite (workspace_id,
 * agent_id) is a FK onto `workspace_members` ON DELETE CASCADE, so caps
 * auto-delete when the agent leaves the workspace (no orphan caps,
 * doc §2.4).
 *
 * NOTE on shape: this table keys on `agent_id` (NOT a polymorphic
 * `actor_kind + actor_id`) by design — capabilities are inherently the
 * agent-only axis; humans use {@link WorkspaceRole}, not capabilities, so
 * there is no user variant of this row. This is the justified exception to
 * the actor-isomorphism anti-pattern (architecture-principles §6), not a
 * violation of it.
 */
export interface WorkspaceAgentCapabilityRow {
  workspace_id: string;
  agent_id: string;
  capability: AgentCapability;
}

export interface ConversationRow {
  id: string;
  workspace_id: string;
  workspace_path: string;
  kind: ConversationKind;
  title: string;
  status: ConversationStatus;
  spawned_by_agent_id: string | null;
  closed_at: number | null;
  close_summary: string | null;
  pinned_at: number | null;
  archived_at: number | null;
  latest_message_seq: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationAgentRow {
  conversation_id: string;
  agent_id: string;
  cli_session_id: string | null;
  pid: number | null;
  status: ConversationAgentStatus;
  joined_at: number;
}

/**
 * Human membership row for `conversation_users` (v25). Mirrors
 * `ConversationAgentRow` minus the agent-only process-lifecycle
 * columns (cli_session_id / pid / status); humans don't run as
 * processes, so those fields don't apply.
 */
export interface ConversationUserMemberRow {
  conversation_id: string;
  user_id: string;
  joined_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  from_kind: FromKind;
  from_agent_id: string | null;
  from_user_id: string | null;
  content: string;
  metadata: string | null;
  seq: number;
  created_at: number;
  task_number: number | null;
  task_status: TaskStatus | null;
  task_assignee_agent_id: string | null;
  task_assignee_user_id: string | null;
  task_title: string | null;
  task_workspace_id: string | null;
  task_closed_at: number | null;
  /**
   * Reply-cluster thread anchor (v43). NULL = this message is a root /
   * main-line message; non-NULL = a reply in the thread rooted at that
   * message id (same conversation, root itself has thread_root_id NULL).
   * See docs/thread-reply-cluster-v1.md.
   */
  thread_root_id: string | null;
}

/**
 * Thread delivery/notification subscription (v43) — NOT membership or
 * permission. `follower ⊆ parent channel member` is enforced at query
 * time, not by this table. `source` records the initial entry path
 * (immutable; later entries don't overwrite). See thread-reply-cluster-v1 §5/§9.
 */
export interface ThreadFollowerRow {
  thread_root_id: string;
  conversation_id: string;
  principal_kind: 'human' | 'agent';
  principal_id: string;
  followed_at: number;
  source: 'reply' | 'mention' | 'manual' | 'target_author';
}

/**
 * Per-stream freshness head (v43) — the optimistic-lock row for
 * message-stale CAS. A stream is (conversation_id, thread_root_id|NULL);
 * `latest_seq` is the global messages.seq of the stream's newest message
 * and doubles as the CAS token + newer-messages boundary. See §6.4.
 */
export interface ConversationStreamHeadRow {
  conversation_id: string;
  thread_root_id: string | null;
  latest_seq: number;
}

export interface ConversationReadRow {
  user_id: string;
  conversation_id: string;
  /** Per-stream read cursor (#task:1226): NULL = mainline, non-NULL = that
   *  reply-cluster. Uniqueness enforced by two partial-unique indexes
   *  (main / thread), mirroring conversation_stream_heads. */
  thread_root_id: string | null;
  last_read_seq: number;
  read_at: number;
}

/** Per-(viewer, channel) ambient attention preference (#task:1227,
 *  docs/activity-lifecycle-v1.md §9.1). The Attention bounded context's ONLY
 *  owned write-side aggregate. `mode` 'all' = ambient on, 'mentions' = ambient
 *  off; absence of a row = default `'all'`. Regular channel only (a DM's
 *  unread is directed-grade and a thread's ambient is follow-driven, so neither
 *  carries this preference). */
export interface ChannelAttentionPreferenceRow {
  user_id: string;
  conversation_id: string;
  mode: 'all' | 'mentions';
  updated_at: number;
}

export interface AgentInboxRow {
  id: number;
  conversation_id: string;
  agent_id: string;
  message_id: string;
  delivered_at: number | null;
  created_at: number;
}

export interface SessionEventRow {
  id: number;
  conversation_id: string;
  agent_id: string | null;
  kind: ConversationEventKind;
  payload: string | null;
  created_at: number;
}

export interface SavedMessageRow {
  id: string;
  user_id: string | null;
  message_id: string;
  conversation_id: string;
  workspace_id: string;
  saved_at: number;
}

export const StorageKindSchema = z.enum(['local', 's3', 'oss']);
export type StorageKind = z.infer<typeof StorageKindSchema>;

export const AttachmentCreatorKindSchema = z.enum(['user', 'agent']);
export type AttachmentCreatorKind = z.infer<typeof AttachmentCreatorKindSchema>;

/**
 * One uploaded blob, scoped to a channel for access control. Threads upload
 * via their parent channel — `source_conversation_id` keeps the lineage.
 *
 * No de-duplication: every upload creates a new row + new blob, so each
 * filename/source/creator is preserved cleanly.
 */
export interface AttachmentRow {
  id: string;
  /** channel/dm_channel that owns this blob (access boundary). */
  channel_id: string;
  /** channel or thread that originated the upload (audit / lineage). */
  source_conversation_id: string | null;
  filename: string;
  size: number;
  content_type: string;
  storage: StorageKind;
  storage_key: string;
  created_by_kind: AttachmentCreatorKind;
  created_by_id: string;
  created_at: number;
}

export const NotificationKindSchema = z.enum([
  'mention_external',
  /** The registered human viewer was @-mentioned in a conversation. */
  'mention_self',
  /** An agent failed to start before its process was even spawned
   *  (e.g. runtime binary not on PATH). Inserted by ConversationManager. */
  'agent_start_failed',
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  /** Reserved for multi-user. v1 always writes NULL. */
  user_id: string | null;
  /** The agent the notification is *about* (e.g. mentioned agent). */
  agent_id: string | null;
  /** Sidebar/workspace scope where the notification lives. */
  workspace_id: string | null;
  /** Conversation where the notification's message lives. */
  conversation_id: string | null;
  /** The CC message itself. */
  message_id: string | null;
  /** Origin pointers (where the user actually typed the mention). */
  source_workspace_id: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  /** JSON; kind-specific extra fields. */
  payload: string | null;
  read_at: number | null;
  created_at: number;
}
