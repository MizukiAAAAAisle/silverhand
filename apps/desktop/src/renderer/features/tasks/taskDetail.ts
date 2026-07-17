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

/**
 * Build the `task edit` payload from ONLY the fields the user changed.
 *
 * Omitting an unchanged title is load-bearing: a legacy task whose title
 * was never set displays a server-computed `firstLine(content)` fallback.
 * A body-only edit must NOT send that fallback back as an explicit title —
 * the backend materializes the fallback independently. Sending it would
 * freeze the fallback as the title even as the body (and thus the intended
 * fallback) changes. So: title/body are each included only when they
 * actually differ from the authoritative base.
 */
export function buildTaskEditPayload(
  base: { title: string; content: string },
  next: { title: string; body: string },
): { title?: string; body?: string } {
  const out: { title?: string; body?: string } = {};
  if (next.title !== base.title) out.title = next.title.trim();
  if (next.body !== base.content) out.body = next.body;
  return out;
}
