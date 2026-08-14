/**
 * Task row → DTO projections. PURE leaf: no imports from persistence, no
 * driver types, no shared side effects. The one projection (`TaskJoinedRow`
 * → `TaskSummaryDto`) is shared by the task repo read face and the board
 * read-model so the CLI/list face and the paginated board can never disagree
 * about a card's shape (#task:1980).
 */
import type {
  TaskAssigneeDto,
  TaskCreatorDto,
  TaskEditorDto,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';

/** The joined row shape both the task repo and the board read face project
 *  from (one projection, one DTO — see `taskJoinedToSummary`). */
export interface TaskJoinedRow {
  id: string;
  conversation_id: string;
  task_number: number;
  status: TaskStatus;
  title: string;
  closed_at: number | null;
  workspace_id: string;
  workspace_name: string;
  channel_name: string;
  thread_root_id: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  creator_kind: 'agent' | 'user' | 'system';
  creator_agent_id: string | null;
  creator_user_id: string | null;
  created_at: number;
  conversation_title: string;
  assignee_agent_name: string | null;
  assignee_user_name: string | null;
  creator_agent_name: string | null;
  creator_user_name: string | null;
}

/** Row → `TaskSummaryDto`. Module-level and exported so the board read face
 *  reuses THIS projection rather than repeating it (one row shape, one SELECT,
 *  one DTO). */
export function taskJoinedToSummary(row: TaskJoinedRow): TaskSummaryDto {
  return {
    id: row.id,
    task_number: row.task_number,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    channel_id: row.conversation_id,
    channel_name: row.channel_name,
    // DERIVED board coordinate (agent-scoped-session-v1 §4.4): every stored
    // task is workspace-placed today; P0-f (#task:2022) adds the
    // DirectPairBoard arm HERE. Display/numbering namespace only — access
    // policy never reads it (Board is not an ACL unit).
    board: { kind: 'workspace', workspace_id: row.workspace_id },
    thread_root_id: row.thread_root_id,
    conversation: { id: row.conversation_id, title: row.conversation_title },
    status: row.status,
    title: row.title,
    assignee: assigneeFrom(row),
    creator: creatorFrom(row),
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}

/** Build the assignee DTO from a row's assignee columns (name degrades to the
 *  id when the join is missing — deleted/unlinked actor). */
export function assigneeFrom(row: {
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  assignee_agent_name: string | null;
  assignee_user_name: string | null;
}): TaskAssigneeDto | null {
  if (row.assignee_agent_id) {
    return {
      type: 'agent',
      id: row.assignee_agent_id,
      name: row.assignee_agent_name ?? row.assignee_agent_id,
    };
  }
  if (row.assignee_user_id) {
    return {
      type: 'user',
      id: row.assignee_user_id,
      name: row.assignee_user_name ?? row.assignee_user_id,
    };
  }
  return null;
}

/** Build the creator DTO from a task row's creator columns. 'system' = the
 *  creating agent/user was since deleted. */
export function creatorFrom(row: {
  creator_kind: 'agent' | 'user' | 'system';
  creator_agent_id: string | null;
  creator_user_id: string | null;
  creator_agent_name: string | null;
  creator_user_name: string | null;
}): TaskCreatorDto {
  if (row.creator_kind === 'agent' && row.creator_agent_id) {
    return {
      type: 'agent',
      id: row.creator_agent_id,
      name: row.creator_agent_name ?? row.creator_agent_id,
    };
  }
  if (row.creator_kind === 'user' && row.creator_user_id) {
    return {
      type: 'user',
      id: row.creator_user_id,
      name: row.creator_user_name ?? row.creator_user_id,
    };
  }
  return { type: 'system', id: null, name: 'system' };
}

/** Build the last-editor DTO from a row's attribution columns. Null when the
 *  task was never edited; name degrades to the id when the attribution join is
 *  missing (deleted/unlinked actor). */
export function resolveEditor(row: {
  last_editor_kind: 'agent' | 'user' | null;
  last_editor_id: string | null;
  editor_agent_name: string | null;
  editor_user_name: string | null;
}): TaskEditorDto | null {
  if (!row.last_editor_kind || !row.last_editor_id) return null;
  const name =
    row.last_editor_kind === 'agent'
      ? (row.editor_agent_name ?? row.last_editor_id)
      : (row.editor_user_name ?? row.last_editor_id);
  return { kind: row.last_editor_kind, id: row.last_editor_id, name };
}
