import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Plus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useTasks, useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useKanbanColumnCollapse } from '@/features/tasks/useKanbanColumnCollapse';
import { useRevealTaskRow } from '@/features/tasks/useRevealTaskRow';
import { useTaskFilterOptions } from '@/features/tasks/useTaskFilterOptions';
import { columnVisibleCount } from '@/features/tasks/columnWindow';
import {
  useColumnEndSentinel,
  useColumnWindow,
} from '@/features/tasks/useColumnWindow';
import {
  applyTaskFilters,
  collectAssignees,
  collectCreators,
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
} from '@/features/tasks/taskFilters';
import { isTaskDrag, readTaskDrag, writeTaskDrag } from '@/features/tasks/taskDnd';
import { useRelativeTime } from '@/components/chat/useRelativeTime';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  TaskStatusBadge,
  TaskCardContextMenu,
  TASK_STATUS_ICON,
} from '@/components/tasks/TaskStatusBadge';
import { TaskDropPlaceholder } from '@/components/tasks/TaskDropPlaceholder';
import {
  TaskFilterBar,
  FILTER_ROW_TRIGGER_BOX,
} from '@/components/tasks/TaskFilterBar';
import {
  CreateTaskDialog,
  useCreateTaskSubmit,
} from '@/components/tasks/CreateTaskDialog';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/features/common/PrimaryAction';

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
 * Click a card → `onOpenTask` opens that task's detail modal (App writes
 * `?task=<task_id>`); the modal itself carries "View in conversation", which is
 * what scrolls back into chat at the source message (#task:1715). The handler
 * arrives as a prop rather than from `useNav()` here on purpose: `useNav`
 * subscribes its caller to the location, which would re-render all ~1356 cards
 * on every section switch — exactly the urgent-pass freeze `React.memo` +
 * App's ref-stable handler exist to prevent (#task:1168).
 *
 * This board is also a reveal TARGET, not just a source: "View in Tasks" from the
 * modal lands here when `/tasks` is the route, and this section is already the
 * global All board (`useTasks({})` + `DEFAULT_TASK_FILTERS`), so the target card
 * is on screen with no navigation and no filter widening — only a scroll and a
 * pulse (#task:1715, Alice). Every reveal prop must stay ref-stable for the same
 * `React.memo` reason as `onOpenTask`.
 */
export interface TasksSectionProps {
  onOpenTask: (taskId: string) => void;
  /** Standing reveal intent, or `null`. */
  revealTaskId?: string | null;
  /** Called once when the intent reaches a terminal outcome. */
  onRevealConsumed?: () => void;
}

export const TasksSection = memo(function TasksSection({
  onOpenTask,
  revealTaskId = null,
  onRevealConsumed,
}: TasksSectionProps): JSX.Element {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
  const updateStatus = useUpdateTaskStatus();
  // Per-column render bound, local to THIS surface (#task:1885): the drawer
  // shares the query cache but not the window, so its scrolling never inflates
  // this board's mount cost. Every write that changes what the columns hold goes
  // through `applyFilters` below, which resets the window in the same commit.
  const {
    columnWindow,
    grow: growColumn,
    reset: resetColumnWindow,
    coverIndex: coverColumnIndex,
  } = useColumnWindow();
  const applyFilters = useCallback(
    (next: TaskFilters) => {
      setFilters(next);
      resetColumnWindow();
    },
    [resetColumnWindow],
  );
  // Workspace + channel options + scope ids come from the SAME hook the
  // drawer uses (#task:1165) so the two surfaces' dropdowns can't drift — DM +
  // regular workspace channels, grouped by data source; regular workspaces for
  // the upstream cascade axis (#task:1387).
  const { workspaceOptions, channelOptions } = useTaskFilterOptions();

  // Fetch broadly across every workspace scope (all statuses, incl.
  // closed — it's just the 5th column). Channel / assignee / creator are
  // sliced client-side (no pagination, dto carries the fields) — see
  // features/tasks/taskFilters.ts. Live refresh rides the viewer scope
  // (see `useTasks`).
  const {
    data: allTasks = [],
    isFetching,
    dataUpdatedAt,
    errorUpdateCount,
    refetch,
  } = useTasks({});

  const tasks = useMemo(
    () =>
      applyTaskFilters(
        allTasks,
        filters,
        // Channel-scoped filtering: every task (main-line or reply-cluster)
        // resolves to a real channel through `channel_id`.
        (task, channelId) => task.channel_id === channelId,
      ),
    [allTasks, filters],
  );

  const grouped = useMemo(() => groupByStatus(tasks), [tasks]);

  // ── Reveal: this board is a delivery TARGET, not only a source ──────
  //
  // "This board's baseline is All" is NOT "this board's view is always All": the
  // user filters it, and the reveal's own path produces the case — filter by
  // Assignee, open a card, reassign it inside the modal, then "View in Tasks".
  // The task leaves the current filter, so the row is gone from the DOM while
  // `allTasks` still holds it (Cindy BLOCKER 10). So the target is judged on the
  // RENDERED list, and widening is this surface's own obligation, handed to the
  // shared hook as a required argument.
  //
  // With a bounded column window there is a SECOND way to hold a task and render
  // no row for it: the row sits past the window. Widening therefore resets the
  // filters AND covers the target's index — one commit, so the next pass of the
  // reveal machine reads a set that already contains the row if this surface can
  // show it at all. The index is taken from the post-reset population
  // (`allTasks`, which is what DEFAULT filters yield), never from the currently
  // filtered list the reset is about to replace.
  const ensureRevealRenderable = useCallback(() => {
    applyFilters(DEFAULT_TASK_FILTERS);
    if (revealTaskId === null) return;
    const found = allTasks.find(t => t.id === revealTaskId);
    if (!found) return;
    coverColumnIndex(
      found.status,
      allTasks.filter(t => t.status === found.status).indexOf(found),
    );
  }, [allTasks, applyFilters, coverColumnIndex, revealTaskId]);
  const revealTarget = useMemo(() => {
    if (revealTaskId === null) return null;
    const found = tasks.find(t => t.id === revealTaskId);
    if (!found) return null;
    // Rendered, not merely held: a row past this column's window has no
    // `[data-task-id]` to scroll to.
    const index = grouped[found.status].indexOf(found);
    return index < columnVisibleCount(columnWindow, found.status)
      ? { status: found.status }
      : null;
  }, [columnWindow, grouped, revealTaskId, tasks]);
  const boardRef = useRef<HTMLDivElement>(null);
  const { highlightedTaskId } = useRevealTaskRow({
    revealTaskId,
    active: true,
    rootRef: boardRef,
    target: revealTarget,
    ensureRenderable: ensureRevealRenderable,
    isFetching,
    dataUpdatedAt,
    errorUpdateCount,
    refetch,
    onConsumed: onRevealConsumed,
  });

  const totalActive = useMemo(
    () => tasks.filter(t => t.status !== 'done' && t.status !== 'closed').length,
    [tasks],
  );

  const assigneeOptions = useMemo(() => collectAssignees(allTasks), [allTasks]);
  const creatorOptions = useMemo(() => collectCreators(allTasks), [allTasks]);
  // Gate the assignee "No assignee" option: only meaningful when the set
  // actually has unclaimed tasks (shiki feedback — else it reads as a
  // stray pseudo-person).
  const hasUnassigned = useMemo(() => allTasks.some(t => !t.assignee), [allTasks]);

  const selectedChannelName = filters.channelId
    ? channelOptions.find(o => o.id === filters.channelId)?.label
    : null;

  // A task must name a channel; seed the create picker from the current channel
  // FILTER only when it resolves to a real member-channel option (a thread-scoped
  // or ALL filter has no channel to pre-select — the actor picks one). On success
  // the dialog closes and the list refreshes in place; the new task is NOT opened
  // in a detail modal (shiki 2026-07-30).
  const createDefaultChannelId = channelOptions.some(
    o => o.id === filters.channelId,
  )
    ? filters.channelId
    : null;
  const submitCreate = useCreateTaskSubmit();

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

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
        <TaskFilterBar
          filters={filters}
          onChange={applyFilters}
          baselineFilters={DEFAULT_TASK_FILTERS}
          workspaceOptions={workspaceOptions}
          channelOptions={channelOptions}
          allChannelsLabel="ALL"
          assigneeOptions={assigneeOptions}
          creatorOptions={creatorOptions}
          hasUnassigned={hasUnassigned}
        />
        {/* Create entrance sits right AFTER the filter (shiki): the toolbar's one
          * primary action, so it earns the filled + poster treatment among the
          * muted filter chips. `FILTER_ROW_TRIGGER_BOX` matches its height to the
          * neighbouring filter chips in every theme (shiki). */}
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          {...primaryAction(`shrink-0 gap-1.5 ${FILTER_ROW_TRIGGER_BOX}`)}
        >
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>

      {/* Five-column kanban. Flex (not grid) so columns size to content
        * height while capped at `max-h-full`; `items-start` keeps short
        * columns hugging the top. Closed is the terminal 5th column. */}
      <div
        ref={boardRef}
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
            visibleCount={columnVisibleCount(columnWindow, col.status)}
            onReachEnd={() => growColumn(col.status)}
            highlightedTaskId={highlightedTaskId}
            onCardClick={t => onOpenTask(t.id)}
            onStatusChange={(taskId, next) =>
              updateStatus.mutate({ taskId, status: next })
            }
          />
        ))}
      </div>

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channelOptions={channelOptions}
        defaultChannelId={createDefaultChannelId}
        onSubmit={submitCreate}
      />
    </main>
  );
});

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
    icon: TASK_STATUS_ICON.todo,
    iconClass: 'text-[color:var(--task-status-todo-solid)]',
  },
  {
    status: 'in_progress',
    label: 'In progress',
    icon: TASK_STATUS_ICON.in_progress,
    iconClass: 'text-[color:var(--task-status-in-progress-solid)]',
  },
  {
    status: 'in_review',
    label: 'In review',
    icon: TASK_STATUS_ICON.in_review,
    iconClass: 'text-[color:var(--task-status-in-review-solid)]',
  },
  {
    status: 'done',
    label: 'Done',
    icon: TASK_STATUS_ICON.done,
    iconClass: 'text-[color:var(--task-status-done-solid)]',
  },
  {
    status: 'closed',
    label: 'Closed',
    icon: TASK_STATUS_ICON.closed,
    iconClass: 'text-[color:var(--task-status-closed-solid)]',
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
  visibleCount,
  onReachEnd,
  highlightedTaskId,
  onCardClick,
  onStatusChange,
}: {
  title: string;
  status: TaskStatus;
  icon: LucideIcon;
  iconClass: string;
  /** The column's WHOLE list — the header count is the column's total, not the
   *  rendered slice. */
  tasks: TaskSummaryDto[];
  /** Render bound for this surface (#task:1885). */
  visibleCount: number;
  onReachEnd: () => void;
  highlightedTaskId: string | null;
  onCardClick: (t: TaskSummaryDto) => void;
  onStatusChange: (taskId: string, next: TaskStatus) => void;
}): JSX.Element {
  // Drag-over affordance (#task:779). Any task drag entering the column
  // arms it (accent edge + soft wash) and shows a "Drop here" slot. The
  // source column is not special-cased — its drop is a no-op (shiki: no
  // special handling needed), so it still highlights normally.
  const [dragOver, setDragOver] = useState(false);
  // Per-column collapse (#task:1169). Collapsed → render only the header bar
  // (a compact horizontal strip) and skip the card list, so all five columns
  // stay visible but a heavy terminal column (Closed, default-collapsed)
  // neither claims width nor pays its render cost. Still a drop target.
  const { isCollapsed, toggle } = useKanbanColumnCollapse();
  const collapsed = isCollapsed(status);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  // Bounded window: render a prefix, grow it when its tail comes into view.
  // A collapsed column renders no body, so it also arms no observer.
  const visible = visibleCount < tasks.length ? tasks.slice(0, visibleCount) : tasks;
  const hasMore = !collapsed && visible.length < tasks.length;
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  useColumnEndSentinel({
    rootRef: bodyRef,
    sentinelRef,
    hasMore,
    renderedCount: visible.length,
    onReachEnd,
  });
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
        onStatusChange(payload.taskId, status);
      }}
      className={cn(
        // Each column hugs its own content height (cross-axis auto via
        // `items-start` on the row), but caps at the parent height with
        // `max-h-full`. When content overflows that cap, the body
        // (`flex-auto + overflow-y-auto`) handles scrolling so the page
        // itself never scrolls.
        //
        // All five columns keep an EQUAL flex width whether collapsed or not
        // (#task:1169 follow-up, shiki): collapsing only drops the body, it
        // never changes a column's width, so the live columns don't jitter
        // when Closed folds/unfolds. Reclaiming a collapsed column's width
        // would force the other four to reflow — read as layout shake. (A
        // fixed px width would also stop the jitter but force horizontal
        // scroll in the narrow drawer, where 5 columns can't fit at a usable
        // fixed width — so equal-flex is the surface-agnostic choice.)
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
      <button
        type="button"
        data-tasks-column-header
        onClick={() => toggle(status)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} column`}
        className="flex w-full shrink-0 cursor-pointer items-center gap-2 border-b border-border-subtle px-3 py-2 text-left transition-colors hover:bg-bg-hover"
      >
        <Chevron className="size-3.5 shrink-0 text-text-muted" aria-hidden />
        <Icon data-tasks-column-icon className={cn('size-3.5 shrink-0', iconClass)} aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
          {title}
        </span>
        <span className="text-[10px] tabular-nums text-text-muted">
          {tasks.length}
        </span>
      </button>
      {collapsed ? null : (
        <div ref={bodyRef} className="min-h-0 flex-auto overflow-y-auto p-2">
          {tasks.length === 0 && !dragOver ? (
            <p className="px-2 py-3 text-center text-[11px] italic text-text-muted">
              No {title.toLowerCase()} tasks
            </p>
          ) : (
            <ul className="space-y-1.5">
              {dragOver ? <TaskDropPlaceholder /> : null}
              {visible.map(t => (
                <li key={t.id}>
                  <TaskCard
                    task={t}
                    highlighted={highlightedTaskId === t.id}
                    onClick={() => onCardClick(t)}
                    onStatusChange={next => onStatusChange(t.id, next)}
                  />
                </li>
              ))}
              {/* Tail sentinel — grows the window as it comes into view. It has
                  no visual of its own: growth is a local slice of an already
                  loaded page, so a spinner here would announce work that isn't
                  happening. */}
              {hasMore ? <li ref={sentinelRef} aria-hidden className="h-px" /> : null}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ── Card ───────────────────────────────────────────────────────────

function TaskCard({
  task,
  highlighted,
  onClick,
  onStatusChange,
}: {
  task: TaskSummaryDto;
  highlighted: boolean;
  onClick: () => void;
  onStatusChange: (next: TaskStatus) => void;
}): JSX.Element {
  const { relative, absolute } = useRelativeTime(task.created_at);
  const [dragging, setDragging] = useState(false);
  return (
    <TaskCardContextMenu status={task.status} onStatusChange={onStatusChange}>
      <div
        data-task-number={task.task_number}
        data-task-id={task.id}
        draggable
        onDragStart={e => {
          writeTaskDrag(e.dataTransfer, { taskId: task.id, from: task.status });
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        className={cn(
          'group relative min-w-0 cursor-grab rounded-md border border-border-subtle bg-bg-base transition-all hover:border-accent hover:bg-bg-hover active:cursor-grabbing',
          // Brief ring pulse when this card is a reveal target — same recipe as
          // the drawer's card so one reveal reads identically on both boards.
          highlighted && 'ring-2 ring-accent ring-offset-1 ring-offset-bg-base',
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
        aria-label="Open task detail"
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <div className="pointer-events-none relative z-10 min-w-0 p-2">
        {/* Row 1: #number + interactive status badge (reads "Closed" for
            a closed task — no separate chip). v6.5m: 2-row layout
            restored after v6.5l single-row attempt compressed title
            space (shiki feedback). Mirrors WorkspaceTasksDrawer.tsx.
            `flex-wrap` (#task:918): in narrow column widths the chip
            ("in progress" / "in review") drops to its own line beneath
            `#nnn` instead of overflowing the card edge. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pb-0.5 leading-none">
          <span data-tasks-num className="shrink-0 font-mono text-[10px] text-text-muted">
            #{task.task_number}
          </span>
          <TaskStatusBadge
            status={task.status}
            onChange={onStatusChange}
            className="ml-auto pointer-events-auto"
          />
        </div>
        {/* Row 2: title — `[overflow-wrap:anywhere]` so long URLs / hashes
            without spaces still break inside narrow cards (#task:918). */}
        <span className="block min-w-0 text-xs text-text-primary [overflow-wrap:anywhere]">
          {task.title}
        </span>
        {/* Row 3: assignee · channel · created — inline meta, single line.
            Separators are icons, not `·` glyphs (shiki 2026-07-21): the
            channel gets a `#` (dropping the "in " prose) and the timestamp a
            clock, so the row self-delimits by identity glyph + gap instead of
            middots. NO `flex-wrap` here (unlike Row 1): with wrap, flex would
            drop the `ml-auto` time onto its own line the moment the channel
            title got long, growing the card height (shiki 2026-07-23 "底部有时
            候会导致换行"). Single line instead → the conversation span is the
            only shrink target (`min-w-0 truncate`), so a long channel title
            ellipsizes (full name on hover via `title`) while assignee + time
            stay pinned. 稳定 > 自适应. */}
        <div className="mt-1 flex items-center gap-x-2 text-[10px] text-text-muted">
          <span className="shrink-0 text-text-secondary">
            {task.assignee ? task.assignee.name : (
              <span className="italic">unassigned</span>
            )}
          </span>
          <span
            className="inline-flex min-w-0 items-center gap-0.5 text-text-secondary"
            title={task.conversation.title}
          >
            <ChannelIcon variant="sticker" density="sm" className="text-text-muted" />
            <span className="min-w-0 truncate">{task.conversation.title}</span>
          </span>
          {/* Time pinned to the row's right edge (`ml-auto`), single line. */}
          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5" title={absolute}>
            <Clock className="size-3 shrink-0" />
            {relative}
          </span>
        </div>
      </div>
      </div>
    </TaskCardContextMenu>
  );
}

/** Small inline status badge — moved to components/tasks/TaskStatusBadge
 *  (now shared + interactive). */
