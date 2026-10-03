import { taskChannelLabel } from "@/features/tasks/model/task-place";
import { useState } from "react";
import { Clock } from "lucide-react";
import { useTaskByNumber } from "@/features/tasks/hooks/use-task-by-number";
import { useTaskRefContext } from "@/features/tasks/components/task-ref-context";
import { useUpdateTaskStatus } from "@/features/tasks/hooks/hooks";
import { TaskStatusBadge } from "@/features/tasks/components/task-status-badge";
import { HoverPopover } from "./hover-popover";
import { useRelativeTime } from "../hooks/use-relative-time";
import type { TaskSummaryDto, TaskStatus } from "@silverhand/shared";

interface TaskRefProps {
  taskNumber: number;
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
  // fill, no dead side padding. poster repaints it to ink + gold marker via the
  // shared `state='resolved'` hook — no export-specific styling exists.
  return (
    <span
      className="inline-flex max-w-55 items-center gap-1 rounded-(--chip-radius) font-medium text-accent"
      title={`Task #${task.task_number} ${task.title}`}
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

  const [pickerOpen, setPickerOpen] = useState(false);
  const updateStatus = useUpdateTaskStatus();

  if (!conversationId || result.isLoading || !task) {
    return <>{bare ? `#${taskNumber}` : inertLabel}</>;
  }

  const label = `#${task.task_number} ${task.title}`;
  const tooltip = `Task ${label}`;

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
      <p className="flex items-center gap-1.5 text-(length:--text-meta) text-text-muted">
        <span className="shrink-0 text-text-secondary">
          {task.assignee ? task.assignee.name : <em>unassigned</em>}
        </span>
        {channelLabel !== null ? (
          <span className="min-w-0 truncate text-text-secondary" title={channelLabel}>
            in {channelLabel}
          </span>
        ) : null}
        <span className="inline-flex shrink-0 items-center gap-1" title={absolute}>
          <Clock className="size-3 shrink-0" aria-hidden />
          <span>{relative}</span>
        </span>
      </p>
    </div>
  );
}
