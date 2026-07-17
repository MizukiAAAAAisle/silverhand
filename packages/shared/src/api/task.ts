// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: task. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  TaskAssigneeTypeSchema,
  TaskStatusSchema,
} from '../db/schema.js';
import { MessageSendTargetSchema } from './internal-agent.js';
import { AgentCapabilitySchema } from './workspace.js';

// ── Task title / content input spec (single source of truth) ──────────
// Both create and edit — across all three entry points (agent CLI, human
// HTTP, human UI) — validate title/content through these exact schemas and
// constants. The backend schema + service are authoritative; the renderer
// only soft-counts. Never define a second title/content bound elsewhere.

/** Max length of a task title, counted in UTF-16 code units (the unit Zod
 *  `.max()` measures — NOT graphemes; an emoji or astral char counts as 2). */
export const TASK_TITLE_MAX_LEN = 200;
/** Max length of a task's content/body. The task aggregate owns its `content`
 *  column directly; this is the task-domain bound. */
export const TASK_CONTENT_MAX_LEN = 10000;

/** A task title: trimmed, non-empty, capped. */
export const TaskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX_LEN);
/** A task body/content: any string up to the cap, INCLUDING `""` (an empty
 *  body clears the description). Omission is normalized to `""` by the
 *  service — the stored/read `content` is always a string, never null. */
export const TaskBodySchema = z.string().max(TASK_CONTENT_MAX_LEN);


export const TaskAssigneeDtoSchema = z.object({
  type: TaskAssigneeTypeSchema,
  id: z.string(),
  /** Agent display_name or user name — denormalized for list render. */
  name: z.string(),
});
export type TaskAssigneeDto = z.infer<typeof TaskAssigneeDtoSchema>;

/** The task LINKED to a message via that message's immutable source provenance
 *  (`tasks.source_message_id == message.id`). Rendered as the message-row task
 *  chip. Semantics: "this message TRIGGERED/links task #N", NOT "this message IS
 *  a task".
 *
 *  VIEWER-INVARIANT by construction: it rides `MessageDto`, which fans out on the
 *  broadcast `conversation:{id}` scope (one payload → every subscriber), so it
 *  carries ONLY viewer-independent task facts. No per-viewer capability
 *  (`can_claim` etc.) lives here — those belong to per-viewer read surfaces.
 *  `linked_task` is a conversation-visible READ projection: it follows channel
 *  read access (public channel → every reader, member or not, sees the same
 *  chip; private → only members, and a non-member never reaches the read at
 *  all). It is NOT member-gated — the member boundary is the write/board axis,
 *  not this read. Mutations key off `task_id` (the task identity), NEVER the
 *  source message id. */
export const LinkedTaskDtoSchema = z.object({
  task_id: z.string(),
  task_number: z.number(),
  title: z.string(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeDtoSchema.nullable(),
});
export type LinkedTaskDto = z.infer<typeof LinkedTaskDtoSchema>;

//
// A task is a FIRST-CLASS aggregate (its own `tasks` table), NOT a message with
// task metadata. `id` is the task identity everywhere DTOs/routes/events key on
// it; `task_number` is the per-workspace human/CLI resolver (#N monotonic).
// Ownership/operation scope is per-conversation (only agents in the task's
// conversation may claim/unclaim/update; other sessions get read-only aggregate
// visibility). Human UI is not assignee-restricted.

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
  /** The task identity (`tasks.id`) — canonical key for REST paths, events,
   *  and mutations. */
  id: z.string(),
  task_number: z.number(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  /** Reply-cluster root message id when the task's conversational footprint
   *  (its lifecycle system events) sits inside a thread cluster. NULL =
   *  main-line task. */
  thread_root_id: z.string().nullable(),
  conversation: TaskConversationRefSchema,
  status: TaskStatusSchema,
  title: z.string(),
  assignee: TaskAssigneeDtoSchema.nullable(),
  creator: TaskCreatorDtoSchema,
  created_at: z.number(),
  closed_at: z.number().nullable(),
});
export type TaskSummaryDto = z.infer<typeof TaskSummaryDtoSchema>;

/** Who last edited a task's DEFINITION (title/content) via `task edit`.
 *  `name` is denormalized server-side for render. Distinct from the task
 *  assignee/creator — this is the "edited by X" byline subject. */
export const TaskEditorDtoSchema = z.object({
  kind: z.enum(['agent', 'user']),
  id: z.string(),
  name: z.string(),
});
export type TaskEditorDto = z.infer<typeof TaskEditorDtoSchema>;

/** Viewer-resolved location of a message, for task navigation. `channel_id` is
 *  the parent channel conversation id the jump handler needs as `channelId`
 *  (threads are reply clusters, not standalone conversations, so this is the
 *  message's own conversation_id). */
export const TaskNavRefSchema = z.object({
  channel_id: z.string(),
  thread_root_id: z.string().nullable(),
  message_id: z.string(),
});
export type TaskNavRef = z.infer<typeof TaskNavRefSchema>;

/** Server-side typed navigation discriminant for "View in conversation",
 *  resolved PER-VIEWER at detail read. The renderer branches ONLY on `kind` and
 *  never guesses a fallback:
 *   - `source`        → the task declares a source message the viewer can read.
 *   - `created_event` → no source; navigate to the persisted task-created system
 *                        event (the task's conversational footprint).
 *   - `unavailable`   → nothing to navigate to: no source AND no resolvable
 *                        event, OR a source exists but the viewer cannot read its
 *                        conversation. A DECLARED source NEVER silently falls
 *                        back to the event — losing access hides the button. */
export const TaskNavDtoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), ref: TaskNavRefSchema }),
  z.object({ kind: z.literal('created_event'), ref: TaskNavRefSchema }),
  z.object({ kind: z.literal('unavailable') }),
]);
export type TaskNavDto = z.infer<typeof TaskNavDtoSchema>;

/** Full single-task read for the detail modal. Superset of TaskSummaryDto —
 *  the list stays title-only (no `content`), the detail carries the full body
 *  plus edit-provenance meta and the navigation ref. Fetched on demand when a
 *  card is opened; never batched into the board list. */
export const TaskDetailDtoSchema = TaskSummaryDtoSchema.extend({
  /** Full task body. */
  content: z.string(),
  /** Who last edited title/content, or null if never edited. */
  last_editor: TaskEditorDtoSchema.nullable(),
  /** When title/content was last edited (ms epoch), or null if never. This is
   *  the task's "updated" time — status/claim changes do NOT move it. */
  last_edited_at: z.number().nullable(),
  /** Immutable RAW provenance id (permanent 1:1 with the triggering message).
   *  NOT a foreign key — retained verbatim even if the message is later deleted,
   *  so `nav` resolves to `unavailable` rather than silently reclassifying the
   *  task to "no source". Never used directly by the client for navigation —
   *  that goes through `nav`. */
  source_message_id: z.string().nullable(),
  /** Server-resolved, per-viewer navigation for "View in conversation". A typed
   *  BRANCH discriminant (see TaskNavDtoSchema) — the client renders zero
   *  fallback logic: jump if a `ref` is present, hide the affordance on
   *  `unavailable`. */
  nav: TaskNavDtoSchema,
});
export type TaskDetailDto = z.infer<typeof TaskDetailDtoSchema>;

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
        title: TaskTitleSchema,
        body: TaskBodySchema.optional(),
        /** Immutable provenance link: the message that TRIGGERED this task.
         *  A permanent identity key — a given message backs at most ONE task
         *  for its entire lifetime (any status, including done/closed). It is
         *  NOT a content source; title/content are the task's own definition.
         *  A second create from the same source fails with `source_conflict`
         *  and points at the existing task. */
        source_message_id: z.string().min(1).optional(),
      }),
    )
    .min(1),
  /** Agent-only: atomically self-claim the created task(s) (status
   *  in_progress + assignee = the creating agent) in the same write as the
   *  create. Ignored for human creates. In addition to `create_tasks`, an
   *  agent claim requires the `write_tasks` capability. */
  claim: z.boolean().optional(),
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
  /** `source_message_id` referenced a message that does not exist. */
  'source_message_not_found',
  /** The actor cannot read the source message's conversation. */
  'source_not_accessible',
  /** The source message lives in a different conversation than the task
   *  (v1 contract: source and task must share one conversation). */
  'source_conversation_mismatch',
  /** A task already exists for this source message (permanent 1:1). The
   *  failure carries `existing_task` so the caller can point at it. */
  'source_conflict',
]);
export type CreateTasksOpError = z.infer<typeof CreateTasksOpErrorSchema>;

export const CreateTasksSuccessSchema = z.object({
  tasks: z.array(
    z.object({
      /** The created task's identity (`tasks.id`). */
      id: z.string(),
      task_number: z.number(),
      title: z.string(),
    }),
  ),
});
export const CreateTasksFailureSchema = z.object({
  error: CreateTasksOpErrorSchema,
  /** Present when `error === 'source_conflict'`: the task that already owns
   *  the supplied source message (whatever its status). */
  existing_task: z
    .object({
      task_number: z.number(),
      id: z.string(),
      status: TaskStatusSchema,
    })
    .optional(),
});
export const CreateTasksResultSchema = z.union([
  CreateTasksSuccessSchema,
  CreateTasksFailureSchema,
]);
export type CreateTasksResult = z.infer<typeof CreateTasksResultSchema>;

// POST /internal/agent/:aid/tasks/claim — claim_tasks MCP tool
export const ClaimTasksInputSchema = z
  .object({
    task_numbers: z.array(z.number()).min(1),
    /** Optional workspace selector for cross-workspace task ops. When
     *  omitted, the target task is resolved in the actor's current
     *  conversation's workspace (the legacy default). When provided,
     *  the actor must already be a member of the resolved workspace.
     *  `workspace_id` and `workspace_name` are mutually exclusive. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type ClaimTasksInput = z.infer<typeof ClaimTasksInputSchema>;

/** Typed code for claim-tool failures. Claim ONLY claims existing tasks by
 *  task number (+ optional workspace selector) — a task is a first-class
 *  aggregate, selected by its per-workspace number, never by a message id. To
 *  create+own a task from a message, use `task create --source-message-id
 *  --claim`. Cross-workspace task ops fail with `workspace_membership_required` /
 *  `unknown_workspace` / `ambiguous_workspace`. `task_done`, `already_claimed`
 *  etc. are stable; the free-form `reason` string is preserved alongside `code`. */
export const ClaimErrorCodeSchema = z.enum([
  'task_not_found',
  'task_done',
  'task_closed',
  'already_claimed',
  'not_self_assignment',
  'assignee_not_conversation_member',
  'conversation_not_found',
  'not_conversation_member',
  'agent_not_found',
  'unknown_workspace',
  'ambiguous_workspace',
  'workspace_membership_required',
  'capability_denied',
]);
export type ClaimErrorCode = z.infer<typeof ClaimErrorCodeSchema>;

export const ClaimResultEntrySchema = z.object({
  success: z.boolean(),
  task_number: z.number().optional(),
  /** The task identity (`tasks.id`) of the claimed task; present on success. */
  id: z.string().optional(),
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

// Human UI — POST /api/tasks/:taskId/status
export const HumanUpdateTaskStatusInputSchema = z.object({
  status: TaskStatusSchema,
});
export type HumanUpdateTaskStatusInput = z.infer<
  typeof HumanUpdateTaskStatusInputSchema
>;

// Human UI — POST /api/tasks/:taskId/claim (optional target agent)
export const HumanClaimTaskInputSchema = z.object({
  agent_id: z.string().optional(),
});
export type HumanClaimTaskInput = z.infer<typeof HumanClaimTaskInputSchema>;

// ── Edit (title / content) ────────────────────────────────────────────
// `task edit` mutates the task DEFINITION (title and/or content) as a plain
// last-write-wins UPDATE: the change is applied atomically by task id and the
// most recent successful write wins. There is NO optimistic-concurrency guard
// (no `expected_revision`, no `conflict` result): task edits are low-contention
// and the added round-trip/complexity would not pay for itself. A successful
// edit stamps last-editor; it never touches status/assignee. Both entry points
// reuse the shared title/body schemas.

// POST /internal/agent/:aid/tasks/edit — agent CLI `task edit`
export const EditTaskInputSchema = z
  .object({
    task_number: z.number().int().positive(),
    title: TaskTitleSchema.optional(),
    body: TaskBodySchema.optional(),
    /** Optional workspace selector — see ClaimTasksInputSchema. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => v.title !== undefined || v.body !== undefined, {
    message: 'provide at least one of title or body',
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type EditTaskInput = z.infer<typeof EditTaskInputSchema>;

// Human UI — POST /api/tasks/:taskId/edit
export const HumanEditTaskInputSchema = z
  .object({
    title: TaskTitleSchema.optional(),
    body: TaskBodySchema.optional(),
  })
  .refine(v => v.title !== undefined || v.body !== undefined, {
    message: 'provide at least one of title or body',
  });
export type HumanEditTaskInput = z.infer<typeof HumanEditTaskInputSchema>;

export const TaskEditErrorCodeSchema = z.enum([
  'task_not_found',
  'conversation_not_found',
  'not_conversation_member',
  'agent_not_found',
  'unknown_workspace',
  'ambiguous_workspace',
  'workspace_membership_required',
  'capability_denied',
]);
export type TaskEditErrorCode = z.infer<typeof TaskEditErrorCodeSchema>;

export const TaskEditResultSchema = z.union([
  /** SUCCESS — the full, viewer-resolved task detail AFTER the edit, so an open
   *  detail view updates in place (new attribution/navigation) without a
   *  refetch. `task` is REQUIRED here — a successful edit that cannot return its
   *  detail is an invariant failure, not a legal `{success:true}` without a
   *  body. */
  z.object({
    success: z.literal(true),
    task: TaskDetailDtoSchema,
  }),
  /** Every typed failure (not-a-task / not-found / authz / workspace).
   *  Carries no `task`. */
  z.object({
    success: z.literal(false),
    code: TaskEditErrorCodeSchema,
    reason: z.string().optional(),
    capability: AgentCapabilitySchema.optional(),
    workspace_candidates: z.array(z.string()).optional(),
  }),
]);
export type TaskEditResult = z.infer<typeof TaskEditResultSchema>;

// Realtime payload — published on every task mutation (create / claim /
// unclaim / status / edit). Consumers refresh the list + any open
// conversation's inline task drawer. `edit` carries the new title; full
// content is fetched on demand via the detail read (the event stays thin).
//
// Published on TWO scopes: `conversation:<id>` (the conversation-visible read
// stream — public-aware, so members and non-members alike observe task changes
// in a channel they can read) and per-viewer `viewer:<userId>` for each human
// member of the task's conversation (the cross-conversation board, member-gated
// so a private channel's task never fans out beyond its members).
export const TaskChangedEventSchema = z.object({
  kind: z.enum(['create', 'claim', 'unclaim', 'status', 'edit']),
  workspace_id: z.string(),
  channel_id: z.string(),
  /** Reply-cluster root message id when the task's lifecycle events are
   *  placed inside a thread cluster. NULL = main-line. */
  thread_root_id: z.string().nullable(),
  conversation_id: z.string(),
  task_number: z.number(),
  /** The task identity (`tasks.id`) — the key consumers use to converge their
   *  task cache and the source message's `linked_task` projection. */
  task_id: z.string(),
  /** The task's immutable source message id (null when sourceless). Lets a
   *  consumer locate and live-patch that source message row's `linked_task`
   *  chip by message id — without scanning the cache. Viewer-invariant (a fixed
   *  provenance id). `linked_task` is a conversation-visible read projection, so
   *  a PUBLIC channel exposes it to members and non-members alike; only the
   *  per-viewer board fanout and task mutation are member-gated. */
  source_message_id: z.string().nullable(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeDtoSchema.nullable(),
  title: z.string(),
  closed_at: z.number().nullable(),
});
export type TaskChangedEvent = z.infer<typeof TaskChangedEventSchema>;
