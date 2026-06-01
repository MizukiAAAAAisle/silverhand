import { useState, type ReactElement, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ArrowRight } from 'lucide-react';
import type { TaskStatus } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import {
  AppContextMenu,
  AppContextMenuItem,
} from '@/components/menus/AppContextMenu';

/**
 * Small inline status chip for task cards (drawer + global section).
 *
 * Chip form (9px, `--chip-radius`) is deliberately distinct from the
 * larger `TaskStatusPill` capsule — forza6 keeps a pill/chip form
 * boundary (Cindy review `ME-fJNO4XJRLpSHz`), so this stays chip-shaped
 * even when interactive instead of swapping to the pill.
 *
 * Read-only by default. Pass `onChange` to make it click-to-open a tiny
 * popover that moves the task to any other status — the human-side
 * "manage any task, not just in_review" affordance (shiki
 * `x9rIbAIlyUBVneiu`). Status transitions are unrestricted (`POST
 * /api/tasks/:id/status` allows any→any), so we offer every status except
 * the current one — including `closed` (move-to-close) and, on a closed
 * task, the four open statuses (reopen).
 */
const LABELS: Record<TaskStatus, string> = {
  todo: 'todo',
  in_progress: 'in progress',
  in_review: 'in review',
  done: 'done',
  closed: 'closed',
};

/** Title-case labels for menu/sentence contexts ("Move to In review"). */
const MOVE_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  closed: 'Closed',
};

const ALL_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'closed',
];

const CHIP =
  'rounded-[var(--chip-radius)] px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide';

export function TaskStatusBadge({
  status,
  onChange,
  className,
}: {
  status: TaskStatus;
  onChange?: (next: TaskStatus) => void;
  className?: string;
}): JSX.Element {
  if (!onChange) {
    return (
      <span data-task-status={status} className={cn(CHIP, className)}>
        {LABELS[status]}
      </span>
    );
  }
  return (
    <StatusPicker current={status} onChange={onChange}>
      <button
        type="button"
        data-task-status={status}
        aria-label={`更改状态（当前 ${LABELS[status]}）`}
        title="更改状态"
        // Stop the click from reaching the card's stretched jump
        // overlay underneath.
        onClick={e => e.stopPropagation()}
        className={cn(
          CHIP,
          'cursor-pointer transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
          className,
        )}
      >
        {LABELS[status]}
      </button>
    </StatusPicker>
  );
}

function StatusPicker({
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
          onClick={e => e.stopPropagation()}
          className="z-50 min-w-[136px] rounded-[var(--floating-radius)] border border-border bg-bg-floating p-1 shadow-lg outline-none"
        >
          <div className="px-1.5 pb-1 pt-0.5 text-[9px] font-medium uppercase tracking-wider text-text-muted">
            Move to
          </div>
          {ALL_STATUSES.filter(s => s !== current).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
              className="flex w-full items-center rounded-[var(--floating-item-radius)] px-2 py-1.5 text-left hover:bg-bg-hover"
            >
              <span data-task-status={s} className={CHIP}>
                {LABELS[s]}
              </span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Right-click context menu for task cards — direct "Move to {status}"
 * items (shiki `wCrBduGkOdT7EBTt`), now including `closed` and reopen
 * (any→any via `ALL_STATUSES`). Mirrors the StatusPicker but reachable
 * without first hitting the small badge, so the whole card surface
 * becomes a status-management affordance.
 *
 * `children` must be a single element (Radix ContextMenu.Trigger asChild)
 * — pass the card's root <div>.
 */
export function TaskCardContextMenu({
  status,
  onStatusChange,
  children,
}: {
  status: TaskStatus;
  onStatusChange: (next: TaskStatus) => void;
  children: ReactElement;
}): JSX.Element {
  return (
    <AppContextMenu trigger={children}>
      {ALL_STATUSES.filter(s => s !== status).map(s => (
        <AppContextMenuItem
          key={s}
          icon={<ArrowRight className="size-3.5" />}
          onSelect={() => onStatusChange(s)}
        >
          Move to {MOVE_LABELS[s]}
        </AppContextMenuItem>
      ))}
    </AppContextMenu>
  );
}
