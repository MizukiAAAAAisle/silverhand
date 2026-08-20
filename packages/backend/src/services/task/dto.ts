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
  /** NULL for DirectPair-board tasks (P0-f); the LEFT-JOINed workspace columns
   *  are null with it. */
  workspace_id: string | null;
  conversation_pair_key: string | null;
  /** Workspace-arm-only. SQL projects NULL for DirectPair so its sentinel
   *  storage title never enters this read model. */
  channel_name: string | null;
  thread_root_id: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  creator_kind: 'agent' | 'user' | 'system';
  creator_agent_id: string | null;
  creator_user_id: string | null;
  created_at: number;
  assignee_agent_name: string | null;
  assignee_user_name: string | null;
  creator_agent_name: string | null;
  creator_user_name: string | null;
}

/** Row → the `TaskPlace` union (contract §3). Values come from STORED columns
 *  only — the canonical `conversation_id` is folded into each arm, the pair arm
 *  carries EXACTLY the immutable `pair_key` (v74 generated column, byte format
 *  lives in the migration; TS never re-derives it) and deliberately NOT the
 *  stored sentinel title: a DM has no display title, and projecting the
 *  placeholder would fake one (the per-viewer label is #task:2021's formatter).
 *  The workspace arm carries the board namespace (`workspace_id`) plus the
 *  channel display title; neither `workspace_name` nor a container WORD is
 *  projected (zero readers — the word went with #task:2075's stop-publish step,
 *  for the same reason the name never shipped). A row matching neither arm is an
 *  invariant breach (the v76 full-coordinate trigger + arc CHECKs make it
 *  unrepresentable), so this fails loud rather than inventing a place. */
function placeFrom(row: TaskJoinedRow): TaskSummaryDto['place'] {
  if (row.workspace_id !== null && row.channel_name !== null) {
    return {
      kind: 'workspace',
      conversation_id: row.conversation_id,
      workspace_id: row.workspace_id,
      channel_name: row.channel_name,
    };
  }
  if (row.conversation_pair_key !== null) {
    return {
      kind: 'direct_pair',
      conversation_id: row.conversation_id,
      pair_key: row.conversation_pair_key,
    };
  }
  throw new Error(
    `task ${row.id}: no place coordinate (workspace and pair_key both absent)`,
  );
}

/** Row → `TaskSummaryDto`. Module-level and exported so the board read face
 *  reuses THIS projection rather than repeating it (one row shape, one SELECT,
 *  one DTO). */
export function taskJoinedToSummary(row: TaskJoinedRow): TaskSummaryDto {
  return {
    id: row.id,
    task_number: row.task_number,
    place: placeFrom(row),
    thread_root_id: row.thread_root_id,
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
