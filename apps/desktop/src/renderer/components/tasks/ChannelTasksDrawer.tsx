import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useTasks, useUpdateTaskStatus } from '@/features/tasks/hooks';

/**
 * Channel-wide tasks panel — a floating right-side drawer that overlays
 * the main layout without displacing it. Width is user-adjustable via a
 * drag handle on the left edge and persisted in localStorage.
 *
 * Content is identical to `ChannelTasksDialog`: four-column kanban,
 * session strip, and card → jump navigation.
 */
export interface ChannelTasksDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  channelName: string | null;
  sessions: Array<{
    id: string;
    title: string;
    closed_at: number | null;
    created_at: number;
  }>;
  /** Initially-selected session for the filter. null → All sessions. */
  defaultSessionId: string | null;
  onJumpToMessage?: (params: {
    channelId: string;
    sessionId: string;
    messageId: string;
  }) => void;
}

const STORAGE_KEY = 'silverhand.layout.tasks-drawer-width';
const MIN_WIDTH = 340;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 520;

// ── Drawer width hook ────────────────────────────────────────────────

function useDrawerWidth() {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const n = raw !== null ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    } catch {
      // private mode — fall through
    }
    return DEFAULT_WIDTH;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // quota or private mode
    }
  }, [width]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const originX = e.clientX;
      const originWidth = width;

      const onMove = (ev: PointerEvent): void => {
        // Left-edge handle: drag left = wider (negate dx).
        const dx = ev.clientX - originX;
        const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, originWidth - dx));
        setWidth(next);
      };
      const onUp = (): void => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  return { width, startResize };
}

// ── Main component ───────────────────────────────────────────────────

export function ChannelTasksDrawer({
  open,
  onOpenChange,
  channelId,
  channelName,
  sessions,
  defaultSessionId,
  onJumpToMessage,
}: ChannelTasksDrawerProps): JSX.Element {
  const { width: drawerWidth, startResize } = useDrawerWidth();

  const [sessionFilter, setSessionFilter] = useState<string | null>(
    defaultSessionId,
  );
  // Re-sync to the active session every time the drawer opens.
  useEffect(() => {
    if (open) setSessionFilter(defaultSessionId);
  }, [open, defaultSessionId]);

  const closeDrawer = useCallback(
    (event?: React.SyntheticEvent): void => {
      event?.preventDefault();
      event?.stopPropagation();
      onOpenChange(false);
    },
    [onOpenChange],
  );

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, closeDrawer]);

  const { data: tasks = [], isLoading } = useTasks(
    sessionFilter
      ? { session_id: sessionFilter }
      : { channel_id: channelId },
  );
  const updateStatus = useUpdateTaskStatus();

  // All sessions sorted newest-first — no cap so every session is reachable.
  const stripSessions = useMemo(
    () => [...sessions].sort((a, b) => b.created_at - a.created_at),
    [sessions],
  );

  const grouped = groupByStatus(tasks);

  const handleCardClick = (t: TaskSummaryDto): void => {
    onJumpToMessage?.({
      channelId: t.channel_id,
      sessionId: t.session.id,
      messageId: t.message_id,
    });
    onOpenChange(false);
  };

  // Focus trap: keep focus inside drawer while open.
  const drawerRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* Click-away backdrop — `no-drag` so its inset-0 footprint doesn't
          re-activate the titlebar drag region; conditionally rendered so
          Electron triggers a fresh hit-test recalculation on open/close. */}
      {open ? (
        <div
          className="fixed inset-0 z-40 no-drag"
          aria-hidden
          onPointerDown={closeDrawer}
          onClick={closeDrawer}
        />
      ) : null}

      {/* Stable no-drag wrapper — never transforms, so Electron's
          hit-test cache for the drag region stays coherent even while
          the inner panel is mid-animation. pointer-events toggle ensures
          the closed drawer doesn't intercept clicks behind it. */}
      <div
        className={cn(
          'fixed inset-y-0 right-0 z-50',
          // Only opt out of the Electron drag region while the drawer is
          // open.  Keeping `no-drag` when closed would permanently disable
          // titlebar drag / double-click-zoom over this pixel area.
          open && 'no-drag',
          open ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        style={{ width: drawerWidth }}
      >
        {/* Inner panel — slides in/out; all visual chrome lives here */}
        <div
          ref={drawerRef}
          role="dialog"
          aria-label="Tasks"
          aria-modal="true"
          className={cn(
            'flex h-full flex-col',
            'border-l border-border bg-white shadow-2xl',
            'transition-transform duration-200 ease-in-out',
            open ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          {/* Left-edge drag handle */}
          <div
            className="absolute inset-y-0 left-0 w-1 cursor-col-resize opacity-0 hover:opacity-100 hover:bg-accent/40 transition-opacity"
            onPointerDown={startResize}
            aria-hidden
          />

          {/* Header */}
          <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-3">
            <span className="font-serif text-base font-semibold text-text-primary">
              Tasks
              {channelName ? (
                <span className="ml-2 text-sm font-normal text-text-muted">
                  · #{channelName}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onPointerDown={closeDrawer}
              onClick={closeDrawer}
              aria-label="关闭 Tasks"
              className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Session filter strip */}
          <div className="shrink-0 border-b border-border-subtle px-4 py-2">
            <SessionStrip
              value={sessionFilter}
              sessions={stripSessions}
              onChange={setSessionFilter}
            />
          </div>

          {/* Kanban board */}
          <div className="grid min-h-0 flex-1 grid-cols-4 items-start gap-3 overflow-y-auto p-4">
            {COLUMNS.map(col => (
              <KanbanColumn
                key={col.status}
                title={col.label}
                status={col.status}
                tasks={grouped[col.status]}
                isLoading={isLoading}
                onCardClick={handleCardClick}
                onStatusChange={(messageId, status) =>
                  updateStatus.mutate({ messageId, status })
                }
              />
            ))}
          </div>
        </div>
      </div>
    </>
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

// ── Session strip ────────────────────────────────────────────────────

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
    <div className="flex flex-wrap items-center gap-1">
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

// ── Kanban column ────────────────────────────────────────────────────

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

// ── Task card ────────────────────────────────────────────────────────

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
    <div className="group relative rounded-md border border-border-subtle bg-bg-primary transition-colors hover:border-accent hover:bg-bg-hover">
      {/* Jump to message — full card content area */}
      <button
        type="button"
        onClick={onClick}
        className="block w-full p-2 pr-7 text-left"
      >
        {/* Row 1: #number + status badge inline */}
        <div className="flex items-center gap-1.5 pb-0.5">
          <span className="font-mono text-[10px] text-text-muted">
            #{task.task_number}
          </span>
          <TaskStatusBadge status={task.status} />
        </div>
        {/* Row 2: title */}
        <span className="block min-w-0 break-words text-xs text-text-primary">
          {task.title}
        </span>
        {/* Row 3: assignee + session */}
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
          {task.assignee ? (
            <span>@{task.assignee.name}</span>
          ) : (
            <span className="italic">unassigned</span>
          )}
          <span
            className="ml-auto max-w-[80px] truncate"
            title={task.session.title}
          >
            {task.session.title}
          </span>
        </div>
      </button>

      {/* Check button — top-right corner, only for in_review.
          Ring-only by default; turns green on hover to signal the action. */}
      {task.status === 'in_review' ? (
        <button
          type="button"
          aria-label="标记完成"
          title="标记完成"
          onClick={() => onStatusChange('done')}
          className="absolute right-2 top-2 flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-border-subtle bg-white text-transparent shadow-sm transition-all hover:border-success hover:text-success focus-visible:border-success focus-visible:text-success focus-visible:outline-none"
        >
          <Check className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** Small inline status badge — non-interactive, color-coded by status. */
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
      className={cn(
        'rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  );
}
