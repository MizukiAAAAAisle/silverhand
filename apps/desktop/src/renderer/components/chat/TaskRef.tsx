import { ClipboardCheck } from 'lucide-react';
import { useTaskByNumber } from '@/features/tasks/useTaskByNumber';
import { useTaskRefContext } from '@/features/tasks/TaskRefContext';
import { HoverPopover } from './HoverPopover';
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

  // Inert paths (no context, resolved-missing) render the same plain
  // pill so layout doesn't reflow on resolution. Loading also lands
  // here so the chip itself never blinks; the popover is the place
  // we surface lookup state visibly.
  if (!workspaceId || result.isLoading || !task) {
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state={
          !workspaceId
            ? 'no-context'
            : result.isLoading
              ? 'loading'
              : 'missing'
        }
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
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
      title={tooltip}
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
      className="inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      title={tooltip}
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
 * Popover body — minimal facts the user typically wants without
 * leaving the conversation: status (color-coded), assignee, source
 * conversation, creation time. Title is the first line and wraps to
 * 2 lines max so a long task title doesn't blow up the popover.
 */
function TaskPopoverBody({ task }: { task: TaskSummaryDto }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-text-muted">
          #{task.task_number}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>
      <p className="line-clamp-2 break-words text-xs font-medium text-text-primary">
        {task.title}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
        <dt className="text-text-muted">Assignee</dt>
        <dd className="truncate text-text-secondary">
          {task.assignee ? `@${task.assignee.name}` : <em>unassigned</em>}
        </dd>
        <dt className="text-text-muted">In</dt>
        <dd
          className="truncate text-text-secondary"
          title={task.conversation.title}
        >
          {task.conversation.title}
        </dd>
      </dl>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: TaskStatus }): JSX.Element {
  const styles: Record<TaskStatus, string> = {
    todo: 'bg-bg-elevated text-text-muted',
    in_progress: 'bg-accent/10 text-accent',
    in_review: 'bg-warning/10 text-warning',
    done: 'bg-success/10 text-success',
  };
  const labels: Record<TaskStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    in_review: 'in review',
    done: 'done',
  };
  return (
    <span
      className={
        'rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ' +
        styles[status]
      }
    >
      {labels[status]}
    </span>
  );
}
