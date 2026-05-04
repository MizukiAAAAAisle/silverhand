import { useEffect, useMemo, useState } from 'react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { TaskStatusPill } from './TaskStatusPill';
import { useTasks, useUpdateTaskStatus } from '@/features/tasks/hooks';

/**
 * Channel-wide tasks panel reachable from the titlebar. Opens as a
 * centered dialog so the chat surface stays visible behind the
 * backdrop. Layout is a four-column kanban (TODO / In progress / In
 * review / Done) over either a single session (default: the currently
 * active session) or every session in the channel.
 *
 * A session strip below the header shows "All" + the five most-recent
 * sessions for quick switching; older sessions are reachable via the
 * NavRail "Tasks" global view (intentional cap — this is a quick-look
 * surface, not the full task explorer).
 *
 * Click a card → close + jump back to the source message in chat.
 * Status changes go through the human-override endpoint via
 * useUpdateTaskStatus.
 */
export interface ChannelTasksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  channelName: string | null;
  /** Sessions in this channel — drives the session strip. Closed
   *  sessions are kept (their tasks are still meaningful) but visually
   *  de-emphasised. Order is whatever the caller passes; the strip
   *  re-sorts by `created_at` descending. */
  sessions: Array<{
    id: string;
    title: string;
    closed_at: number | null;
    created_at: number;
  }>;
  /** Initially-selected session for the filter. null → All sessions. */
  defaultSessionId: string | null;
  /** Click on a task card. Caller is responsible for closing the dialog
   *  if it wants the chat to take focus. */
  onJumpToMessage?: (params: {
    workspaceId?: string;
    channelId: string;
    messageId: string;
  }) => void;
}

const STRIP_LIMIT = 5;

export function ChannelTasksDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
  sessions,
  defaultSessionId,
  onJumpToMessage,
}: ChannelTasksDialogProps): JSX.Element {
  // Local filter state: null = all sessions in this channel.
  const [sessionFilter, setSessionFilter] = useState<string | null>(
    defaultSessionId,
  );
  // Re-sync to the active session every time the dialog opens — so
  // re-opening it after switching sessions defaults to the new one
  // rather than sticking on whatever the user picked last time.
  useEffect(() => {
    if (open) setSessionFilter(defaultSessionId);
  }, [open, defaultSessionId]);

  const { data: tasks = [], isLoading } = useTasks(
    sessionFilter
      ? { session_id: sessionFilter }
      : { channel_id: channelId },
  );
  const updateStatus = useUpdateTaskStatus();

  // Top-N sessions by creation time, plus a guarantee that the
  // currently-selected one is always in the strip (so picking an
  // older session via the global view + clicking back here doesn't
  // make the active filter "disappear" from the chip row).
  const stripSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);
    const top = sorted.slice(0, STRIP_LIMIT);
    if (sessionFilter && !top.some(s => s.id === sessionFilter)) {
      const sel = sorted.find(s => s.id === sessionFilter);
      if (sel) top.push(sel);
    }
    return top;
  }, [sessions, sessionFilter]);

  const grouped = groupByStatus(tasks);

  const handleClick = (t: TaskSummaryDto): void => {
    onJumpToMessage?.({
      workspaceId: t.channel_id,
      channelId: t.session.id,
      messageId: t.message_id,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-h-[760px] w-[90vw] max-w-5xl flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <DialogTitle className="font-serif text-base font-semibold">
            Tasks
            {channelName ? (
              <span className="ml-2 text-sm font-normal text-text-muted">
                · #{channelName}
              </span>
            ) : null}
          </DialogTitle>
          <span className="text-xs text-text-muted">· {tasks.length}</span>
        </div>

        <SessionStrip
          value={sessionFilter}
          sessions={stripSessions}
          onChange={setSessionFilter}
        />

        <div className="grid min-h-0 flex-1 grid-cols-4 items-start gap-3 overflow-y-auto">
          {COLUMNS.map(col => (
            <KanbanColumn
              key={col.status}
              title={col.label}
              status={col.status}
              tasks={grouped[col.status]}
              isLoading={isLoading}
              onCardClick={handleClick}
              onStatusChange={(messageId, status) =>
                updateStatus.mutate({ messageId, status })
              }
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const COLUMNS: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
];

function groupByStatus(
  tasks: TaskSummaryDto[],
): Record<TaskStatus, TaskSummaryDto[]> {
  const out: Record<TaskStatus, TaskSummaryDto[]> = {
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const t of tasks) out[t.status].push(t);
  return out;
}

// ── Session strip ──────────────────────────────────────────────────

function SessionStrip({
  value,
  sessions,
  onChange,
}: {
  value: string | null;
  sessions: Array<{ id: string; title: string; closed_at: number | null }>;
  onChange: (id: string | null) => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle pb-2">
      <SessionChip selected={value === null} onClick={() => onChange(null)}>
        All
      </SessionChip>
      {sessions.map(s => (
        <SessionChip
          key={s.id}
          selected={value === s.id}
          dim={s.closed_at !== null}
          onClick={() => onChange(s.id)}
          title={s.title}
        >
          {s.title}
        </SessionChip>
      ))}
    </div>
  );
}

function SessionChip({
  selected,
  dim = false,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  dim?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'max-w-[160px] truncate rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
        selected
          ? 'border-accent bg-accent text-text-on-accent'
          : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-accent hover:text-text-primary',
        dim && !selected && 'opacity-60',
      )}
    >
      {children}
    </button>
  );
}

// ── Column ─────────────────────────────────────────────────────────

function KanbanColumn({
  title,
  status,
  tasks,
  isLoading,
  onCardClick,
  onStatusChange,
}: {
  title: string;
  status: TaskStatus;
  tasks: TaskSummaryDto[];
  isLoading: boolean;
  onCardClick: (t: TaskSummaryDto) => void;
  onStatusChange: (messageId: string, next: TaskStatus) => void;
}): JSX.Element {
  return (
    <section
      className={cn(
        'flex flex-col rounded-md border border-border-subtle bg-bg-base',
        status === 'done' && 'opacity-80',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-text-muted">
          {tasks.length}
        </span>
      </header>
      <div className="p-2">
        {isLoading ? (
          <p className="px-2 py-3 text-center text-[11px] text-text-muted">
            加载中…
          </p>
        ) : tasks.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] italic text-text-muted">
            No {title.toLowerCase()} tasks
          </p>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map(t => (
              <li key={t.message_id}>
                <TaskCard
                  task={t}
                  onClick={() => onCardClick(t)}
                  onStatusChange={next => onStatusChange(t.message_id, next)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── Card ───────────────────────────────────────────────────────────

function TaskCard({
  task,
  onClick,
  onStatusChange,
}: {
  task: TaskSummaryDto;
  onClick: () => void;
  onStatusChange: (next: TaskStatus) => void;
}): JSX.Element {
  return (
    <div className="group flex w-full items-stretch rounded-md border border-border-subtle bg-bg-primary transition-colors hover:border-accent hover:bg-bg-hover">
      {/* Jump button: covers the content area, drives navigation */}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 flex-col gap-1 p-2 text-left"
      >
        <span className="shrink-0 font-mono text-[10px] text-text-muted">
          #{task.task_number}
        </span>
        <span className="min-w-0 break-words text-xs text-text-primary">
          {task.title}
        </span>
        <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
          {task.assignee ? (
            <span>@{task.assignee.name}</span>
          ) : (
            <span className="italic">unassigned</span>
          )}
          <span
            className="ml-auto max-w-[100px] truncate"
            title={task.session.title}
          >
            {task.session.title}
          </span>
        </div>
      </button>
      {/* Status pill: sibling button — never nested, never overflows */}
      <div className="flex shrink-0 items-start p-2 pl-0">
        <TaskStatusPill status={task.status} size="sm" onChange={onStatusChange} />
      </div>
    </div>
  );
}
