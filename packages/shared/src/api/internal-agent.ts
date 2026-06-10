// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: internal-agent. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  ConversationKindSchema,
  FromKindSchema,
  WorkspaceKindSchema,
} from '../db/schema.js';
import { SearchOptionalStringSchema } from './_zod-helpers.js';
import { AttachmentSnapshotSchema } from './attachment.js';

export const SendMessageTargetSchema = z.union([
  z.literal('self'),
  z.literal('parent'),
  z.object({ thread_id: z.string().min(1) }),
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
  content: z.string().min(1),
  target: SendMessageTargetSchema.optional(),
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
  attachment_ids: z.array(z.string().min(1)).max(20).optional(),
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
});
export type AgentSendMessageOutput = z.infer<typeof AgentSendMessageOutputSchema>;

export const AgentSpawnChildInputSchema = z.object({
  title: z.string().min(1),
  members: z.array(z.string().min(1)).optional(),
  context_summary: z.string().min(1),
  initial_prompt: z.string().min(1),
});
export type AgentSpawnChildInput = z.infer<typeof AgentSpawnChildInputSchema>;

export const AgentCreateChannelInputSchema = z.object({
  title: z.string().min(1).max(128),
  context_summary: z.string().min(1),
  initial_prompt: z.string().min(1),
});
export type AgentCreateChannelInput = z.infer<
  typeof AgentCreateChannelInputSchema
>;

export const AgentCloseThreadInputSchema = z.object({
  summary: z.string().min(1),
  posted_to_parent: z.boolean().optional(),
  /** Explicit override: bypass the "thread has no open tasks" guard.
   *  Set ONLY when the caller has consciously decided to leave one or
   *  more tasks in `todo`/`in_progress`/`in_review` after the thread is
   *  closed. The server still rejects `already_closed` and
   *  `has_active_children` regardless of this flag. */
  allow_open_tasks: z.boolean().optional(),
});
export type AgentCloseThreadInput = z.infer<typeof AgentCloseThreadInputSchema>;

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
 *  form is membership-gated server-side via `conversation_agents`. */
export const ReadHistoryTargetSchema = z.union([
  z.literal('self'),
  z.literal('parent'),
  z.object({ thread_id: z.string().min(1) }),
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
      ).length === 1,
    {
      message: 'anchor required: pass exactly one of before_seq, after_seq, or around_message_id',
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
  thread_id: z.string().nullable(),
  seq: z.number(),
  created_at: z.number(),
});
export type MessageRef = z.infer<typeof MessageRefSchema>;

export const MessageSenderRefSchema = z.object({
  kind: FromKindSchema,
  agent_id: z.string().nullable(),
  user_id: z.string().nullable(),
  display_name: z.string().nullable(),
});
export type MessageSenderRef = z.infer<typeof MessageSenderRefSchema>;

export const ReadHistoryTargetRefSchema = z.object({
  conversation_id: z.string(),
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  workspace_id: z.string(),
  title: z.string(),
});
export type ReadHistoryTargetRef = z.infer<typeof ReadHistoryTargetRefSchema>;

export const ReadHistoryMessageSchema = z.object({
  message_ref: MessageRefSchema,
  sender: MessageSenderRefSchema,
  snippet: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  attachments: z.array(AttachmentSnapshotSchema).nullable(),
  content: z.string().optional(),
});
export type ReadHistoryMessage = z.infer<typeof ReadHistoryMessageSchema>;

export const ReadHistoryAnchorSchema = z.union([
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
 *  workspace — for `agent_home` this is the workspace root itself,
 *  for `regular` it is the nested `.silverhand/agents/<agent_id>`
 *  L2 profile dir. */
export const AgentListedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: WorkspaceKindSchema,
  archived: z.boolean(),
  updated_at: z.number(),
  agent_dir: z.string(),
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

export const AgentListedChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['channel', 'dm_channel']),
  archived: z.boolean(),
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
  sender: MessageSenderRefSchema,
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
