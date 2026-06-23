import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { TaskStatus } from '@silverhand/shared';
import { cn } from '@/lib/cn';

/**
 * Status badge — non-interactive by default. Pass `onChange` to make
 * it click-to-open a tiny popover that picks a new status. Disabled
 * states (closed sessions, mutation in flight) just render the
 * read-only pill.
 *
 * `done` and `todo` aren't exposed as direct options under
 * `in_progress` per the agent rules in docs/tasks-design.md §3.2,
 * but human UI bypasses that — see the UI table below. We offer
 * every status except the current one.
 */
export interface TaskStatusPillProps {
  status: TaskStatus;
  onChange?: (next: TaskStatus) => void;
  size?: 'sm' | 'md';
  className?: string;
}

const COPY: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  closed: 'Closed',
};

const SIZE: Record<NonNullable<TaskStatusPillProps['size']>, string> = {
  sm: 'h-5 px-1.5 text-[10px]',
  md: 'h-6 px-2 text-xs',
};

const ALL_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'closed',
];

export function TaskStatusPill({
  status,
  onChange,
  size = 'md',
  className,
}: TaskStatusPillProps): JSX.Element {
  const base = cn(
    'inline-flex items-center justify-center rounded-full font-medium uppercase tracking-wider whitespace-nowrap',
    SIZE[size],
    className,
  );
  const label = COPY[status];

  if (!onChange) {
    return (
      <span data-task-status={status} className={base}>
        {label}
      </span>
    );
  }

  return (
    <PillPicker current={status} onChange={onChange}>
      <button
        type="button"
        data-task-status={status}
        className={cn(base, 'cursor-pointer transition-opacity hover:opacity-80')}
      >
        {label}
      </button>
    </PillPicker>
  );
}

function PillPicker({
  current,
  onChange,
  children,
}: {
  current: TaskStatus;
  onChange: (next: TaskStatus) => void;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          data-popover-frame="info"
          className="z-50 min-w-[140px] bg-bg-floating p-1 shadow-popover outline-none"
        >
          {ALL_STATUSES.filter(s => s !== current).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
            >
              <TaskStatusPill status={s} size="sm" />
              <span className="text-text-muted">→</span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
