// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: internal-agent. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import { HandleSchema } from '../handle.js';
import {
  ConversationKindSchema,
  ConversationVisibilitySchema,
  WorkspaceKindSchema,
} from '../db/schema.js';
import {
  MessageAttachmentIdsInputSchema,
  SearchOptionalStringSchema,
  hasMessagePayload,
} from './_zod-helpers.js';
import { AttachmentSnapshotSchema } from './attachment.js';
import type { MessageAuthorDto } from './message-author.js';
import { ReactionAggregateDtoSchema } from './reactions.js';

export const MessageSendTargetSchema = z.union([
  z.object({ kind: z.literal('channel') }).strict(),
  z.object({ kind: z.literal('thread'), message_id: z.string().min(1) }).strict(),
]);
export type MessageSendTarget = z.infer<typeof MessageSendTargetSchema>;

export const LegacySendMessageTargetSchema = z.literal('self');
export type LegacySendMessageTarget = z.infer<typeof LegacySendMessageTargetSchema>;

export const SendMessageTargetSchema = z.union([
  MessageSendTargetSchema,
  LegacySendMessageTargetSchema,
]);
export type SendMessageTarget = z.infer<typeof SendMessageTargetSchema>;

export const AgentStaleResolutionReasonSchema = z.enum([
  'unaffected',
  'revised',
  'obsolete',
  'force_send',
]);
export type AgentStaleResolutionReason = z.infer<
  typeof AgentStaleResolutionReasonSchema
>;

export const AgentSendStaleResolutionReasonSchema = z.enum([
  'unaffected',
  'revised',
  'force_send',
]);
export type AgentSendStaleResolutionReason = z.infer<
  typeof AgentSendStaleResolutionReasonSchema
>;

export const AgentSendMessageInputSchema = z.object({
  content: z.string(),
  /** Public send destination. `channel` is the current channel main line;
   *  `thread` is keyed by any message id in the target cluster. */
  target: SendMessageTargetSchema.optional(),
  /** @deprecated Compatibility alias for pre-`target: {kind:'thread'}`
   *  agent runtimes. New callers must use `target`. */
  reply_to_message_id: z.string().min(1).optional(),
  /** Daemon's assertion of which per-stream boundary `seen_up_to_seq`
   *  was read against (`'main'` or `thread:<rootMessageId>`). The backend
   *  independently resolves the stream from `target` and hard-rejects a
   *  mismatch (§6.4). Observability + safety; absent on a
   *  freshness-bypass / unknown-target send. */
  stream_key: z.string().min(1).optional(),
  /** Runtime-observed target conversation seq for outbound freshness CAS.
   *  The CLI must only forward the value stamped by the runtime delivery
   *  path; it must not read the current latest seq at send time. */
  seen_up_to_seq: z.number().int().nonnegative().optional(),
  /** Correlates a retry/bypass send with a prior `message_stale` response.
   *  This is observability-only: missing or malformed stale-resolution
   *  telemetry must not become a send gate. */
  stale_event_id: z.string().min(1).optional(),
  stale_resolution_reason: AgentSendStaleResolutionReasonSchema.optional(),
  /** Explicit agent escape hatch for stale-context sends. Used by
   *  `silverhand message send --anyway`; the backend logs the bypass but
   *  does not run hard freshness CAS for this one send. */
  freshness_bypass: z.boolean().optional(),
  /** Optional attachment ids previously returned by `upload_file`.
   *  Server validates each id belongs to the same channel as the
   *  resolved target conversation. */
  attachment_ids: MessageAttachmentIdsInputSchema,
}).refine(hasMessagePayload, {
  message: 'message must include text or at least one attachment',
  path: ['content'],
});
export type AgentSendMessageInput = z.infer<typeof AgentSendMessageInputSchema>;

export const AgentResolveStaleMessageInputSchema = z.object({
  stale_event_id: z.string().min(1),
  resolution_reason: z.literal('obsolete'),
});
export type AgentResolveStaleMessageInput = z.infer<
  typeof AgentResolveStaleMessageInputSchema
>;

export const AgentSendMessageOutputSchema = z.object({
  message_id: z.string(),
  /** Seq assigned by the target conversation allocator. The CLI uses this
   *  only to advance its local observed boundary after its own successful
   *  same-conversation send; it is not a room-current read. */
  message_seq: z.number().int().positive(),
  /** Reply-cluster root the sent message belongs to (§6.4): NULL for a
   *  main-line message, else the cluster's root message id. The daemon
   *  uses it to learn the reply-target stream of the new message and of
   *  the message it replied to. */
  thread_root_id: z.string().nullable(),
  /** Present when this insert SKIPPED the per-stream freshness check — an
   *  explicit `freshness_bypass`, or a loose first touch that carried no
   *  `seen_up_to_seq` — and carries the stream head just before the message
   *  was inserted. The daemon merges the sender's own seq into its observed
   *  watermark once real admission evidence covers this value. Without it, a
   *  CAS-skipping send in a quiet stream leaves the sender permanently stale
   *  on its own head: nothing ever delivers its own message back to it.
   *  Absent when the CAS ran (the sender already covers the stream) and for a
   *  cross-conversation send (the sender tracks no cursor there). */
  stream_head_before: z.number().int().nonnegative().optional(),
});
export type AgentSendMessageOutput = z.infer<typeof AgentSendMessageOutputSchema>;

export const AgentCreateChannelInputSchema = z.object({
  title: z.string().min(1).max(128),
  context_summary: z.string().min(1),
  initial_prompt: z.string().min(1),
});
export type AgentCreateChannelInput = z.infer<
  typeof AgentCreateChannelInputSchema
>;

/** Agent voluntary thread follow/unfollow (reply-cluster §5 B / §8). The
 *  thread is identified by a *message id* — the cluster root, or any reply
 *  in it (the server normalizes a reply to its canonical root). */
export const AgentFollowThreadInputSchema = z.object({
  root_message_id: z.string().min(1),
});
export type AgentFollowThreadInput = z.infer<
  typeof AgentFollowThreadInputSchema
>;

export const AgentFollowThreadOutputSchema = z.object({
  /** Canonical cluster root the follow/unfollow resolved to. */
  thread_root_id: z.string(),
  /** follow: true when a NEW follower row was created (false = already
   *  following, no re-backfill). unfollow: true when a row was removed
   *  (false = was not following). */
  changed: z.boolean(),
});
export type AgentFollowThreadOutput = z.infer<
  typeof AgentFollowThreadOutputSchema
>;

/** Structured detail attached to the backend `has_open_tasks` error so
 *  the CLI can render a list of the offending tasks without re-parsing
 *  the prose message. */
export const ThreadCloseOpenTaskDetailSchema = z.object({
  task_number: z.number().int().positive(),
  status: z.enum(['todo', 'in_progress', 'in_review']),
  title: z.string(),
  assignee_name: z.string().nullable(),
  assignee_agent_id: z.string().nullable(),
});
export type ThreadCloseOpenTaskDetail = z.infer<
  typeof ThreadCloseOpenTaskDetailSchema
>;

const ReadHistoryOptionalSeqSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

const ReadHistoryOptionalLimitSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().max(100).optional().default(50),
);

/** read_history target. Deliberately decoupled from
 *  `SendMessageTargetSchema` so adding read-only cross-conversation
 *  navigation here does NOT silently widen the surface that allows
 *  cross-conversation message posting. The `{ conversation_id }`
 *  form is membership-gated server-side via `conversation_agents`.
 *
 *  `{ thread_root_id }` is the reply-cluster read form (thread =
 *  reply cluster, `docs/thread-reply-cluster-v1.md`): the value is
 *  a *message id* (the cluster root, or any reply in it — the
 *  server normalizes a reply to its canonical root, symmetric with
 *  the send-side `resolveThreadRoot`). It reads the cluster inside
 *  the root message's channel: the root message (anchor) plus every
 *  reply whose `thread_root_id` equals the root. */
export const ReadHistoryTargetSchema = z.union([
  z.literal('self'),
  z.object({ thread_root_id: z.string().min(1) }),
  z.object({ conversation_id: z.string().min(1) }),
]);
export type ReadHistoryTarget = z.infer<typeof ReadHistoryTargetSchema>;

export const AgentReadHistoryInputSchema = z
  .object({
    target: ReadHistoryTargetSchema.optional(),
    before_seq: ReadHistoryOptionalSeqSchema,
    after_seq: ReadHistoryOptionalSeqSchema,
    around_message_id: z.string().min(1).optional(),
    include_content: z.boolean().optional().default(false),
    include_system: z.boolean().optional().default(true),
    limit: ReadHistoryOptionalLimitSchema,
  })
  .refine(
    value =>
      [value.before_seq, value.after_seq, value.around_message_id].filter(
        v => v !== undefined,
      ).length <= 1,
    {
      message:
        'pass at most one of before_seq, after_seq, or around_message_id; omit all to read the latest window',
      path: ['before_seq'],
    },
  );
export type AgentReadHistoryInput = z.infer<typeof AgentReadHistoryInputSchema>;

export const MessageRefSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  conversation_id: z.string(),
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  seq: z.number(),
  created_at: z.number(),
});
export type MessageRef = z.infer<typeof MessageRefSchema>;

/** Agent-facing author carrier for `message history` / `message search` output
 *  (#task:1793). A PURE thin projection of {@link MessageAuthorDto}: the SAME
 *  resolver (`resolveMessageAuthor`) decides active/deleted/unresolved/system,
 *  and this carrier is that result with the renderer-only fields dropped —
 *  `avatar_url` (a per-row cache-busted API URL) and `runtime` (a byline glyph
 *  hint) are never consumed by an agent reader, and this output lands directly
 *  in agent context (up to 100 rows per read), so carrying them is a pure token
 *  tax, not a free superset. A `null` sender means `from_kind='system'` (system
 *  is not an actor — mirrors `MessageAuthorDto`), so the reader tells system
 *  messages apart by a null sender rather than a magic `kind`.
 *
 *  Same discriminator discipline as the source DTO — `status` locks the valid
 *  field combinations at the schema layer, never inferred from which fields are
 *  null. The source's two `active` arms (split only to pin `runtime`) collapse
 *  to one here once `runtime` is dropped:
 *   - `active` / `deleted` — a stable `id` + `name` (handle) + `display_name`
 *     (all non-null); `deleted`'s values are the send-time snapshot. Only these
 *     carry a stable `id` and aggregate by it.
 *   - `unresolved` — everything null and non-aggregating (`id=null`): the
 *     identity is unrecoverable, NOT asserted deleted. `kind` survives so the
 *     reader can still say "Unknown agent" vs "Unknown user". */
const ResolvedSenderRefFields = {
  kind: z.enum(['agent', 'user']),
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
} as const;
export const MessageSenderRefSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('active'), ...ResolvedSenderRefFields }),
  z.object({ status: z.literal('deleted'), ...ResolvedSenderRefFields }),
  z.object({
    status: z.literal('unresolved'),
    kind: z.enum(['agent', 'user']),
    id: z.null(),
    name: z.null(),
    display_name: z.null(),
  }),
]);
export type MessageSenderRef = z.infer<typeof MessageSenderRefSchema>;

/** Pure projection from the resolved {@link MessageAuthorDto} to the agent-facing
 *  {@link MessageSenderRef}. No re-adjudication: `status` / `kind` / `id` are
 *  taken verbatim from the single resolver's result — only the renderer-only
 *  fields are dropped. `null` in ⇒ `null` out (system). */
export function senderRefFromAuthor(
  author: MessageAuthorDto | null,
): MessageSenderRef | null {
  if (author === null) return null;
  if (author.status === 'unresolved') {
    return {
      status: 'unresolved',
      kind: author.kind,
      id: null,
      name: null,
      display_name: null,
    };
  }
  return {
    status: author.status, // 'active' | 'deleted'
    kind: author.kind,
    id: author.id,
    name: author.name,
    display_name: author.display_name,
  };
}

export const ReadHistoryTargetRefSchema = z.object({
  conversation_id: z.string(),
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  /** Set only for the reply-cluster read form (`{ thread_root_id }`):
   *  the canonical cluster root message id. `null` for every other
   *  target. Lets the caller tell the anchor root apart from its
   *  replies (the root carries `id === thread_root_id`; replies do
   *  not) without exposing per-message `thread_root_id`. */
  thread_root_id: z.string().nullable(),
  workspace_id: z.string(),
  title: z.string(),
});
export type ReadHistoryTargetRef = z.infer<typeof ReadHistoryTargetRefSchema>;

export const ReadHistoryMessageSchema = z.object({
  message_ref: MessageRefSchema,
  sender: MessageSenderRefSchema.nullable(),
  snippet: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  attachments: z.array(AttachmentSnapshotSchema).nullable(),
  /** Per-emoji reaction aggregates from the CALLING agent's viewer
   *  perspective (`viewer_reacted` is the agent's own). `null` when the
   *  message has no reactions. Carried on read-history (incl. the
   *  reply-cluster pull form) so an agent that can `message react` can
   *  also see the result — docs/reactions-design.md §5.2. */
  reactions: z.array(ReactionAggregateDtoSchema).nullable(),
  content: z.string().optional(),
});
export type ReadHistoryMessage = z.infer<typeof ReadHistoryMessageSchema>;

export const ReadHistoryAnchorSchema = z.union([
  z.object({ type: z.literal('head') }),
  z.object({ type: z.literal('before_seq'), seq: z.number() }),
  z.object({ type: z.literal('after_seq'), seq: z.number() }),
  z.object({ type: z.literal('around_message_id'), message_id: z.string() }),
]);
export type ReadHistoryAnchor = z.infer<typeof ReadHistoryAnchorSchema>;

export const AgentReadHistoryDtoSchema = z.object({
  target: ReadHistoryTargetRefSchema,
  anchor: ReadHistoryAnchorSchema,
  limit: z.number(),
  include_content: z.boolean(),
  include_system: z.boolean(),
  messages: z.array(ReadHistoryMessageSchema),
  has_more_before: z.boolean(),
  has_more_after: z.boolean(),
});
export type AgentReadHistoryDto = z.infer<typeof AgentReadHistoryDtoSchema>;

/** One workspace the calling agent currently has member access to.
 *  `kind` mirrors DB truth (`'regular' | 'agent_home'`); 'dm' is a
 *  conversation-level concept and is intentionally not synthesized
 *  here. `agent_dir` is the agent's working directory inside this
 *  workspace — for `agent_home` this is the agent's L1 home itself,
 *  for `regular` it is the deterministic agent-centric bundle
 *  `<agent home>/workspaces/<workspace_id>` (relocation-v1 §3.2/§7:
 *  computed from ids, never read from a DB column or registry
 *  binding). `null` means UNAVAILABLE ON THIS COMPUTER: the coordinate
 *  is not a usable working directory yet — the membership is a pure DB
 *  write until the agent first spawns there. Never a fabricated path;
 *  it resolves on that first spawn. */
export const AgentListedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: WorkspaceKindSchema,
  archived: z.boolean(),
  updated_at: z.number(),
  agent_dir: z.string().nullable(),
});
export type AgentListedWorkspace = z.infer<typeof AgentListedWorkspaceSchema>;

export const AgentListWorkspacesDtoSchema = z.object({
  workspaces: z.array(AgentListedWorkspaceSchema),
});
export type AgentListWorkspacesDto = z.infer<typeof AgentListWorkspacesDtoSchema>;

/** Optional query for `list_channels`. When `workspace_id` is omitted,
 *  the route defaults to the source conversation's workspace. */
export const AgentListChannelsQuerySchema = z.object({
  workspace_id: z.string().min(1).optional(),
});
export type AgentListChannelsQuery = z.infer<typeof AgentListChannelsQuerySchema>;

/** Query for the peer-profile read (#task:1823). `handle` is the TARGET
 *  agent's handle on the SHARED handle grammar (`HandleSchema` — a leading
 *  `@` is tolerated so an agent can paste a mention verbatim, and the route
 *  normalizes it away before resolving); `workspace_id` names the workspace
 *  the co-membership is evaluated in and defaults to the source
 *  conversation's workspace, exactly like `list_channels`. */
export const AgentPeerProfileQuerySchema = z.object({
  handle: HandleSchema,
  workspace_id: z.string().min(1).optional(),
});
export type AgentPeerProfileQuery = z.infer<typeof AgentPeerProfileQuerySchema>;

export const AgentListedChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['channel', 'dm_channel']),
  /** Channel visibility. Authoritative on every row; a caller must not infer
   *  it from `kind` or list position. A `dm_channel` is always `private`. */
  visibility: ConversationVisibilitySchema,
  archived: z.boolean(),
  /** Whether the listed agent is a member of the conversation. Authoritative:
   *  computed from the membership relation, never inferred from `visibility`,
   *  `kind`, or list position. `visibility: 'public'` with `is_member: false`
   *  is the public-but-not-joined discovery state. Discovery grants no read,
   *  write, roster, or delivery; joining remains a separate action. */
  is_member: z.boolean(),
  updated_at: z.number(),
});
export type AgentListedChannel = z.infer<typeof AgentListedChannelSchema>;

export const AgentListChannelsDtoSchema = z.object({
  workspace_id: z.string(),
  channels: z.array(AgentListedChannelSchema),
});
export type AgentListChannelsDto = z.infer<typeof AgentListChannelsDtoSchema>;

export const AgentSearchMessagesScopeSchema = z.enum([
  'current',
  'workspace',
  'channel',
]);
export type AgentSearchMessagesScope = z.infer<
  typeof AgentSearchMessagesScopeSchema
>;

const AgentSearchMessagesLimitSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().max(100).optional().default(50),
);

export const AgentSearchMessagesInputSchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    scope: AgentSearchMessagesScopeSchema.optional().default('current'),
    workspace_id: z.string().min(1).optional(),
    channel_id: SearchOptionalStringSchema,
    include_system: z.boolean().optional().default(true),
    limit: AgentSearchMessagesLimitSchema,
  })
  .superRefine((v, ctx) => {
    if ((v.scope === 'channel') !== !!v.channel_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channel_id is required only when scope is channel',
        path: ['channel_id'],
      });
    }
    if (v.workspace_id && v.scope !== 'workspace') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspace_id is only valid with scope=workspace',
        path: ['workspace_id'],
      });
    }
  });
export type AgentSearchMessagesInput = z.infer<
  typeof AgentSearchMessagesInputSchema
>;

export const AgentSearchMessageHitSchema = z.object({
  message_ref: MessageRefSchema,
  sender: MessageSenderRefSchema.nullable(),
  excerpt: z.string(),
  match_offset: z.number().int().nonnegative(),
});
export type AgentSearchMessageHit = z.infer<typeof AgentSearchMessageHitSchema>;

export const AgentSearchMessagesDtoSchema = z.object({
  query: z.string(),
  scope: AgentSearchMessagesScopeSchema,
  workspace_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  include_system: z.boolean(),
  limit: z.number(),
  hits: z.array(AgentSearchMessageHitSchema),
});
export type AgentSearchMessagesDto = z.infer<typeof AgentSearchMessagesDtoSchema>;

//
// The CLI fires a one-shot trace at the cli-trace endpoint when it
// fails BEFORE any business HTTP call (parse / strict-flag / unknown
// noun). Backend logs it as `cli.preflight_failure` so we can see the
// typo Top-N without the agent ever realizing the trace exists.
//
// Strict but lenient: every field is optional so a half-formed CLI
// invocation can still be reported. The backend never echoes anything
// back beyond `{ ok: true }`.

export const CliTraceInputSchema = z
  .object({
    /** `silverhand <noun>...` if the noun parsed. */
    noun: z.string().max(64).optional(),
    /** `silverhand <noun> <verb>...` if both parsed. */
    verb: z.string().max(64).optional(),
    /** Names of the flags observed on the command line. NEVER values. */
    flags_seen: z.array(z.string().max(64)).max(64).optional(),
    /** Stable error code from the CLI, e.g. `validation_error`. */
    error_code: z.string().max(64).optional(),
    /** Optional descriptive sub-classification of `error_code`, e.g.
     *  `flag_removed`, `unexpected_arguments`. Wide string here (not a
     *  closed enum) so the CLI can introduce new subkinds without a
     *  shared schema bump; the CLI-side `ErrorSubkind` union is the
     *  source of truth. NEVER values. */
    error_subkind: z.string().max(64).optional(),
    /** First line of the user-facing error message (truncated). */
    error_message: z.string().max(500).optional(),
    /** Wall time from CLI start to error throw, in milliseconds. */
    duration_ms: z.number().nonnegative().optional(),
  })
  .strict();
export type CliTraceInput = z.infer<typeof CliTraceInputSchema>;

export const CliTraceOutputSchema = z.object({ ok: z.literal(true) });
export type CliTraceOutput = z.infer<typeof CliTraceOutputSchema>;

export const ConversationLogDebugInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type ConversationLogDebugInput = z.infer<
  typeof ConversationLogDebugInputSchema
>;

export const ConversationLogDebugStatusSchema = z
  .object({
    conversationId: z.string(),
    enabled: z.boolean(),
    expiresAt: z.number().int().nullable(),
    daemonSynced: z.boolean().optional(),
  })
  .strict();
export type ConversationLogDebugStatus = z.infer<
  typeof ConversationLogDebugStatusSchema
>;
