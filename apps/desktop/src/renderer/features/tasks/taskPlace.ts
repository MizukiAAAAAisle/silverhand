import type { TaskSummaryDto } from '@silverhand/shared';

/**
 * The display name of a task's home conversation, from the board union
 * (P0-f review B4: placement coordinates live ONLY in the union). Human
 * faces receive workspace rows today (pair tasks are human-invisible until
 * the DM read-surface ticket), so the pair arm renders its stable identity
 * label rather than faking a title.
 */
export function taskChannelLabel(task: Pick<TaskSummaryDto, 'board'>): string {
  return task.board.kind === 'workspace' ? task.board.channel_name : 'direct message';
}

/** The workspace id when the task sits on a workspace board; null on a pair
 *  board (no faked coordinate — callers must branch). */
export function taskWorkspaceId(task: Pick<TaskSummaryDto, 'board'>): string | null {
  return task.board.kind === 'workspace' ? task.board.workspace_id : null;
}
