import type { TaskSummaryDto } from '@silverhand/shared';

/**
 * The channel name of a task that lives on a workspace board; `null` on the
 * DirectPair arm, which has no channel to name — its place is the pair itself.
 * Callers render the channel affordance ONLY when this is non-null: a pair task
 * omits the segment rather than showing a stand-in label (shiki dogfood #2041),
 * because a `#channel` glyph on a DM would be the wrong identity primitive.
 */
export function taskChannelLabel(task: Pick<TaskSummaryDto, 'place'>): string | null {
  return task.place.kind === 'workspace' ? task.place.channel_name : null;
}

/** The workspace id when the task sits on a workspace board; null on the pair
 *  arm (no faked coordinate — callers must branch). */
export function taskWorkspaceId(task: Pick<TaskSummaryDto, 'place'>): string | null {
  return task.place.kind === 'workspace' ? task.place.workspace_id : null;
}
