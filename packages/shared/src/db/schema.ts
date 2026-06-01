import { z } from 'zod';

export const RuntimeKindSchema = z.enum(['claude', 'codex', 'cursor', 'gemini']);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/** Tri-state fast_mode for the codex driver: NULL = use codex's own
 *  default (currently enabled by the catalog), true = `--enable
 *  fast_mode`, false = `--disable fast_mode`. */
export const FastModeSchema = z.boolean();
export type FastMode = z.infer<typeof FastModeSchema>;

export const HostKindSchema = z.enum(['local', 'remote']);
export type HostKind = z.infer<typeof HostKindSchema>;

export const HostCredentialKindSchema = z.enum(['long_lived', 'bootstrap']);
export type HostCredentialKind = z.infer<typeof HostCredentialKindSchema>;

export const WorkspaceKindSchema = z.enum(['regular', 'agent_home']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const ConversationKindSchema = z.enum(['channel', 'dm_channel', 'thread']);
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
  'tool_call',
  'tool_output',
  'file_change',
  'shell',
  'stderr',
  'compaction_started',
  'compaction_finished',
  'turn_end',
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
}

export interface ConversationRow {
  id: string;
  workspace_id: string;
  workspace_path: string;
  kind: ConversationKind;
  parent_conversation_id: string | null;
  title: string;
  status: ConversationStatus;
  spawned_by_agent_id: string | null;
  closed_at: number | null;
  close_summary: string | null;
  pinned_at: number | null;
  archived_at: number | null;
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
}

export interface ConversationReadRow {
  user_id: string;
  conversation_id: string;
  last_read_seq: number;
  read_at: number;
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
