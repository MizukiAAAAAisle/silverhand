import type { TaskDetailDto } from '@silverhand/shared';

/** React Query key for a single task's on-demand detail read, keyed by the
 *  task identity (`tasks.id`). Lives here (a pure module) so both the hooks
 *  and the realtime ingestor share one key shape without importing the React
 *  hooks module. */
export const taskDetailKey = (taskId: string | null | undefined) =>
  ['task-detail', taskId ?? null] as const;

/** Where "View in conversation" navigates. Same shape both task-board card
 *  surfaces already pass to their jump handler. */
export interface TaskJumpTarget {
  workspaceId?: string;
  channelId: string;
  threadRootId?: string | null;
  messageId: string;
}

/**
 * Resolve where the detail modal's "View in conversation" navigates, from the
 * server-resolved BRANCH `nav` discriminant. The renderer branches ONLY on
 * `nav.kind` and never guesses a fallback:
 *   - `source` / `created_event` → jump to the carried viewer-resolved `ref`.
 *   - `unavailable`              → `null`: nothing to navigate to (no source and
 *                                   no resolvable event, OR a declared source the
 *                                   viewer can't read). The caller HIDES the
 *                                   affordance — a declared source never silently
 *                                   falls back to the event.
 *
 * `nav` is per-viewer and only present on the resolved detail, so the caller
 * passes `detail` once the read succeeds; `null` here means "render no button".
 */
export function resolveTaskJumpTarget(
  detail: TaskDetailDto,
): TaskJumpTarget | null {
  if (detail.nav.kind === 'unavailable') return null;
  return {
    workspaceId: detail.workspace_id,
    channelId: detail.nav.ref.channel_id,
    threadRootId: detail.nav.ref.thread_root_id,
    messageId: detail.nav.ref.message_id,
  };
}

/**
 * Whether the tasks drawer's own Escape handler should close the drawer.
 *
 * When a task detail modal is open ON TOP of the drawer, Escape must close
 * only the modal (Radix owns that) and leave the drawer open — so the
 * drawer's unconditional document-level Escape listener has to defer while
 * the modal is up. One Escape closes one layer, top-down.
 */
export function drawerShouldCloseOnEscape(detailModalOpen: boolean): boolean {
  return !detailModalOpen;
}
