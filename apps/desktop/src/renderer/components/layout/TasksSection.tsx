import { useMemo, useState } from 'react';
import {
  Archive,
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
import { isTaskDrag, readTaskDrag, writeTaskDrag } from '@/features/tasks/taskDnd';
import { useRelativeTime } from '@/components/chat/useRelativeTime';
import { TaskStatusBadge, TaskCardContextMenu } from '@/components/tasks/TaskStatusBadge';
import { TaskDropPlaceholder } from '@/components/tasks/TaskDropPlaceholder';
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
      {/* Header padding: `pl-[6px]` matches the forza6 tasks-hero
        * sticker's 6px vertical clearance (22+1+1=24px sticker in 36px
        * titlebar → (36-24)/2 = 6px top/bottom), so left ≈ vertical
        * = symmetric breathing room around the hero stamp. Other
        * themes show a plain 16px CheckSquare here; 6px left is tight
        * but not broken — the icon leads the header content tight to
        * the left edge by intent (shiki #task:917 v6.7.3, "在不同的
        * 地方用不同的外层样式来控制"). The drawer header keeps the
        * standard `px-4` because its own `py-3` already balances. */}
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle pl-[6px] pr-4">
        <CheckSquare data-tasks-hero className="size-4 text-text-muted" />
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
          allChannelsLabel="ALL"
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
  /** Color token for the icon — reads the SAME `--task-status-<status>-text`
   *  token the inline card chip uses (TaskStatusBadge.tsx via global.css
   *  `[data-task-status]` rule). Earlier we routed each status through a
   *  Tailwind utility (`text-warning` / `text-success` etc.) which decoupled
   *  the column header from the chip — slack-dark made the drift visible
   *  (header in_review = warning amber but chip in_review = success green).
   *  Routing both through one token guarantees they can never disagree.
   *  shiki review #task:912. */
  iconClass: string;
}

const COLUMNS: ReadonlyArray<ColumnSpec> = [
  {
    status: 'todo',
    label: 'Todo',
    icon: Circle,
    iconClass: 'text-[color:var(--task-status-todo-text)]',
  },
  {
    status: 'in_progress',
    label: 'In progress',
    icon: CircleDashed,
    iconClass: 'text-[color:var(--task-status-in-progress-text)]',
  },
  {
    status: 'in_review',
    label: 'In review',
    icon: CircleEllipsis,
    iconClass: 'text-[color:var(--task-status-in-review-text)]',
  },
  {
    status: 'done',
    label: 'Done',
    icon: CheckCircle2,
    iconClass: 'text-[color:var(--task-status-done-text)]',
  },
  {
    status: 'closed',
    label: 'Closed',
    icon: Archive,
    iconClass: 'text-[color:var(--task-status-closed-text)]',
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
  // Drag-over affordance (#task:779). Any task drag entering the column
  // arms it (accent edge + soft wash) and shows a "Drop here" slot. The
  // source column is not special-cased — its drop is a no-op (shiki: no
  // special handling needed), so it still highlights normally.
  const [dragOver, setDragOver] = useState(false);
  return (
    <section
      data-tasks-column
      data-status={status}
      data-drop-target={dragOver || undefined}
      onDragOver={e => {
        if (!isTaskDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={e => {
        // Ignore leave events bubbling from children — only clear when the
        // pointer actually exits the column box.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={e => {
        const payload = readTaskDrag(e.dataTransfer);
        setDragOver(false);
        if (!payload) return;
        e.preventDefault();
        // Drop onto the same status = no-op (Cindy review: no meaningless
        // mutation).
        if (payload.from === status) return;
        onStatusChange(payload.messageId, status);
      }}
      className={cn(
        // Each column hugs its own content height (cross-axis auto via
        // `items-start` on the row), but caps at the parent height with
        // `max-h-full`. When content overflows that cap, the body
        // (`flex-auto + overflow-y-auto`) handles scrolling so the page
        // itself never scrolls.
        'flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-primary transition-colors',
        // Done + Closed are terminal — dim slightly so the live columns
        // read as the focus.
        (status === 'done' || status === 'closed') && 'opacity-80',
        // Drop affordance (`data-drop-target`) is painted in CSS, not here:
        // forza6-components.css gives `[data-tasks-column]` a
        // high-specificity background/border that a Tailwind utility can't
        // beat, so the wash + edge live in global.css / forza6-components.css
        // keyed on the attribute (shiki #task:784, Cindy review).
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
        {tasks.length === 0 && !dragOver ? (
          <p className="px-2 py-3 text-center text-[11px] italic text-text-muted">
            No {title.toLowerCase()} tasks
          </p>
        ) : (
          <ul className="space-y-1.5">
            {dragOver ? <TaskDropPlaceholder /> : null}
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
  const [dragging, setDragging] = useState(false);
  return (
    <TaskCardContextMenu status={task.status} onStatusChange={onStatusChange}>
      <div
        data-task-number={task.task_number}
        draggable
        onDragStart={e => {
          writeTaskDrag(e.dataTransfer, { messageId: task.message_id, from: task.status });
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        className={cn(
          'group relative cursor-grab rounded-md border border-border-subtle bg-bg-base transition-colors hover:border-accent hover:bg-bg-hover active:cursor-grabbing',
          dragging && 'opacity-50',
        )}
      >
      {/* Stretched jump overlay — see WorkspaceTasksDrawer TaskCard for
          the stretched-link rationale (badge as independent control).
          `draggable=false` so a press-drag starting here initiates the
          card's drag (the draggable ancestor) instead of the button. */}
      <button
        type="button"
        draggable={false}
        onClick={onClick}
        aria-label="跳转到消息"
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <div className="pointer-events-none relative z-10 p-2">
        {/* Row 1: #number + interactive status badge (reads "Closed" for
            a closed task — no separate chip). v6.5m: 2-row layout
            restored after v6.5l single-row attempt compressed title
            space (shiki feedback). Mirrors WorkspaceTasksDrawer.tsx. */}
        <div className="flex items-center gap-1.5 pb-0.5 leading-none">
          <span data-tasks-num className="shrink-0 font-mono text-[10px] text-text-muted">
            #{task.task_number}
          </span>
          <TaskStatusBadge
            status={task.status}
            onChange={onStatusChange}
            className="pointer-events-auto"
          />
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
      </div>
    </TaskCardContextMenu>
  );
}

/** Small inline status badge — moved to components/tasks/TaskStatusBadge
 *  (now shared + interactive). */
