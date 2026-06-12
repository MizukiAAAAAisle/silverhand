// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: task. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  TaskAssigneeTypeSchema,
  TaskStatusSchema,
} from '../db/schema.js';
import { MessageSendTargetSchema } from './internal-agent.js';
import { AgentCapabilitySchema } from './workspace.js';

export const TaskAssigneeDtoSchema = z.object({
  type: TaskAssigneeTypeSchema,
  id: z.string(),
  /** Agent display_name or user name — denormalized for list render. */
  name: z.string(),
});
export type TaskAssigneeDto = z.infer<typeof TaskAssigneeDtoSchema>;

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
  /** Reply-cluster root message id for tasks whose body lives inside a
   *  thread cluster. NULL = main-line task. Distinct from `thread_id`,
   *  which is a legacy isolated thread conversation id. */
  thread_root_id: z.string().nullable(),
  /** Legacy isolated-thread conversation id. Present only for fossil
   *  `kind='thread'` conversations; new reply clusters use
   *  `thread_root_id` instead. */
  legacy_thread_conversation_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  conversation: TaskConversationRefSchema,
  status: TaskStatusSchema,
  title: z.string(),
  assignee: TaskAssigneeDtoSchema.nullable(),
  creator: TaskCreatorDtoSchema,
  created_at: z.number(),
  closed_at: z.number().nullable(),
});
export type TaskSummaryDto = z.infer<typeof TaskSummaryDtoSchema>;

// GET /api/tasks (human) / /internal/agent/:aid/tasks (agent)
export const ListTasksQuerySchema = z.object({
  workspace_id: z.string().optional(),
  conversation_id: z.string().optional(),
  /** Filter by status. Empty / omitted = no filter. Multiple values are
   *  OR-ed (e.g. `?status=in_progress&status=in_review`). */
  status: z.array(TaskStatusSchema).optional(),
  /** Filter by task number. Multiple values are OR-ed
   *  (e.g. `?task_number=190&task_number=191`). */
  task_number: z.array(z.coerce.number().int().positive()).optional(),
  /** Filter by assignee agent id. Single-valued. */
  assignee_id: z.string().optional(),
  /** Cap the number of rows returned (server-side LIMIT). */
  limit: z.coerce.number().int().positive().max(500).optional(),
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
  target: MessageSendTargetSchema.optional(),
  /** @deprecated Compatibility alias for pre-`target: {kind:'thread'}`
   *  agent runtimes. New callers must use `target`. */
  reply_to_message_id: z.string().min(1).optional(),
});
export type CreateTasksInput = z.infer<typeof CreateTasksInputSchema>;

export const CreateTasksOpErrorSchema = z.enum([
  'conversation_not_found',
  'conversation_closed',
  'not_conversation_member',
  'agent_not_found',
  'reply_target_not_found',
]);
export type CreateTasksOpError = z.infer<typeof CreateTasksOpErrorSchema>;

export const CreateTasksSuccessSchema = z.object({
  tasks: z.array(
    z.object({
      message_id: z.string(),
      task_number: z.number(),
      title: z.string(),
    }),
  ),
});
export const CreateTasksFailureSchema = z.object({
  error: CreateTasksOpErrorSchema,
});
export const CreateTasksResultSchema = z.union([
  CreateTasksSuccessSchema,
  CreateTasksFailureSchema,
]);
export type CreateTasksResult = z.infer<typeof CreateTasksResultSchema>;

// POST /internal/agent/:aid/tasks/claim — claim_tasks MCP tool
export const ClaimTasksInputSchema = z
  .object({
    task_numbers: z.array(z.number()).optional(),
    message_ids: z.array(z.string()).optional(),
    /** Optional workspace selector for cross-workspace task ops. When
     *  omitted, the target task is resolved in the actor's current
     *  conversation's workspace (the legacy default). When provided,
     *  the actor must already be a member of the resolved workspace.
     *  `workspace_id` and `workspace_name` are mutually exclusive.
     *
     *  The selector intentionally does NOT apply to message-id
     *  promotion (turning a not-yet-task message into a task): a
     *  regular message can only become a task in its own
     *  conversation, so promotion always targets the actor's
     *  current workspace regardless of selector. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => (v.task_numbers?.length ?? 0) + (v.message_ids?.length ?? 0) > 0, {
    message: 'provide at least one of task_numbers or message_ids',
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type ClaimTasksInput = z.infer<typeof ClaimTasksInputSchema>;

/** Typed code for claim-tool failures. `wrong_conversation` remains for
 *  the message-id promotion path (a message can only become a task in
 *  its own conversation); cross-workspace task ops fail with
 *  `workspace_membership_required` / `unknown_workspace` /
 *  `ambiguous_workspace` instead. `task_done`, `already_claimed` etc.
 *  are stable; the free-form `reason` string is preserved alongside
 *  `code` for tool consumers. */
export const ClaimErrorCodeSchema = z.enum([
  'task_not_found',
  'message_not_found',
  'wrong_conversation',
  'cannot_promote_system_message',
  'cannot_promote_anchor',
  'task_done',
  'task_closed',
  'already_claimed',
  'not_self_assignment',
  'assignee_not_conversation_member',
  'conversation_not_found',
  'not_conversation_member',
  'agent_not_found',
  'not_a_task',
  'unknown_workspace',
  'ambiguous_workspace',
  'workspace_membership_required',
  'capability_denied',
]);
export type ClaimErrorCode = z.infer<typeof ClaimErrorCodeSchema>;

export const ClaimResultEntrySchema = z.object({
  success: z.boolean(),
  task_number: z.number().optional(),
  message_id: z.string().optional(),
  reason: z.string().optional(),
  /** Typed failure code; present whenever `success === false`. */
  code: ClaimErrorCodeSchema.optional(),
  /** When `code === 'capability_denied'`, the missing capability bucket
   *  (doc §3.4b typed denial). */
  capability: AgentCapabilitySchema.optional(),
  /** If the task belongs to a different channel/thread, its id+title surface
   *  here so the caller can explain to the agent why claim failed. */
  owner_conversation: TaskConversationRefSchema.optional(),
  /** Workspace ids matching the supplied `workspace_name`, returned when
   *  `code === 'ambiguous_workspace'` so the caller can disambiguate. */
  workspace_candidates: z.array(z.string()).optional(),
});
export type ClaimResultEntry = z.infer<typeof ClaimResultEntrySchema>;

export const ClaimTasksResultSchema = z.object({
  results: z.array(ClaimResultEntrySchema),
});
export type ClaimTasksResult = z.infer<typeof ClaimTasksResultSchema>;

// POST /internal/agent/:aid/tasks/unclaim
export const UnclaimTaskInputSchema = z
  .object({
    task_number: z.number().int().positive(),
    /** Optional workspace selector — see ClaimTasksInputSchema. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type UnclaimTaskInput = z.infer<typeof UnclaimTaskInputSchema>;

// POST /internal/agent/:aid/tasks/update-status
export const UpdateTaskStatusInputSchema = z
  .object({
    task_number: z.number().int().positive(),
    status: TaskStatusSchema,
    /** Optional workspace selector — see ClaimTasksInputSchema. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInputSchema>;

/** Typed code for unclaim / status mutation failures. */
export const TaskMutationErrorCodeSchema = z.enum([
  'not_a_task',
  'task_not_found',
  'task_done',
  'wrong_conversation',
  'not_assignee',
  'invalid_transition',
  'already_at_status',
  'task_closed',
  'conversation_not_found',
  'not_conversation_member',
  'agent_not_found',
  'unknown_workspace',
  'ambiguous_workspace',
  'workspace_membership_required',
  'capability_denied',
]);
export type TaskMutationErrorCode = z.infer<typeof TaskMutationErrorCodeSchema>;

// Simple success/failure envelope reused by unclaim / update-status.
export const TaskMutationResultSchema = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
  /** Typed failure code; present whenever `success === false`. */
  code: TaskMutationErrorCodeSchema.optional(),
  /** When `code === 'capability_denied'`, the missing capability bucket
   *  (doc §3.4b typed denial). */
  capability: AgentCapabilitySchema.optional(),
  /** Workspace ids matching the supplied `workspace_name`, returned when
   *  `code === 'ambiguous_workspace'` so the caller can disambiguate. */
  workspace_candidates: z.array(z.string()).optional(),
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
  /** Reply-cluster root message id for task body / lifecycle events
   *  inside a thread cluster. NULL = main-line or legacy fossil. */
  thread_root_id: z.string().nullable(),
  /** Legacy isolated-thread conversation id; compatibility alias for
   *  old fossil conversations only. */
  legacy_thread_conversation_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  conversation_id: z.string(),
  task_number: z.number(),
  message_id: z.string(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeDtoSchema.nullable(),
  title: z.string(),
  closed_at: z.number().nullable(),
});
export type TaskChangedEvent = z.infer<typeof TaskChangedEventSchema>;
