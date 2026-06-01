import { ClipboardCheck } from 'lucide-react';
import { useTaskByNumber } from '@/features/tasks/useTaskByNumber';
import { useTaskRefContext } from '@/features/tasks/TaskRefContext';
import { HoverPopover } from './HoverPopover';
import { useRelativeTime } from './useRelativeTime';
import type { TaskSummaryDto, TaskStatus } from '@silverhand/shared';

interface TaskRefProps {
  /** Raw `<n>` from the `#task:<n>` sigil — already validated as a
   *  positive integer by the markdown tokenizer. */
  taskNumber: number;
}

/**
 * Inline chip rendering of a `#task:<n>` reference.
 *
 * Mirrors the structural choices of `ConversationRef` but addresses
 * tasks by their workspace-scoped numeric id. Resolution context
 * (current workspace + click handler) flows through `TaskRefContext`
 * — no prop drilling from the many Markdown call sites.
 *
 * Rendering rules:
 *  - No context → inert `#task:<n>` text. Saved/preview surfaces that
 *    don't sit inside a conversation can't answer "which workspace?".
 *  - Lookup loading → inert (no spinner / placeholder shimmer) on the
 *    chip itself. The hover popover shows a skeleton if the user
 *    hovers ≥500ms while the fetch is still in flight.
 *  - Resolved + missing → inert (the task was deleted or doesn't
 *    exist in this workspace). Surfacing a broken chip would be
 *    worse than a silent demote.
 *  - Resolved + present → clickable chip, label `#<n> · title`,
 *    icon `ClipboardCheck`. Click hands off to `onOpenTask` from
 *    context, which is wired to write `?task=<n>` and open the
 *    Tasks drawer focused on that row. Hover ≥500ms surfaces a
 *    popover with status / assignee / conversation context.
 */
export function TaskRef({ taskNumber }: TaskRefProps): JSX.Element {
  const ctx = useTaskRefContext();
  const workspaceId = ctx?.workspaceId ?? null;
  const result = useTaskByNumber(workspaceId, taskNumber);
  const task = result.data ?? null;
  const onOpenTask = ctx?.onOpenTask;
  const inertLabel = `#task:${taskNumber}`;

  // No-context (saved/preview surfaces) and resolved-missing (task
  // deleted or never existed in this workspace) render a tooltip-only
  // pill with no popover — there's nothing meaningful to surface on
  // hover for either case. Loading WITH workspace context goes through
  // HoverPopover with `isContentReady=false` so a hover ≥500ms while
  // the fetch is still in flight gets a skeleton (Cindy review of
  // commit 3 — previously the loading branch returned a bare span,
  // missing the 500ms→skeleton spec entirely).
  if (!workspaceId) {
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="no-context"
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        <span className="truncate">{inertLabel}</span>
      </span>
    );
  }

  if (result.isLoading) {
    const loadingChip = (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        // Wrapped in HoverPopover below — use aria-label, not the
        // native `title` attribute. macOS browsers schedule the native
        // tooltip on a 2-3s cycle that competes with Radix HoverCard
        // (mouse "leaves" the trigger when the OS tooltip overlays
        // it, which closes the popover; then mouseenter reopens after
        // the 500ms grace, producing a periodic flicker — @shiki
        // report `NbcXUOnFDKfXYRxV`).
        aria-label={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="loading"
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        <span className="truncate">{inertLabel}</span>
      </span>
    );
    return (
      <HoverPopover
        trigger={loadingChip}
        content={null}
        isContentReady={false}
      />
    );
  }

  if (!task) {
    // Resolved-missing — tooltip only, no popover. A "task not found"
    // popover doesn't add information beyond the inert pill.
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="missing"
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        <span className="truncate">{inertLabel}</span>
      </span>
    );
  }

  const label = `#${task.task_number} · ${task.title}`;
  const tooltip = `Task ${label}`;
  const chipContent = (
    <>
      <ClipboardCheck className="size-3 shrink-0 self-center" />
      <span className="truncate">{label}</span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
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
      className="inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded-[var(--chip-radius)] bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      aria-label={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(taskNumber);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(taskNumber);
      }}
    >
      {chipContent}
    </span>
  );

  // Both interactive and inert resolved-state chips get the popover —
  // the popover is purely informational (status / assignee /
  // conversation), not a click affordance, so it makes sense even
  // when the click handler is unavailable (e.g. saved/preview
  // surfaces with workspace context but no drawer).
  return (
    <HoverPopover
      trigger={onOpenTask ? interactiveChip : inertChip}
      content={<TaskPopoverBody task={task} />}
      isContentReady={true}
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
function TaskPopoverBody({ task }: { task: TaskSummaryDto }): JSX.Element {
  const { relative, absolute } = useRelativeTime(task.created_at);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-text-muted">
          #{task.task_number}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>
      <p className="break-words text-xs font-medium text-text-primary">
        {task.title}
      </p>
      <p className="flex items-baseline gap-1.5 text-[11px] text-text-muted">
        <span className="shrink-0 text-text-secondary">
          {task.assignee ? `@${task.assignee.name}` : <em>unassigned</em>}
        </span>
        <span aria-hidden className="shrink-0 text-text-muted/60">·</span>
        <span
          className="min-w-0 truncate text-text-secondary"
          title={task.conversation.title}
        >
          in {task.conversation.title}
        </span>
        <span aria-hidden className="shrink-0 text-text-muted/60">·</span>
        <span className="shrink-0" title={absolute}>{relative}</span>
      </p>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: TaskStatus }): JSX.Element {
  const labels: Record<TaskStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    in_review: 'in review',
    done: 'done',
    closed: 'closed',
  };
  return (
    <span
      data-task-status={status}
      className="rounded-[var(--chip-radius)] px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide"
    >
      {labels[status]}
    </span>
  );
}
