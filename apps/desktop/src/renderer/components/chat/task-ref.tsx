import { taskChannelLabel } from "../../features/task-shell/model/task-place.js";
import { useState } from "react";
import { useTaskByNumber } from "@/features/task-shell/hooks/use-task-by-number";
import { useTaskRefContext } from "@/features/task-shell/components/task-ref-context";
import { useUpdateTaskStatus } from "@/features/task-shell/hooks/hooks";
import { TaskStatusBadge } from "@/features/task-shell/components/task-status-badge";
import { HoverPopover } from "./hover-popover";
import { useRelativeTime } from "./use-relative-time";
import type { TaskSummaryDto, TaskStatus } from "@silverhand/shared";

interface TaskRefProps {
  /** Raw `<n>` from the `#task:<n>` sigil — already validated as a
   *  positive integer by the markdown tokenizer. */
  taskNumber: number;
  /** Preserve the authored bare number when no task resolves. */
  bare?: boolean;
}

export interface StaticTaskRefSummary {
  task_number: number;
  title: string;
}

/** Static references retain raw text until metadata is available. */
export function TaskRefStaticChip({
  taskNumber,
  task,
}: TaskRefProps & { task?: StaticTaskRefSummary | null }): JSX.Element {
  const inertLabel = `#task:${taskNumber}`;
  if (!task) {
    return <>{inertLabel}</>;
  }
  // Same silhouette as the live `interactiveChip`: borderless accent link, no
  // fill, no dead side padding. forza6 repaints it to ink + gold marker via the
  // shared `state='resolved'` hook — no export-specific styling exists.
  return (
    <span
      className="inline-flex max-w-55 items-center gap-1 rounded-(--chip-radius) font-medium text-accent"
      title={`Task #${task.task_number} · ${task.title}`}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
    >
      <span className="truncate">
        <span data-task-ref-num>#{task.task_number}</span> {task.title}
      </span>
    </span>
  );
}

/** Only resolved tasks receive reference styling and a metadata popover. */
export function TaskRef({ taskNumber, bare = false }: TaskRefProps): JSX.Element {
  const ctx = useTaskRefContext();
  const conversationId = ctx?.conversationId ?? null;
  const result = useTaskByNumber(
    ctx ? { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId } : null,
    taskNumber,
  );
  const task = result.data ?? null;
  const onOpenTask = ctx?.onOpenTask;
  const inertLabel = `#task:${taskNumber}`;
  // Status-picker open state lifted here (not inside TaskPopoverBody) so
  // we can pin the hover-card open via `keepOpen` while the picker is
  // active — the picker portals outside the hover-card DOM, so without
  // this the pointer-leave close delay would unmount it mid-pick.
  const [pickerOpen, setPickerOpen] = useState(false);
  const updateStatus = useUpdateTaskStatus();

  if (!conversationId || result.isLoading || !task) {
    return <>{bare ? `#${taskNumber}` : inertLabel}</>;
  }

  const label = `#${task.task_number} · ${task.title}`;
  const tooltip = `Task ${label}`;
  // The number sits in its own `data-task-ref-num` span so a theme can give
  // digits their own display face while the title keeps prose sans. By default
  // both inherit `--appearance-prose-font` (one sans run, no mono/sans seam —
  // never `font-mono`: forza6's `--font-mono` is Space Mono, whose digits read
  // poorly, @shiki `sLh6CqwNw0uAtThk`, #task:1757). forza6 alone routes the
  // number to `--font-display` (Rajdhani) — a deliberate "number is a number,
  // title is a title" hierarchy matching its board / popover stamp, not a seam
  // (#task:1760).
  const chipContent = (
    <>
      <span className="truncate">
        <span data-task-ref-num>#{task.task_number}</span> {task.title}
      </span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-55 items-center gap-0.5 rounded-(--chip-radius) bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
      // Wrapped in HoverPopover below — `aria-label` instead of the
      // native `title` attribute (see loading branch comment above
      // for the flicker rationale).
      aria-label={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved-no-handler"
    >
      {chipContent}
    </span>
  );

  // Borderless accent link — the shared base for every theme. Rest is flat
  // accent text (no fill / no border); hover underlines the label span (see
  // `.markdown-body [data-task-ref-state='resolved']:hover > span` in
  // global.css — text-decoration targets the label span directly). A filled
  // block reads as a slab in running prose regardless of
  // hue; a link reads as what it is (#task:1725). Each theme just supplies its
  // own `--accent`. focus-visible outline kept — the sole focus signal now that
  // the chip is borderless.
  //
  // No `px-1.5 -mx-0.5`: unlike the inert variants (which keep a
  // `bg-bg-elevated` fill that needs side padding), this chip has no fill, so
  // the padding was dead box drawn around a bare link. The `-mx-0.5` only
  // existed to pull that padded box back into the text flow; with the padding
  // gone it would instead pull the chip 2px into its neighbours. Dropping both
  // lets the link sit as plain inline text — the hover marker/underline rides
  // the label span, which already hugs the words (shiki, #task:1770).
  //
  // The one surface that DOES fill on hover — the non-forza6
  // system-activity-cluster (accent tile, global.css
  // `.system-activity-cluster [data-task-ref]:hover`) — reintroduces the
  // horizontal padding in CSS, not here: padding belongs to the filled
  // surface, not the shared component, so a fill-less surface never pays for
  // it. forza6's cluster is a bare marker and zeroes it back out (#task:1776).
  const interactiveChip = (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex max-w-55 cursor-pointer items-center gap-1 rounded-(--chip-radius) font-medium text-accent focus-outline"
      aria-label={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(task.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(task.id);
      }}
    >
      {chipContent}
    </span>
  );

  // Both interactive and inert resolved-state chips get the popover —
  // the popover is purely informational (status / assignee /
  // conversation), not a click affordance, so it makes sense even
  // when the click handler is unavailable (e.g. saved/preview
  // surfaces with workspace context but no task-open host).
  return (
    <HoverPopover
      trigger={onOpenTask ? interactiveChip : inertChip}
      content={
        <TaskPopoverBody
          task={task}
          onStatusChange={(next) => updateStatus.mutate({ taskId: task.id, status: next })}
          onPickerOpenChange={setPickerOpen}
        />
      }
      isContentReady={true}
      keepOpen={pickerOpen}
    />
  );
}

/**
 * Popover body — full title (no clamp) with a single inline meta row
 * for assignee · created · conversation. Earlier this was a `dl` with
 * three labelled rows; @shiki feedback (`WlIwDhmrbu6_azy1`) was that
 * the form-style layout felt heavy in such a small surface. Inline
 * meta keeps the popover scannable: title dominates, meta sits as one
 * subtle muted line that wraps if it has to.
 */
function TaskPopoverBody({
  task,
  onStatusChange,
  onPickerOpenChange,
}: {
  task: TaskSummaryDto;
  onStatusChange: (next: TaskStatus) => void;
  onPickerOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { relative, absolute } = useRelativeTime(task.created_at);
  const channelLabel = taskChannelLabel(task);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span data-tasks-num className="font-mono text-(length:--text-badge) text-text-muted">
          #{task.task_number}
        </span>
        {/* Same interactive chip as the task-pane card: click → "Move to"
            picker → POST /status. `onPickerOpenChange` pins the host
            hover-card open while the picker is up. */}
        <TaskStatusBadge
          status={task.status}
          onChange={onStatusChange}
          onOpenChange={onPickerOpenChange}
        />
      </div>
      <p className="wrap-break-word text-xs font-medium text-text-primary">{task.title}</p>
      <p className="flex items-baseline gap-1.5 text-(length:--text-meta) text-text-muted">
        <span className="shrink-0 text-text-secondary">
          {task.assignee ? task.assignee.name : <em>unassigned</em>}
        </span>
        {channelLabel !== null ? (
          <>
            <span aria-hidden className="shrink-0 text-text-muted/60">
              ·
            </span>
            <span className="min-w-0 truncate text-text-secondary" title={channelLabel}>
              in {channelLabel}
            </span>
          </>
        ) : null}
        <span aria-hidden className="shrink-0 text-text-muted/60">
          ·
        </span>
        <span className="shrink-0" title={absolute}>
          {relative}
        </span>
      </p>
    </div>
  );
}
