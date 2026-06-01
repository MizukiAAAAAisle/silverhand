import { useMemo, useState } from 'react';
import {
  Archive,
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
import {
  applyTaskFilters,
  collectAssignees,
  collectCreators,
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
} from '@/features/tasks/taskFilters';
import { useRelativeTime } from '@/components/chat/useRelativeTime';
import { TaskStatusBadge, TaskCardContextMenu } from '@/components/tasks/TaskStatusBadge';
import { TaskFilterBar, type ChannelOption } from '@/components/tasks/TaskFilterBar';

/**
 * NavRail "Tasks" section — global aggregate view across every channel
 * and conversation, rendered as a five-column kanban (Todo / In progress /
 * In review / Done / Closed) so the layout matches the channel-scoped
 * dialog surfaced from the titlebar. `closed` is a terminal status, not a
 * separate visibility axis (shiki + Cindy cutover).
 *
 * Channel/assignee/creator filtering sits in the TaskFilterBar below the
 * header — no separate sidebar, which gives the kanban the full width.
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
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const updateStatus = useUpdateTaskStatus();
  const { data: workspaces = [] } = useWorkspaces();
  const taskWorkspaceScopeIds = useMemo(
    () => [...new Set(workspaces.flatMap(workspace => workspace.workspace_scope_ids))],
    [workspaces],
  );

  // Fetch broadly across every workspace scope (all statuses, incl.
  // closed — it's just the 5th column). Channel / assignee / creator are
  // sliced client-side (no pagination, dto carries the fields) — see
  // features/tasks/taskFilters.ts.
  const { data: allTasks = [] } = useTasks(
    {},
    { workspaceScopeIds: taskWorkspaceScopeIds },
  );

  const tasks = useMemo(
    () =>
      applyTaskFilters(
        allTasks,
        filters,
        // Global surface: "channel" === workspace (Cindy boundary —
        // global scope is workspace-level, not conversation-level).
        (task, workspaceId) => task.workspace_id === workspaceId,
      ),
    [allTasks, filters],
  );

  // Active counts (not done, not closed) drive channel ordering + tally.
  const channelActiveCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of allTasks) {
      if (t.status !== 'done' && t.status !== 'closed') {
        m.set(t.workspace_id, (m.get(t.workspace_id) ?? 0) + 1);
      }
    }
    return m;
  }, [allTasks]);
  const totalActive = useMemo(
    () => tasks.filter(t => t.status !== 'done' && t.status !== 'closed').length,
    [tasks],
  );

  const channelOptions = useMemo<ChannelOption[]>(() => {
    const sortByActivity = (
      a: { id: string; name: string },
      b: { id: string; name: string },
    ): number => {
      const ac = channelActiveCounts.get(a.id) ?? 0;
      const bc = channelActiveCounts.get(b.id) ?? 0;
      if (ac !== bc) return bc - ac;
      return a.name.localeCompare(b.name);
    };
    const regular = workspaces
      .filter(w => w.kind !== 'dm')
      .sort(sortByActivity)
      .map(w => ({ id: w.id, label: w.name, kind: 'channel' as const }));
    const dm = workspaces
      .filter(w => w.kind === 'dm')
      .sort(sortByActivity)
      .map(w => ({ id: w.id, label: w.name.replace(/^dm-/, ''), kind: 'dm' as const }));
    return [...regular, ...dm];
  }, [workspaces, channelActiveCounts]);

  const assigneeOptions = useMemo(() => collectAssignees(allTasks), [allTasks]);
  const creatorOptions = useMemo(() => collectCreators(allTasks), [allTasks]);
  // Gate the assignee "No assignee" option: only meaningful when the set
  // actually has unclaimed tasks (shiki feedback — else it reads as a
  // stray pseudo-person).
  const hasUnassigned = useMemo(() => allTasks.some(t => !t.assignee), [allTasks]);

  const grouped = useMemo(() => groupByStatus(tasks), [tasks]);

  const selectedChannelName = filters.channelId
    ? workspaces.find(w => w.id === filters.channelId)?.name
    : null;

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
          {selectedChannelName ? `Tasks in #${selectedChannelName}` : 'All Tasks'}
        </span>
        <span className="text-xs text-text-muted">· {tasks.length}</span>
        <span className="ml-auto text-[10px] text-text-muted">
          {totalActive} active
        </span>
      </header>

      <div className="shrink-0 border-b border-border-subtle px-4 py-2">
        <TaskFilterBar
          filters={filters}
          onChange={setFilters}
          baselineFilters={DEFAULT_TASK_FILTERS}
          channelOptions={channelOptions}
          allChannelsLabel="All channels"
          assigneeOptions={assigneeOptions}
          creatorOptions={creatorOptions}
          hasUnassigned={hasUnassigned}
        />
      </div>

      {/* Five-column kanban. Flex (not grid) so columns size to content
        * height while capped at `max-h-full`; `items-start` keeps short
        * columns hugging the top. Closed is the terminal 5th column. */}
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
  {
    status: 'closed',
    label: 'Closed',
    icon: Archive,
    iconClass: 'text-text-muted',
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
    closed: [],
  };
  for (const t of tasks) out[t.status].push(t);
  return out;
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
        // Done + Closed are terminal — dim slightly so the live columns
        // read as the focus.
        (status === 'done' || status === 'closed') && 'opacity-80',
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
    <TaskCardContextMenu status={task.status} onStatusChange={onStatusChange}>
      <div
        data-task-number={task.task_number}
        className="group relative rounded-md border border-border-subtle bg-bg-base transition-colors hover:border-accent hover:bg-bg-hover"
      >
      {/* Stretched jump overlay — see WorkspaceTasksDrawer TaskCard for
          the stretched-link rationale (badge as independent control). */}
      <button
        type="button"
        onClick={onClick}
        aria-label="跳转到消息"
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <div className="pointer-events-none relative z-10 p-2 pr-7">
        {/* Row 1: #number + interactive status badge (reads "Closed" for
            a closed task — no separate chip). */}
        <div className="flex items-center gap-1.5 pb-0.5">
          <span data-tasks-num className="shrink-0 font-mono text-[10px] text-text-muted">
            #{task.task_number}
          </span>
          <span className="pointer-events-auto">
            <TaskStatusBadge status={task.status} onChange={onStatusChange} />
          </span>
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
      </div>

      {/* Check button — top-right corner, only for in_review. Quick
          one-click approve; arbitrary moves go through the badge picker.
          Ring-only by default; turns green on hover. */}
      {task.status === 'in_review' ? (
        <button
          type="button"
          aria-label="标记完成"
          title="标记完成"
          onClick={() => onStatusChange('done')}
          className="absolute right-2 top-2 z-10 flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-border-subtle bg-white text-transparent shadow-sm transition-all hover:border-success hover:text-success focus-visible:border-success focus-visible:text-success focus-visible:outline-none"
        >
          <Check className="size-3" />
        </button>
      ) : null}
      </div>
    </TaskCardContextMenu>
  );
}

/** Small inline status badge — moved to components/tasks/TaskStatusBadge
 *  (now shared + interactive). */
