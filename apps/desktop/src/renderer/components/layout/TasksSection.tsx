import { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  CheckSquare,
  Circle,
  CircleDashed,
  CircleEllipsis,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useWorkspaces } from '@/features/workspaces/hooks';
import { useTasks, useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useRelativeTime } from '@/components/chat/useRelativeTime';

/**
 * NavRail "Tasks" section — global aggregate view across every channel
 * and conversation, rendered as a four-column kanban (Todo / In progress /
 * In review / Done) so the layout matches the channel-scoped dialog
 * surfaced from the titlebar.
 *
 * Channel filter sits in a chip strip below the header (parallel to
 * the conversation strip in `ChannelTasksDialog`) — no separate sidebar,
 * which gives the kanban the full window width.
 *
 * Click a card → onJump scrolls back into chat at the source message
 * (App.tsx wires this through handleJumpToMessage).
 */
export interface TasksSectionProps {
  onJump: (params: {
    workspaceId?: string;
    channelId: string;
    threadId?: string | null;
    messageId: string;
  }) => void;
}

export function TasksSection({ onJump }: TasksSectionProps): JSX.Element {
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  const updateStatus = useUpdateTaskStatus();
  const { data: workspaces = [] } = useWorkspaces();
  const taskWorkspaceScopeIds = useMemo(
    () => [...new Set(workspaces.flatMap(workspace => workspace.workspace_scope_ids))],
    [workspaces],
  );
  const filteredWorkspaceScopeIds = useMemo(
    () => workspaces.find(workspace => workspace.id === channelFilter)?.workspace_scope_ids ?? [],
    [channelFilter, workspaces],
  );

  const { data: tasks = [] } = useTasks({
    workspace_id: channelFilter ?? undefined,
  }, {
    workspaceScopeIds: channelFilter
      ? filteredWorkspaceScopeIds
      : taskWorkspaceScopeIds,
  });

  // Per-channel active counts drive both the chip badges and the
  // sort order — channels with active work float to the front so
  // the chips that matter are visible without scanning.
  const allTasksForCounts = useTasks(
    {},
    { workspaceScopeIds: taskWorkspaceScopeIds },
  ).data ?? [];
  const channelActiveCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of allTasksForCounts) {
      if (t.status !== 'done') {
        m.set(t.workspace_id, (m.get(t.workspace_id) ?? 0) + 1);
      }
    }
    return m;
  }, [allTasksForCounts]);
  const totalActive = allTasksForCounts.filter(
    t => t.status !== 'done',
  ).length;

  const orderedChannels = useMemo(() => {
    const sortByActivity = (
      a: { id: string; name: string },
      b: { id: string; name: string },
    ): number => {
      const ac = channelActiveCounts.get(a.id) ?? 0;
      const bc = channelActiveCounts.get(b.id) ?? 0;
      if (ac !== bc) return bc - ac;
      return a.name.localeCompare(b.name);
    };
    const regular = workspaces.filter(w => w.kind !== 'dm').map(w => ({ id: w.id, name: w.name, kind: 'regular' as const })).sort(sortByActivity);
    const dm = workspaces.filter(w => w.kind === 'dm').map(w => ({ id: w.id, name: w.name, kind: 'dm' as const })).sort(sortByActivity);
    return { regular, dm };
  }, [workspaces, channelActiveCounts]);

  const grouped = useMemo(() => groupByStatus(tasks), [tasks]);

  return (
    <main
      className="flex h-full flex-1 flex-col bg-bg-base"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <CheckSquare className="size-4 text-text-muted" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          {channelFilter
            ? `Tasks in #${workspaces.find(w => w.id === channelFilter)?.name ?? '…'}`
            : 'All Tasks'}
        </span>
        <span className="text-xs text-text-muted">· {tasks.length}</span>
        <span className="ml-auto text-[10px] text-text-muted">
          {totalActive} active
        </span>
      </header>

      <ChannelStrip
        value={channelFilter}
        regular={orderedChannels.regular}
        dm={orderedChannels.dm}
        counts={channelActiveCounts}
        onChange={setChannelFilter}
      />

      {/* Switched from grid to flex so columns size to their content
        * (height = content) while staying capped at the available height
        * via `max-h-full`. `items-start` keeps short columns hugging the
        * top instead of stretching to the tallest column. */}
      <div
        data-tasks-board
        className="flex min-h-0 flex-1 items-start gap-3 overflow-hidden p-4"
      >
        {COLUMNS.map(col => (
          <KanbanColumn
            key={col.status}
            title={col.label}
            status={col.status}
            icon={col.icon}
            iconClass={col.iconClass}
            tasks={grouped[col.status]}
            onCardClick={t =>
              onJump({
                workspaceId: t.workspace_id,
                channelId: t.channel_id,
                threadId: t.thread_id,
                messageId: t.message_id,
              })
            }
            onStatusChange={(messageId, next) =>
              updateStatus.mutate({ messageId, status: next })
            }
          />
        ))}
      </div>
    </main>
  );
}

// ── helpers ────────────────────────────────────────────────────────

interface ColumnSpec {
  status: TaskStatus;
  label: string;
  icon: LucideIcon;
  /** Color token for the icon — mirrors TaskStatusBadge so the column
   *  header and the inline badge read as the same vocabulary. */
  iconClass: string;
}

const COLUMNS: ReadonlyArray<ColumnSpec> = [
  { status: 'todo', label: 'Todo', icon: Circle, iconClass: 'text-text-muted' },
  {
    status: 'in_progress',
    label: 'In progress',
    icon: CircleDashed,
    iconClass: 'text-accent',
  },
  {
    status: 'in_review',
    label: 'In review',
    icon: CircleEllipsis,
    iconClass: 'text-warning',
  },
  {
    status: 'done',
    label: 'Done',
    icon: CheckCircle2,
    iconClass: 'text-success',
  },
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

function prefixForKind(kind: 'regular' | 'dm', name: string): string {
  return kind === 'dm' ? `@${name.replace(/^dm-/, '')}` : `#${name}`;
}

// ── Channel strip ──────────────────────────────────────────────────

const REGULAR_CHANNEL_LIMIT = 10;

function ChannelStrip({
  value,
  regular,
  dm,
  counts,
  onChange,
}: {
  value: string | null;
  regular: Array<{ id: string; name: string; kind: 'regular' | 'dm' }>;
  dm: Array<{ id: string; name: string; kind: 'regular' | 'dm' }>;
  counts: Map<string, number>;
  onChange: (id: string | null) => void;
}): JSX.Element {
  // Cap regular channels at 10, but keep the active filter visible
  // even if it would otherwise be sliced off (e.g. picked from a
  // bookmark or another surface). DMs aren't capped — they're already
  // grouped semantically (one per agent) and kept compact.
  const visibleRegular = (() => {
    const top = regular.slice(0, REGULAR_CHANNEL_LIMIT);
    if (value && !top.some(c => c.id === value)) {
      const sel = regular.find(c => c.id === value);
      if (sel) top.push(sel);
    }
    return top;
  })();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle px-4 py-2">
      <Chip selected={value === null} onClick={() => onChange(null)}>
        All
      </Chip>
      {visibleRegular.map(c => (
        <ChannelChip
          key={c.id}
          channel={c}
          active={counts.get(c.id) ?? 0}
          selected={value === c.id}
          onClick={() => onChange(c.id)}
        />
      ))}
      {dm.length > 0 ? (
        <span
          aria-hidden
          className="mx-1 h-4 w-px shrink-0 bg-border-subtle"
        />
      ) : null}
      {dm.map(c => (
        <ChannelChip
          key={c.id}
          channel={c}
          active={counts.get(c.id) ?? 0}
          selected={value === c.id}
          onClick={() => onChange(c.id)}
        />
      ))}
    </div>
  );
}

function ChannelChip({
  channel,
  active,
  selected,
  onClick,
}: {
  channel: { id: string; name: string; kind: 'regular' | 'dm' };
  active: number;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  const label = prefixForKind(channel.kind, channel.name);
  return (
    <Chip
      selected={selected}
      dim={active === 0}
      onClick={onClick}
      title={label}
    >
      <span>{label}</span>
      {active > 0 ? (
        <span className="ml-1 text-[10px] tabular-nums opacity-70">
          {active}
        </span>
      ) : null}
    </Chip>
  );
}

function Chip({
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
        'flex max-w-[200px] items-center truncate rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
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
  icon: Icon,
  iconClass,
  tasks,
  onCardClick,
  onStatusChange,
}: {
  title: string;
  status: TaskStatus;
  icon: LucideIcon;
  iconClass: string;
  tasks: TaskSummaryDto[];
  onCardClick: (t: TaskSummaryDto) => void;
  onStatusChange: (messageId: string, next: TaskStatus) => void;
}): JSX.Element {
  return (
    <section
      data-tasks-column
      data-status={status}
      className={cn(
        // Each column hugs its own content height (cross-axis auto via
        // `items-start` on the row), but caps at the parent height with
        // `max-h-full`. When content overflows that cap, the body
        // (`flex-auto + overflow-y-auto`) handles scrolling so the page
        // itself never scrolls.
        'flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-primary',
        status === 'done' && 'opacity-80',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Icon className={cn('size-3.5 shrink-0', iconClass)} aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-text-muted">
          {tasks.length}
        </span>
      </header>
      <div className="min-h-0 flex-auto overflow-y-auto p-2">
        {tasks.length === 0 ? (
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
  const { relative, absolute } = useRelativeTime(task.created_at);
  return (
    <div
      data-task-number={task.task_number}
      className="group relative rounded-md border border-border-subtle bg-bg-base transition-colors hover:border-accent hover:bg-bg-hover"
    >
      {/* Jump button: covers the content area */}
      <button
        type="button"
        onClick={onClick}
        className="block w-full p-2 pr-7 text-left"
      >
        {/* Row 1: #number + status badge inline */}
        <div className="flex items-center gap-1.5 pb-0.5">
          <span data-tasks-num className="shrink-0 font-mono text-[10px] text-text-muted">
            #{task.task_number}
          </span>
          <TaskStatusBadge status={task.status} />
        </div>
        {/* Row 2: title */}
        <span className="block min-w-0 break-words text-xs text-text-primary">
          {task.title}
        </span>
        {/* Row 3: assignee · in conversation · created (inline meta,
            mirrors the popover layout — see TaskRef.TaskPopoverBody).
            Single-line layout: only the conversation name shrinks /
            ellipsizes when the row overflows, keeping assignee & time
            anchored. Wrapping was tried but broke the card grid's
            vertical rhythm (@shiki feedback `idpLhTxbhKQDy--j`). */}
        <div className="mt-1 flex items-baseline gap-1.5 text-[10px] text-text-muted">
          <span className="shrink-0 text-text-secondary">
            {task.assignee ? `@${task.assignee.name}` : (
              <span className="italic">unassigned</span>
            )}
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
        </div>
      </button>

      {/* Check button — top-right corner, only for in_review.
          Ring-only by default; turns green on hover. */}
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
      data-task-status={status}
      className={cn(
        'rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide',
        styles[status],
      )}
    >
      {labels[status]}
    </span>
  );
}
