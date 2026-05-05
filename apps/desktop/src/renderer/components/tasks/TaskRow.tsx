import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { TaskStatusPill } from './TaskStatusPill';

/**
 * One row in any task list (drawer, channel tab, global view). Compact
 * layout: `#N` · title · status pill, with assignee + conversation as muted
 * tail.
 *
 * `onClick` is the row-level click — typically "scroll to the task's
 * source message". `onStatusChange` powers the pill dropdown; omit to
 * render a read-only pill (used in cross-conversation aggregate views where
 * the human shouldn't edit other sessions' tasks from this row… though
 * v1 does allow it; left as a hook for future tightening).
 *
 * `showSession` is on by default for aggregate views and turned off
 * inside the per-conversation drawer (where it would be redundant).
 */
export interface TaskRowProps {
  task: TaskSummaryDto;
  onClick?: (task: TaskSummaryDto) => void;
  onStatusChange?: (next: TaskStatus) => void;
  showSession?: boolean;
  className?: string;
}

export function TaskRow({
  task,
  onClick,
  onStatusChange,
  showSession = true,
  className,
}: TaskRowProps): JSX.Element {
  const interactive = !!onClick;
  const Wrapper = interactive ? 'button' : 'div';
  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={interactive ? () => onClick!(task) : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left',
        interactive && 'hover:border-border-subtle hover:bg-bg-hover',
        className,
      )}
    >
      <span className="shrink-0 font-mono text-[11px] text-text-muted">
        #{task.task_number}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
        {task.title}
      </span>
      <div
        className="flex shrink-0 items-center gap-2"
        // Don't bubble the pill click to the row's onClick.
        onClick={e => e.stopPropagation()}
      >
        {task.assignee ? (
          <span className="text-[10px] text-text-muted">
            @{task.assignee.name}
          </span>
        ) : (
          <span className="text-[10px] italic text-text-muted">unassigned</span>
        )}
        {showSession ? (
          <span
            className="max-w-[120px] truncate text-[10px] text-text-muted"
            title={task.conversation.title}
          >
            · {task.conversation.title}
          </span>
        ) : null}
        <TaskStatusPill
          status={task.status}
          size="sm"
          onChange={onStatusChange}
        />
      </div>
    </Wrapper>
  );
}
