import { z } from 'zod';
import {
  ConversationAgentStatusSchema,
  ConversationKindSchema,
  ConversationStatusSchema,
  FromKindSchema,
  HostKindSchema,
  NotificationKindSchema,
  ReasoningEffortSchema,
  RuntimeKindSchema,
  TaskAssigneeTypeSchema,
  TaskStatusSchema,
  WorkspaceKindSchema,
} from '../db/schema.js';

// ── Host ─────────────────────────────────────────────────────────
export const HostDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: HostKindSchema,
  created_at: z.number(),
});
export type HostDto = z.infer<typeof HostDtoSchema>;

// ── Agent ────────────────────────────────────────────────────────
export const AgentDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  runtime: RuntimeKindSchema,
  model: z.string().nullable(),
  reasoning_effort: ReasoningEffortSchema.nullable(),
  host_id: z.string(),
  description: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;

export const CreateAgentInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore'),
  runtime: RuntimeKindSchema,
  model: z.string().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  host_id: z.string().optional(), // defaults to local
  description: z.string().optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

// PATCH /api/agents/:id — every field optional, only provided keys
// are written. `name` and `host_id` are deliberately excluded; `name`
// is the immutable handle (see migrations.ts v5 comment), and
// changing host is not supported in v1.
export const UpdateAgentInputSchema = z
  .object({
    display_name: z.string().trim().min(1).max(64).optional(),
    description: z.string().max(2000).nullable().optional(),
    runtime: RuntimeKindSchema.optional(),
    model: z.string().nullable().optional(),
    reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

// GET /api/agents/:id/workspace — read-only preview of L1 directory.
// Files are truncated server-side at 64KB; `truncated` flags it.
export const AgentWorkspaceFilePreviewSchema = z.object({
  path: z.string(),
  size: z.number(),
  mtime: z.number(),
  content: z.string(),
  truncated: z.boolean(),
});
export type AgentWorkspaceFilePreview = z.infer<
  typeof AgentWorkspaceFilePreviewSchema
>;

export const AgentWorkspaceNoteSchema = z.object({
  name: z.string(),
  size: z.number(),
  mtime: z.number(),
});
export type AgentWorkspaceNote = z.infer<typeof AgentWorkspaceNoteSchema>;

export const AgentWorkspaceDtoSchema = z.object({
  l1_path: z.string(),
  system_prompt: AgentWorkspaceFilePreviewSchema.nullable(),
  memory: AgentWorkspaceFilePreviewSchema.nullable(),
  notes: z.array(AgentWorkspaceNoteSchema),
});
export type AgentWorkspaceDto = z.infer<typeof AgentWorkspaceDtoSchema>;

// GET /api/agents/:id/runtime-state — every (conversation, agent) pair
// involving this agent, with workspace/channel/thread names denormalized so
// the UI can render the "where it runs" table without N+1 queries.
export const AgentRuntimeConversationSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  workspace_kind: WorkspaceKindSchema,
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  channel_title: z.string(),
  thread_title: z.string().nullable(),
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
  running_conversation_agents: z.array(AgentRuntimeConversationSchema),
  pending_inbox_count: z.number(),
  l1_path: z.string(),
  l2_paths: z.array(z.string()),
});
export type AgentDeleteImpactDto = z.infer<typeof AgentDeleteImpactDtoSchema>;

export const DeleteAgentInputSchema = z.object({
  confirm: z.literal(true),
});
export type DeleteAgentInput = z.infer<typeof DeleteAgentInputSchema>;

// ── Workspace / Conversation model ───────────────────────────────
//
// New naming model for workspace -> channel/dm_channel/thread. The
// legacy Channel/Conversation DTOs below remain during the transition so the
// existing renderer can keep compiling until it is renamed.

export const WorkspaceDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspace_kind: WorkspaceKindSchema,
  workspace_path: z.string(),
  workspace_host_id: z.string(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDtoSchema>;

export const WorkspaceMemberDtoSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  joined_at: z.number(),
});
export type WorkspaceMemberDto = z.infer<typeof WorkspaceMemberDtoSchema>;

export const CreateWorkspaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore'),
  description: z.string().optional(),
  workspace_path: z.string().optional(),
  workspace_host_id: z.string().optional(),
  member_agent_ids: z.array(z.string()).default([]),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export const UpdateWorkspaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore')
    .optional(),
  description: z.string().nullable().optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceInputSchema>;

export const ConversationDtoSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  workspace_path: z.string(),
  kind: ConversationKindSchema,
  parent_conversation_id: z.string().nullable(),
  title: z.string(),
  status: ConversationStatusSchema,
  spawned_by_agent_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  close_summary: z.string().nullable(),
  pinned_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ConversationDto = z.infer<typeof ConversationDtoSchema>;

export const ChannelConversationDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('channel'),
  parent_conversation_id: z.null(),
});
export type ChannelConversationDto = z.infer<typeof ChannelConversationDtoSchema>;

export const DmChannelDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('dm_channel'),
  parent_conversation_id: z.null(),
});
export type DmChannelDto = z.infer<typeof DmChannelDtoSchema>;

export const CreateConversationChannelInputSchema = z.object({
  title: z.string().min(1).max(128),
  member_agent_ids: z.array(z.string()).default([]),
});
export type CreateConversationChannelInput = z.infer<
  typeof CreateConversationChannelInputSchema
>;

export const ThreadDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('thread'),
  channel_id: z.string(),
  anchor_message_id: z.string().nullable(),
});
export type ThreadDto = z.infer<typeof ThreadDtoSchema>;

export const ConversationAgentDtoSchema = z.object({
  conversation_id: z.string(),
  agent_id: z.string(),
  cli_session_id: z.string().nullable(),
  pid: z.number().nullable(),
  status: ConversationAgentStatusSchema,
  joined_at: z.number(),
});
export type ConversationAgentDto = z.infer<typeof ConversationAgentDtoSchema>;

export const ChannelDtoSchema = ChannelConversationDtoSchema;
export type ChannelDto = ChannelConversationDto;

/** Body for `PATCH /api/workspaces/:id/archive`. Toggle-shaped instead of
 *  separate archive / unarchive endpoints — the UI flips a flag, the
 *  backend looks at the boolean. */
export const ArchiveWorkspaceInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveWorkspaceInput = z.infer<typeof ArchiveWorkspaceInputSchema>;

// ── Workspace membership ─────────────────────────────────────────
export const AddWorkspaceMemberInputSchema = z.object({
  agent_id: z.string(),
});
export type AddWorkspaceMemberInput = z.infer<typeof AddWorkspaceMemberInputSchema>;

// Ephemeral per-agent run state used by `agent_activity` realtime events and
// reconnect snapshots. These rows are not persisted to the messages DB.
export const AgentRunStatusSchema = z.enum([
  'starting',
  'thinking',
  'tool_running',
  'idle',
  'failed',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunTerminalReasonSchema = z.enum([
  'replied',
  'turn_ended',
  'stopped',
  'crashed',
  'timeout',
  'conversation_closed',
]);
export type AgentRunTerminalReason = z.infer<
  typeof AgentRunTerminalReasonSchema
>;

export const AgentRunStateSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  status: AgentRunStatusSchema,
  startedAt: z.number(),
  updatedAt: z.number(),
  lastActivityAt: z.number(),
  terminalReason: AgentRunTerminalReasonSchema.optional(),
  activitySnippet: z.string().optional(),
  toolCallCounts: z.record(z.string(), z.number()).optional(),
  detail: z.string().optional(),
});
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentActivityEventSchema = AgentRunStateSchema;
export type AgentActivityEvent = AgentRunState;

export const AgentRunStatesDtoSchema = z.object({
  states: z.array(AgentRunStateSchema),
});
export type AgentRunStatesDto = z.infer<typeof AgentRunStatesDtoSchema>;

// ── Message ──────────────────────────────────────────────────────
export const TaskAssigneeDtoSchema = z.object({
  type: TaskAssigneeTypeSchema,
  id: z.string(),
  /** Agent display_name or user handle — denormalized for list render. */
  name: z.string(),
});
export type TaskAssigneeDto = z.infer<typeof TaskAssigneeDtoSchema>;

export const MessageDtoSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  from_kind: FromKindSchema,
  from_agent_id: z.string().nullable(),
  from_user_id: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  seq: z.number(),
  created_at: z.number(),
  /** Task metadata — all null when this message is not a task. */
  task_number: z.number().nullable(),
  task_status: TaskStatusSchema.nullable(),
  task_title: z.string().nullable(),
  task_workspace_id: z.string().nullable(),
  task_assignee: TaskAssigneeDtoSchema.nullable(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

export const ConversationMessagesDtoSchema = z.object({
  messages: z.array(MessageDtoSchema),
  has_more_before: z.boolean(),
});
export type ConversationMessagesDto = z.infer<typeof ConversationMessagesDtoSchema>;

export const SendMessageInputSchema = z.object({
  content: z.string().min(1),
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const MarkConversationReadInputSchema = z.object({
  /** Optional explicit target cursor. Omitted = backend uses MAX(messages.seq). */
  seq: z.number().int().nonnegative().optional(),
});
export type MarkConversationReadInput = z.infer<
  typeof MarkConversationReadInputSchema
>;

export const MarkConversationReadDtoSchema = z.object({
  last_read_seq: z.number(),
});
export type MarkConversationReadDto = z.infer<typeof MarkConversationReadDtoSchema>;

export const MessageUnreadByConversationDtoSchema = z.object({
  by_conversation: z.record(z.string(), z.number()),
  total: z.number(),
});
export type MessageUnreadByConversationDto = z.infer<
  typeof MessageUnreadByConversationDtoSchema
>;

export const MessageUnreadSummaryDtoSchema = z.object({
  by_workspace: z.record(z.string(), z.number()),
});
export type MessageUnreadSummaryDto = z.infer<
  typeof MessageUnreadSummaryDtoSchema
>;

// ── Global chat search ───────────────────────────────────────────

const SearchOptionalStringSchema = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const SearchOptionalMillisSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

export const SearchScopeSchema = z.enum(['all', 'regular', 'dm']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchQueryInputSchema = z
  .object({
    q: z.string().trim().max(200).optional().default(''),
    scope: SearchScopeSchema.optional().default('all'),
    workspace_id: SearchOptionalStringSchema,
    conversation_id: SearchOptionalStringSchema,
    user_id: SearchOptionalStringSchema,
    agent_id: SearchOptionalStringSchema,
    from: SearchOptionalMillisSchema,
    to: SearchOptionalMillisSchema,
    limit: z.coerce.number().int().positive().max(200).optional().default(80),
  })
  .refine(v => !(v.user_id && v.agent_id), {
    message: 'user_id and agent_id cannot both be set',
    path: ['user_id'],
  });
export type SearchQueryInput = z.infer<typeof SearchQueryInputSchema>;

export const SearchWorkspaceRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['regular', 'dm']),
});
export type SearchWorkspaceRef = z.infer<typeof SearchWorkspaceRefSchema>;

export const SearchConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  created_at: z.number(),
});
export type SearchConversationRef = z.infer<typeof SearchConversationRefSchema>;

export const SearchResultDtoSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workspace'),
    workspace: SearchWorkspaceRefSchema.extend({
      description: z.string().nullable(),
      archived_at: z.number().nullable(),
      created_at: z.number(),
      updated_at: z.number(),
    }),
  }),
  z.object({
    type: z.literal('conversation'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
  }),
  z.object({
    type: z.literal('message'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
    message: MessageDtoSchema,
    agent_name: z.string().nullable(),
  }),
]);
export type SearchResultDto = z.infer<typeof SearchResultDtoSchema>;

export const SearchDtoSchema = z.object({
  query: SearchQueryInputSchema,
  results: z.array(SearchResultDtoSchema),
});
export type SearchDto = z.infer<typeof SearchDtoSchema>;

// ── Tasks ────────────────────────────────────────────────────────
//
// Per docs/tasks-design.md. A task == a message with task metadata.
// Numbering space is per-channel (#1 monotonic across all sessions of
// the channel); ownership/operation scope is per-conversation (only agents
// in the task's conversation may claim/unclaim/update; other sessions get
// read-only aggregate visibility). Human UI is not assignee-restricted.

export const TaskConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
});
export type TaskConversationRef = z.infer<typeof TaskConversationRefSchema>;

export const TaskCreatorDtoSchema = z.object({
  type: z.enum(['agent', 'user', 'system']),
  id: z.string().nullable(),
  name: z.string(),
});
export type TaskCreatorDto = z.infer<typeof TaskCreatorDtoSchema>;

export const TaskSummaryDtoSchema = z.object({
  message_id: z.string(),
  task_number: z.number(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  thread_id: z.string().nullable(),
  conversation: TaskConversationRefSchema,
  status: TaskStatusSchema,
  title: z.string(),
  assignee: TaskAssigneeDtoSchema.nullable(),
  creator: TaskCreatorDtoSchema,
  created_at: z.number(),
});
export type TaskSummaryDto = z.infer<typeof TaskSummaryDtoSchema>;

// GET /api/tasks (human) / /internal/agent/:aid/tasks (agent)
export const ListTasksQuerySchema = z.object({
  workspace_id: z.string().optional(),
  conversation_id: z.string().optional(),
  status: z
    .union([TaskStatusSchema, z.literal('all')])
    .optional()
    .default('all'),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

// POST /internal/agent/:aid/tasks — create_tasks MCP tool
export const CreateTasksInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().optional(),
      }),
    )
    .min(1),
});
export type CreateTasksInput = z.infer<typeof CreateTasksInputSchema>;

export const CreateTasksResultSchema = z.object({
  tasks: z.array(
    z.object({
      message_id: z.string(),
      task_number: z.number(),
      title: z.string(),
    }),
  ),
});
export type CreateTasksResult = z.infer<typeof CreateTasksResultSchema>;

// POST /internal/agent/:aid/tasks/claim — claim_tasks MCP tool
export const ClaimTasksInputSchema = z
  .object({
    task_numbers: z.array(z.number()).optional(),
    message_ids: z.array(z.string()).optional(),
  })
  .refine(v => (v.task_numbers?.length ?? 0) + (v.message_ids?.length ?? 0) > 0, {
    message: 'provide at least one of task_numbers or message_ids',
  });
export type ClaimTasksInput = z.infer<typeof ClaimTasksInputSchema>;

export const ClaimResultEntrySchema = z.object({
  success: z.boolean(),
  task_number: z.number().optional(),
  message_id: z.string().optional(),
  reason: z.string().optional(),
  /** If the task belongs to a different channel/thread, its id+title surface
   *  here so the caller can explain to the agent why claim failed. */
  owner_conversation: TaskConversationRefSchema.optional(),
});
export type ClaimResultEntry = z.infer<typeof ClaimResultEntrySchema>;

export const ClaimTasksResultSchema = z.object({
  results: z.array(ClaimResultEntrySchema),
});
export type ClaimTasksResult = z.infer<typeof ClaimTasksResultSchema>;

// POST /internal/agent/:aid/tasks/unclaim
export const UnclaimTaskInputSchema = z.object({
  task_number: z.number().int().positive(),
});
export type UnclaimTaskInput = z.infer<typeof UnclaimTaskInputSchema>;

// POST /internal/agent/:aid/tasks/update-status
export const UpdateTaskStatusInputSchema = z.object({
  task_number: z.number().int().positive(),
  status: TaskStatusSchema,
});
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInputSchema>;

// Simple success/failure envelope reused by unclaim / update-status.
export const TaskMutationResultSchema = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
});
export type TaskMutationResult = z.infer<typeof TaskMutationResultSchema>;

// Human UI — POST /api/tasks/:messageId/status
export const HumanUpdateTaskStatusInputSchema = z.object({
  status: TaskStatusSchema,
});
export type HumanUpdateTaskStatusInput = z.infer<
  typeof HumanUpdateTaskStatusInputSchema
>;

// Human UI — POST /api/tasks/:messageId/claim (optional target agent)
export const HumanClaimTaskInputSchema = z.object({
  agent_id: z.string().optional(),
});
export type HumanClaimTaskInput = z.infer<typeof HumanClaimTaskInputSchema>;

// Realtime payload — published on every task mutation (create / claim /
// unclaim / status change). Consumers refresh the list + any open
// conversation's inline task drawer.
export const TaskChangedEventSchema = z.object({
  kind: z.enum(['create', 'claim', 'unclaim', 'status']),
  workspace_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  conversation_id: z.string(),
  task_number: z.number(),
  message_id: z.string(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeDtoSchema.nullable(),
  title: z.string(),
});
export type TaskChangedEvent = z.infer<typeof TaskChangedEventSchema>;

// ── Internal API (chat-bridge → backend) ─────────────────────────

export const SendMessageTargetSchema = z.union([
  z.literal('self'),
  z.literal('parent'),
  z.object({ thread_id: z.string().min(1) }),
]);
export type SendMessageTarget = z.infer<typeof SendMessageTargetSchema>;

export const AgentSendMessageInputSchema = z.object({
  content: z.string().min(1),
  target: SendMessageTargetSchema.optional(),
});
export type AgentSendMessageInput = z.infer<typeof AgentSendMessageInputSchema>;

// ── Saved messages (bookmarks) ───────────────────────────────────
//
// One global flat list — no per-channel grouping, no tags. Each entry
// joins back to the source message + its workspace/conversation so the Saved
// view can render content + jump back to the conversation.
export const SavedMessageDtoSchema = z.object({
  id: z.string(),
  message: MessageDtoSchema,
  workspace_id: z.string(),
  workspace_name: z.string(),
  conversation_id: z.string(),
  conversation_title: z.string(),
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  /** Display name of the message author at save time. `null` for user messages. */
  agent_name: z.string().nullable(),
  saved_at: z.number(),
});
export type SavedMessageDto = z.infer<typeof SavedMessageDtoSchema>;

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
});
export type AgentCloseThreadInput = z.infer<typeof AgentCloseThreadInputSchema>;

// ── Runtime info (binary detection) ──────────────────────────────
export const RuntimeInfoSchema = z.object({
  kind: RuntimeKindSchema,
  installed: z.boolean(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

// ── Notifications ────────────────────────────────────────────────
//
// v1 only emits `mention_external`: a user @-mentioned an agent who
// wasn't a member of the originating conversation. The mention was CC'd
// into that agent's DM channel (a dedicated `Mentions` conversation); a
// notification points the user at it.
//
// `payload` is open-ended JSON for kind-specific extras. For
// mention_external we stash:
//   - source_workspace_name: string  (denormalized for list rendering)
//   - source_conversation_title: string
//   - mention_excerpt: string  (first ~120 chars of the original)

export const NotificationDtoSchema = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  source_workspace_id: z.string().nullable(),
  source_conversation_id: z.string().nullable(),
  source_message_id: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  read_at: z.number().nullable(),
  created_at: z.number(),
});
export type NotificationDto = z.infer<typeof NotificationDtoSchema>;

export const MarkNotificationsReadInputSchema = z
  .object({
    /** Mark a specific id; omit to use channel/all selectors. */
    id: z.string().optional(),
    /** Mark all unread notifications scoped to this workspace/sidebar item. */
    workspace_id: z.string().optional(),
    /** Mark all unread notifications scoped to a single conversation. */
    conversation_id: z.string().optional(),
    /** Mark every unread notification (for the current user). */
    all: z.boolean().optional(),
  })
  .refine(v => !!(v.id || v.workspace_id || v.conversation_id || v.all), {
    message: 'must specify id, workspace_id, conversation_id, or all',
  });
export type MarkNotificationsReadInput = z.infer<
  typeof MarkNotificationsReadInputSchema
>;

// ── Mention extraction ───────────────────────────────────────────
//
// Single source of truth for what "@handle" means in a message body.
// Mirrors the renderer-side regex in `Markdown.tsx` and the
// composer-side detector — the boundary check rejects emails (`me@x`)
// and paths (`a/@b`), and the alpha-first requirement rejects issue
// refs like `@123`. Matches the agent name regex from
// `CreateAgentInputSchema`.
const MENTION_RE = /(?<![\w/])@([a-zA-Z][a-zA-Z0-9_-]*)/g;

/** Returns the unique set of @-handles referenced in `text`, in
 *  first-occurrence order. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
