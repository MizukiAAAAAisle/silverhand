// Shared contract surface for the task-service aggregate: the public input /
// option types, the transition table, the internal row shapes exchanged
// between the facade and its collaborators, and the stateless helpers
// (failure-envelope builders, row predicates). No behavior, no driver types —
// this is the ubiquitous-language module the facade + ports + access all
// import from (#task:1980).
import {
  type AgentCapability,
  type ClaimErrorCode,
  type ClaimResultEntry,
  type MessageSendTarget,
  type TaskMutationErrorCode,
  type TaskMutationResult,
  type TaskStatus,
} from '@silverhand/shared';
import type { AgentActor, TaskActor, UserActor } from './ports.js';

/** Re-exported actor faces (defined in ports.ts so the port closure stays
 *  driver-free — auth/principal.ts transitively types raw repos). */
export type { AgentActor, TaskActor, UserActor } from './ports.js';

// H3 identity switch (v60): a task is a first-class aggregate, selected by its
// per-workspace `task_number` (the agent/CLI resolver) or its `tasks.id` (the
// human REST path key). The old "select a task by a message id" form is fully
// retired — a message id may only name a source/nav ref, never a task.
//
// P0-g (#task:2018, agent-scoped-session-v1 §4.5): the agent lane's ref is a
// discriminated union — the board-scoped local number (needs a board
// coordinate: explicit workspace selector or the caller's ambient workspace)
// OR the global `tasks.id` (needs none; ACL gates before existence is
// disclosed, so unknown and unauthorized ids are indistinguishable).
export type AgentTaskRef = { taskNumber: number } | { taskId: string };
export type UserTaskRef = { taskId: string };

export interface CreateTasksInput {
  conversationId: string;
  actor: TaskActor;
  tasks: { title: string; body?: string; sourceMessageId?: string }[];
  /** Agent-only: atomically self-claim the created task(s). Ignored for a
   *  user actor. */
  claim?: boolean;
  /** Optional public destination. Omitted / channel keeps task creation on
   *  the main line; thread places the task's lifecycle events under that
   *  message's reply cluster. */
  target?: MessageSendTarget;
  /** @deprecated Compatibility alias for old CLI/runtime callers. */
  legacyReplyToMessageId?: string;
}

export type ClaimTaskInput =
  | {
      actor: UserActor;
      by: UserTaskRef;
      /** Required for a user actor: `claim` assigns. Clearing the assignee is
       *  `unclaimTask` — one meaning, one write path. */
      assignee: { agentId: string };
    }
  | {
      actor: AgentActor;
      by: AgentTaskRef;
      assignee?: { agentId: string };
      workspaceSelector?: WorkspaceSelector;
    };

export type UnclaimTaskInput =
  | { actor: UserActor; by: UserTaskRef }
  | { actor: AgentActor; by: AgentTaskRef; workspaceSelector?: WorkspaceSelector };

export type UpdateStatusInput =
  | { actor: UserActor; by: UserTaskRef; status: TaskStatus }
  | {
      actor: AgentActor;
      by: AgentTaskRef;
      status: TaskStatus;
      workspaceSelector?: WorkspaceSelector;
    };

/** Service input for `task edit`. `title`/`body` are the new values, with
 *  `null` meaning "leave this field unchanged" (the route maps an omitted
 *  flag to null); at least one must be non-null. `body` set to `""` clears
 *  the content. Last-write-wins — there is no revision/concurrency token. */
export type EditTaskInput =
  | {
      actor: UserActor;
      by: UserTaskRef;
      title: string | null;
      body: string | null;
    }
  | {
      actor: AgentActor;
      by: AgentTaskRef;
      title: string | null;
      body: string | null;
      workspaceSelector?: WorkspaceSelector;
    };

/** Optional `--workspace-id` / `--workspace <name>` selector wired
 *  through from the CLI. Empty / undefined means "use the actor's
 *  current conversation's workspace" (the legacy default). The
 *  service validates exclusivity (id XOR name) defensively, even
 *  though the wire schema also enforces it. */
export interface WorkspaceSelector {
  workspaceId?: string;
  workspaceName?: string;
}

export interface ListTasksFilters {
  actor: TaskActor;
  /** user actor: optional filter; agent actor: ignored (service derives
   *  physical workspace from actor.conversationId). */
  workspaceId?: string;
  /** INTERNAL (never wire): the service-computed board-key set for the agent
   *  arm (§7.2.2 / P0-f). One key = a single validated board (explicit
   *  selector or frame-derived); many keys = the agent-slot union. Rows are
   *  still narrowed per task by the participation predicate. Mutually
   *  exclusive with `workspaceId` (which stays the HUMAN arm's narrowing). */
  boardKeys?: readonly string[];
  conversationId?: string;
  /** OR-ed status filter. Empty array or undefined = no filter.
   *  Single-element array is the legacy single-value form. */
  status?: readonly TaskStatus[];
  /** OR-ed task-number filter. Empty array or undefined = no filter. */
  taskNumbers?: readonly number[];
  /** Filter by assignee agent id. Single-valued. */
  assigneeAgentId?: string;
  /** Cap the number of rows returned. */
  limit?: number;
}

/** Signature of the injected `canAgentUseCapability` binding (see
 *  TaskServiceOptions.canUseCapability). */
export type AgentCapabilityChecker = (
  actor: AgentActor,
  workspaceId: string,
  capability: AgentCapability,
) => boolean;

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['closed'],
  in_progress: ['in_review', 'done', 'closed'],
  in_review: ['in_progress', 'done', 'closed'],
  done: ['closed'],
  closed: ['todo', 'in_progress', 'in_review', 'done'],
};

/** A resolved `tasks` aggregate row, as the mutation paths read it inside their
 *  transactions. Mirrors the `tasks` table columns the service needs plus the
 *  owner conversation's title (joined). `title` is NOT NULL in the aggregate, so
 *  there is no `firstLine(content)` fallback anymore. */
export interface ResolvedTaskRow {
  id: string;
  conversation_id: string;
  task_number: number;
  /** NULL for DirectPair-board tasks (P0-f). */
  workspace_id: string | null;
  /** The stored board coordinate ('ws:…' | 'pair:…'), proven at INSERT. */
  board_key: string;
  status: TaskStatus;
  closed_at: number | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  title: string;
  content: string;
  thread_root_id: string | null;
  source_message_id: string | null;
  created_event_message_id: string | null;
  /** Creator origin — used for the "creator may close own stale
   *  unassigned task" exception in `updateStatusAgent`. */
  creator_kind: 'agent' | 'user' | 'system';
  creator_agent_id: string | null;
  owner_conversation_title: string;
}

/** Minimal message locator the create path needs: to resolve a thread target's
 *  root and to validate a `source_message_id` (existence, conversation, and thus
 *  workspace + read access). Task columns are gone — a message is never a task. */
export interface MessageRef {
  id: string;
  conversation_id: string;
  thread_root_id: string | null;
}

interface ClaimFailureArgs {
  code: ClaimErrorCode;
  reason: string;
  taskNumber?: number;
  /** The task identity (`tasks.id`) of a successfully-located task; carried on
   *  the rare failure that still knows it. Claim selects by number, so most
   *  failures carry `taskNumber` instead. */
  id?: string;
  ownerConversation?: { id: string; title: string };
  workspaceCandidates?: string[];
  capability?: AgentCapability;
}

export function failClaim(args: ClaimFailureArgs): ClaimResultEntry {
  const entry: ClaimResultEntry = {
    success: false,
    code: args.code,
    reason: args.reason,
  };
  if (args.capability !== undefined) entry.capability = args.capability;
  if (args.taskNumber !== undefined) entry.task_number = args.taskNumber;
  if (args.id !== undefined) entry.id = args.id;
  if (args.ownerConversation) entry.owner_conversation = args.ownerConversation;
  if (args.workspaceCandidates && args.workspaceCandidates.length > 0) {
    entry.workspace_candidates = args.workspaceCandidates;
  }
  return entry;
}

/** Mirror of `failClaim` for the `TaskMutationResult` shape; used by
 *  the shared workspace resolver to emit unclaim/status failures
 *  without duplicating the envelope-build logic. */
export function mutationFailure(args: {
  code: TaskMutationErrorCode;
  reason: string;
  candidates?: string[];
  capability?: AgentCapability;
}): TaskMutationResult {
  const out: TaskMutationResult = {
    success: false,
    code: args.code,
    reason: args.reason,
  };
  if (args.capability !== undefined) out.capability = args.capability;
  if (args.candidates && args.candidates.length > 0) {
    out.workspace_candidates = args.candidates;
  }
  return out;
}

export function isThreadAnchor(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const md = JSON.parse(metadata) as Record<string, unknown>;
    return typeof md['subtype'] === 'string' && md['subtype'] === 'thread_anchor';
  } catch {
    return false;
  }
}

export function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]!.trim();
  return line.length > 120 ? line.slice(0, 120) + '…' : line || '(empty)';
}
