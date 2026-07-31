import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Plus,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useTasks, useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useKanbanColumnCollapse } from '@/features/tasks/useKanbanColumnCollapse';
import { useRevealTaskRow } from '@/features/tasks/useRevealTaskRow';
import { useTaskFilterOptions } from '@/features/tasks/useTaskFilterOptions';
import {
  applyTaskFilters,
  collectAssignees,
  collectCreators,
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
} from '@/features/tasks/taskFilters';
import { isTaskDrag, readTaskDrag, writeTaskDrag } from '@/features/tasks/taskDnd';
import { drawerShouldCloseOnEscape } from '@/features/tasks/taskDetail';
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
 * Workspace-wide tasks panel — a floating right-side drawer that overlays
 * the main layout without displacing it. Width is user-adjustable via a
 * drag handle on the left edge and persisted in localStorage.
 *
 * Content is a five-column status kanban (Todo / In progress / In review /
 * Done / Closed) with a unified TaskFilterBar (channel / assignee /
 * creator) and card → jump navigation.
 */
export interface WorkspaceTasksDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string | null;
  /** Initially-selected conversation for the filter. null → all conversations. */
  defaultConversationId: string | null;
  /** ONE-SHOT reveal intent: a task id to scroll to and flash. Held in App
   *  memory, never in the URL (#task:1715) — a 1.4s pulse is an effect that
   *  self-expires, not a location worth being addressable. The drawer widens both
   *  filters to All so the row is guaranteed to be in the tree (the target may
   *  live in another workspace/channel), scrolls it into view and highlights it.
   *  Set by the detail modal's "View in Tasks". */
  revealTaskId?: string | null;
  /** Consumes the reveal intent above. Called on EVERY terminal outcome —
   *  delivered, or unreachable (no such task in the list, no drawer node, no row
   *  in the DOM) — and never while still waiting for the list, so the intent can
   *  never latch on a task the drawer will not act on again. */
  onRevealConsumed?: () => void;
  /** Whether the app-level task detail modal is open on top of the drawer. Only
   *  Escape layering depends on it: Radix owns Escape while the modal is up, so
   *  the drawer's own document listener must defer. */
  detailOpen?: boolean;
  /** Opens a task's detail modal (writes `?task=<task_id>`). Card clicks go
   *  through App so ONE modal instance serves every surface. */
  onOpenTask?: (taskId: string) => void;
}

const STORAGE_KEY = 'silverhand.layout.tasks-drawer-width';
const MIN_WIDTH = 340;
// Cap the drawer at 80% of the viewport. The state always holds the
// user's preferred width (from drag or persisted storage); the visual
// cap is enforced by an inline `maxWidth: '80vw'` on the shell so a
// shrunk window doesn't get to mutate that preference, and `getMaxWidth`
// is only consulted while a drag is in flight.
const getMaxWidth = (): number =>
  Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.8));
// First-launch default — 50% of the viewport, clamped to the
// [MIN_WIDTH, getMaxWidth()] band. Overridden by any persisted user
// width.
const getDefaultWidth = (): number =>
  Math.max(
    MIN_WIDTH,
    Math.min(getMaxWidth(), Math.floor(window.innerWidth * 0.5)),
  );

// ── Drawer width hook ────────────────────────────────────────────────

function useDrawerWidth(shellRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const n = raw !== null ? Number(raw) : NaN;
      // Keep the persisted preference as-is; the CSS `maxWidth: '80vw'`
      // cap on the shell handles any over-cap value visually without
      // mutating the user's saved width. Same reason as the missing
      // resize listener below.
      if (Number.isFinite(n) && n >= MIN_WIDTH) return n;
    } catch {
      // private mode — fall through
    }
    // No persisted width — fall back to the 50%-viewport default. Both
    // sides of the band (MIN_WIDTH / getMaxWidth) are already enforced
    // inside getDefaultWidth.
    return getDefaultWidth();
  });

  const widthRef = useRef(width);
  const frameRef = useRef<number | null>(null);

  const persistWidth = useCallback((next: number): void => {
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // quota or private mode
    }
  }, []);

  useLayoutEffect(() => {
    widthRef.current = width;
    if (shellRef.current) shellRef.current.style.width = `${width}px`;
  }, [shellRef, width]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // No resize listener on purpose: when the viewport shrinks below the
  // user's preferred width we want to *visually* cap to 80vw (handled
  // by the inline `maxWidth: '80vw'` on the shell) without overwriting
  // the persisted preference. Re-clamping state here would make a
  // temporary shrink permanently downsize the user's saved width.

  const scheduleWidth = useCallback((next: number): void => {
    widthRef.current = next;
    const shell = shellRef.current;
    if (!shell) return;

    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      shell.style.width = `${widthRef.current}px`;
    });
  }, [shellRef]);

  const flushWidth = useCallback((): void => {
    const shell = shellRef.current;
    if (!shell) return;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    shell.style.width = `${widthRef.current}px`;
  }, [shellRef]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const originX = e.clientX;
      const originWidth = widthRef.current;

      const onMove = (ev: PointerEvent): void => {
        // Left-edge handle: drag left = wider (negate dx).
        const dx = ev.clientX - originX;
        const next = Math.max(
          MIN_WIDTH,
          Math.min(getMaxWidth(), originWidth - dx),
        );
        scheduleWidth(next);
      };
      const onUp = (): void => {
        flushWidth();
        const next = widthRef.current;
        setWidth(next);
        persistWidth(next);
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
    [flushWidth, persistWidth, scheduleWidth],
  );

  return { width, startResize };
}

// ── Main component ───────────────────────────────────────────────────

export function WorkspaceTasksDrawer({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  defaultConversationId,
  revealTaskId = null,
  onRevealConsumed,
  detailOpen = false,
  onOpenTask,
}: WorkspaceTasksDrawerProps): JSX.Element {
  const drawerShellRef = useRef<HTMLDivElement>(null);
  const { width: drawerWidth, startResize } = useDrawerWidth(drawerShellRef);

  // Unified filter model (channel / assignee / creator), shared with the
  // global Tasks board. `channelId` is a conversation id:
  //  - a channel id → matches that channel + all its threads;
  //  - a thread id  → matches only that thread.
  // Baseline (= reset/Clear target) is the drawer's entry context: the
  // current WORKSPACE + current CHANNEL. Both anchor on open — the drawer
  // opens from inside a workspace, so defaulting its workspace filter to
  // ALL surfaced unrelated workspaces' tasks (#task:1432). Both stay
  // switchable to any workspace/channel or All; Clear restores this
  // baseline rather than jumping to All.
  const baselineFilters = useMemo<TaskFilters>(
    () => ({
      ...DEFAULT_TASK_FILTERS,
      workspaceId,
      channelId: defaultConversationId,
    }),
    [workspaceId, defaultConversationId],
  );
  const [filters, setFilters] = useState<TaskFilters>(baselineFilters);
  // Baseline re-sync: the drawer's own entry context, re-applied on the OPEN
  // transition and whenever the baseline identity changes. It does NOT consult
  // the reveal intent — a filter state that depends on whether a transient
  // one-shot has been consumed yet reintroduces exactly the ordering bug the
  // two effects below are split to avoid (Cindy BLOCKER 2).
  useEffect(() => {
    if (!open) return;
    setFilters(baselineFilters);
  }, [open, baselineFilters]);

  // Make a reveal target renderable: the row may live in another
  // workspace/channel that the anchored baseline filters out, and a row that is
  // filtered out has no `[data-task-id]` to scroll to. Closed tasks are always in
  // the tree (a status column, not a hidden tier), so no visibility widening is
  // needed. Once widened the view stays widened and the user can re-select.
  //
  // Called by `useRevealTaskRow` once per intent, BEFORE it trusts the rendered
  // set — so this reacts to the intent's arrival and never to whether the intent
  // has been consumed yet (Cindy BLOCKER 2). It runs after the baseline effect
  // above in the same commit (effects run in declaration order), so on a reveal
  // that opens the drawer the widening is the last write.
  const ensureRevealRenderable = useCallback(() => {
    setFilters({ ...DEFAULT_TASK_FILTERS });
  }, []);

  const closeDrawer = useCallback(
    (event?: React.SyntheticEvent): void => {
      event?.preventDefault();
      event?.stopPropagation();
      onOpenChange(false);
    },
    [onOpenChange],
  );

  // Create-task dialog open state. Declared above the Escape effect because
  // that handler must defer to it: the dialog is a Radix modal that owns Escape
  // while up, so the drawer's document listener stands down for it exactly as it
  // does for the detail modal.
  const [createOpen, setCreateOpen] = useState(false);

  // Close on Escape — but defer to any modal layered on top (the detail modal
  // or the create dialog), which owns Escape while it is up (Radix closes it;
  // the drawer stays open). One Escape closes one layer, top-down.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        drawerShouldCloseOnEscape(detailOpen || createOpen)
      ) {
        closeDrawer();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, closeDrawer, detailOpen, createOpen]);

  // Workspace + channel options + scope ids come from the SAME hook the global
  // Tasks pane uses (#task:1165), so both surfaces' dropdowns list the
  // identical set and can't drift. The drawer is the same board, just
  // pre-focused on the current workspace + channel via the baseline above
  // (#task:1432); both filters stay switchable to All.
  const { workspaceOptions, channelOptions } = useTaskFilterOptions();

  // Fetch the cross-workspace list (all statuses, incl. closed — it's just
  // the 5th column). The drawer is now the global board with a default
  // channel focus, so it must fetch every workspace's tasks: selecting an
  // external channel from the unified dropdown would otherwise yield an
  // empty list. Channel / assignee / creator are sliced client-side via
  // applyTaskFilters (channel match spans a channel + its threads, which
  // the API's single `conversation_id` filter can't express — see #214).
  // Shares React Query cache with the pane's identical `useTasks({})` call;
  // live refresh rides the viewer scope (see `useTasks`).
  const {
    data: allTasks = [],
    isLoading,
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
        // Channel-scoped: main-line + reply-cluster tasks both resolve to a
        // real channel through `channel_id`.
        (task, conversationId) => task.channel_id === conversationId,
      ),
    [allTasks, filters],
  );
  const updateStatus = useUpdateTaskStatus();

  const assigneeOptions = useMemo(() => collectAssignees(allTasks), [allTasks]);
  const creatorOptions = useMemo(() => collectCreators(allTasks), [allTasks]);
  const hasUnassigned = useMemo(() => allTasks.some(t => !t.assignee), [allTasks]);

  const grouped = useMemo(() => groupByStatus(tasks), [tasks]);

  // A plain card click opens the detail modal (`?task=<id>`, hosted by App);
  // jumping to the conversation is the modal's own explicit action.
  const handleCardClick = (t: TaskSummaryDto): void => {
    onOpenTask?.(t.id);
  };

  // Create entrance. Seed the picker from the current channel FILTER only when
  // it resolves to a real member-channel option — the drawer opens focused on
  // its entry channel, so that is usually the default, but an ALL / thread
  // filter leaves it unseeded (the actor picks one). On success the dialog
  // closes and the list refreshes in place; the new task is NOT opened in a
  // detail modal (shiki 2026-07-30). (`createOpen` state lives above the Escape
  // effect, which must defer to the dialog.)
  const submitCreate = useCreateTaskSubmit();
  const createDefaultChannelId = channelOptions.some(
    o => o.id === filters.channelId,
  )
    ? filters.channelId
    : null;

  // Focus trap: keep focus inside drawer while open.
  const drawerRef = useRef<HTMLDivElement>(null);

  // Is the reveal target in the collection this drawer RENDERS? Judged on the
  // post-filter list on purpose: `allTasks` is the cross-workspace directory
  // behind the board, and a target it holds but the current filters exclude has
  // no row in the DOM — letting the directory answer this is how a reveal pulses
  // nothing and consumes itself (Cindy BLOCKER 10). The status comes along
  // because a collapsed column has to be opened before the row exists.
  const revealTarget = useMemo(() => {
    if (revealTaskId === null) return null;
    const found = tasks.find(t => t.id === revealTaskId);
    return found ? { status: found.status } : null;
  }, [tasks, revealTaskId]);

  // Scroll + pulse + one-shot consumption, shared with the `/tasks` board so the
  // "absence is only terminal with positive evidence" rule and the pulse's
  // re-arming exist once (see `useRevealTaskRow`).
  const { highlightedTaskId } = useRevealTaskRow({
    revealTaskId,
    active: open,
    rootRef: drawerRef,
    target: revealTarget,
    ensureRenderable: ensureRevealRenderable,
    isFetching,
    dataUpdatedAt,
    errorUpdateCount,
    refetch,
    onConsumed: onRevealConsumed,
  });

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
        ref={drawerShellRef}
        className={cn(
          'fixed inset-y-0 right-0 z-50',
          // Only opt out of the Electron drag region while the drawer is
          // open.  Keeping `no-drag` when closed would permanently disable
          // titlebar drag / double-click-zoom over this pixel area.
          open && 'no-drag',
          open ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        style={{ width: drawerWidth, maxWidth: '80vw' }}
      >
        {/* Inner panel — slides in/out; all visual chrome lives here */}
        <div
          ref={drawerRef}
          role="dialog"
          aria-label="Tasks"
          aria-modal="true"
          className={cn(
            'flex h-full flex-col',
            // bg-bg-primary matches the sibling TasksSection main shell
            // (`TasksSection.tsx` line 131) so the drawer reads as the
            // same surface vocabulary cross-theme. Was hardcoded
            // `bg-white` which baked light-theme paper into every theme
            // — slack-dark review #task:912.
            'border-l border-border bg-bg-primary shadow-2xl',
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

          {/* Header — title + count only; all narrowing lives in the
              filter bar below (no archived segment here). */}
          <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-3">
            <CheckSquare data-tasks-hero className="size-4 text-text-muted" />
            <span className="font-serif text-base font-semibold text-text-primary">
              Tasks
              {workspaceName ? (
                <span className="ml-2 text-sm font-normal text-text-muted">
                  · #{workspaceName}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onPointerDown={closeDrawer}
              onClick={closeDrawer}
              aria-label="Close tasks"
              data-sticker-close
              className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Unified filter bar — replaces the old conversation chip strip */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
            <TaskFilterBar
              filters={filters}
              onChange={setFilters}
              baselineFilters={baselineFilters}
              workspaceOptions={workspaceOptions}
              channelOptions={channelOptions}
              allChannelsLabel="ALL"
              assigneeOptions={assigneeOptions}
              creatorOptions={creatorOptions}
              hasUnassigned={hasUnassigned}
            />
            {/* Create entrance sits right AFTER the filter (shiki): the toolbar's
              * one primary action, so it earns the filled + poster treatment
              * among the muted filter chips. `FILTER_ROW_TRIGGER_BOX` matches its
              * height to the neighbouring filter chips in every theme (shiki). */}
            <Button
              type="button"
              onClick={() => setCreateOpen(true)}
              {...primaryAction(`shrink-0 gap-1.5 ${FILTER_ROW_TRIGGER_BOX}`)}
            >
              <Plus className="size-3.5" />
              New task
            </Button>
          </div>

          {/* Kanban board — flex row of five status columns. Each column
              hugs its own content height (items-start) but caps at
              `max-h-full`, so a sparse column doesn't claim 100% of the
              page. Closed is the terminal 5th column. */}
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
                isLoading={isLoading}
                onCardClick={handleCardClick}
                onStatusChange={(taskId, status) =>
                  updateStatus.mutate({ taskId, status })
                }
                highlightedTaskId={highlightedTaskId}
              />
            ))}
          </div>
        </div>
      </div>

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channelOptions={channelOptions}
        defaultChannelId={createDefaultChannelId}
        onSubmit={submitCreate}
      />
    </>
  );
}

interface ColumnSpec {
  status: TaskStatus;
  label: string;
  icon: LucideIcon;
  /** Color token for the icon — reads the SAME `--task-status-<status>-text`
   *  token the inline card chip uses (TaskStatusBadge.tsx via global.css
   *  `[data-task-status]` rule). Mirrored in TasksSection.tsx so kanban
   *  + drawer share one vocabulary. shiki review #task:912. */
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

// ── Kanban column ────────────────────────────────────────────────────

function KanbanColumn({
  title,
  status,
  icon: Icon,
  iconClass,
  tasks,
  isLoading,
  onCardClick,
  onStatusChange,
  highlightedTaskId,
}: {
  title: string;
  status: TaskStatus;
  icon: LucideIcon;
  iconClass: string;
  tasks: TaskSummaryDto[];
  isLoading: boolean;
  onCardClick: (t: TaskSummaryDto) => void;
  onStatusChange: (taskId: string, next: TaskStatus) => void;
  highlightedTaskId: string | null;
}): JSX.Element {
  // Drag-over highlight (#task:779) — mirrors TasksSection.
  const [dragOver, setDragOver] = useState(false);
  // Per-column collapse (#task:1169) — shared store with the NavRail pane, so
  // the two surfaces stay in sync within a session. Mirrors TasksSection.
  const { isCollapsed, toggle } = useKanbanColumnCollapse();
  const collapsed = isCollapsed(status);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
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
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={e => {
        const payload = readTaskDrag(e.dataTransfer);
        setDragOver(false);
        if (!payload) return;
        e.preventDefault();
        if (payload.from === status) return; // same-column drop = no-op
        onStatusChange(payload.taskId, status);
      }}
      className={cn(
        // Mirrors TasksSection — column hugs content height with a
        // `max-h-full` cap; body scrolls inside when content overflows.
        //
        // All five columns keep an EQUAL flex width whether collapsed or not
        // (#task:1169 follow-up, shiki): collapsing only drops the body, never
        // resizes a column, so the live columns don't jitter when Closed
        // folds/unfolds. Closed stays 1/5 width — shiki accepts that; the perf
        // win was never rendering its 1000+ cards, not reclaiming width.
        'flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-base transition-colors',
        (status === 'done' || status === 'closed') && 'opacity-80',
        // Drop affordance (`data-drop-target`) is painted in CSS, not here —
        // forza6's high-specificity `[data-tasks-column]` background/border
        // can't be beaten by a Tailwind utility (shiki #task:784, Cindy
        // review). See global.css / forza6-components.css.
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
        <div className="min-h-0 flex-auto overflow-y-auto p-2">
          {isLoading ? (
            <p className="px-2 py-3 text-center text-[11px] text-text-muted">
              Loading…
            </p>
          ) : tasks.length === 0 && !dragOver ? (
            <p className="px-2 py-3 text-center text-[11px] italic text-text-muted">
              No {title.toLowerCase()} tasks
            </p>
          ) : (
            <ul className="space-y-1.5">
              {dragOver ? <TaskDropPlaceholder /> : null}
              {tasks.map(t => (
                <li key={t.id}>
                  <TaskCard
                    task={t}
                    highlighted={highlightedTaskId === t.id}
                    onClick={() => onCardClick(t)}
                    onStatusChange={next => onStatusChange(t.id, next)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ── Task card ────────────────────────────────────────────────────────

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
          'group relative min-w-0 cursor-grab rounded-md border border-border-subtle bg-bg-primary transition-all hover:border-accent hover:bg-bg-hover active:cursor-grabbing',
          // Brief ring pulse when this card is the focused-task target.
          // Cleared by the drawer's setTimeout (~1.4s) so the highlight
          // doesn't linger on next open. `transition-all` lets the ring
          // fade in/out smoothly without a custom keyframe.
          highlighted && 'ring-2 ring-accent ring-offset-1 ring-offset-bg-base',
          dragging && 'opacity-50',
        )}
      >
      {/* Stretched jump overlay — covers the whole card so clicking
          anywhere (except the interactive controls layered above) jumps
          to the message. Lets the status badge live as an independently
          clickable control without a button-in-button. `draggable=false`
          so a press-drag here initiates the card's drag, not the button. */}
      <button
        type="button"
        draggable={false}
        onClick={onClick}
        aria-label="Open task detail"
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {/* Content layer. `pointer-events-none` so text clicks fall
          through to the jump overlay; only the status badge re-enables
          pointer events. `min-w-0` propagates the row's narrow-width
          shrink down to the title/meta rows below (#task:918). */}
      <div className="pointer-events-none relative z-10 min-w-0 p-2">
        {/* Row 1: #number + interactive status badge inline (reads
            "Closed" for a closed task — no separate chip). v6.5m
            (#task:917): reverted from the v6.5l single-row merge
            because pulling the title onto this row compressed the
            content space too much for long titles — shiki "这样也
            不好，会压缩卡片内容的空间，还是 #nnn 和 status 独占
            一行，下面是内容比较好". The 2-row layout is back; left-
            edge alignment between #nnn and title is handled by the
            `margin-left: -1px` nudge on `[data-tasks-num]` (forza6-
            components.css) that compensates Rajdhani's wider left
            side-bearing on `#`.
            `flex-wrap` (#task:918): in narrow drawer/column widths the
            chip ("in progress" / "in review") drops to its own line
            beneath `#nnn` instead of overflowing the card edge. */}
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
        {/* Row 2: title — `[overflow-wrap:anywhere]` (more aggressive
            than `break-words`) so a long URL or hash without spaces
            still breaks inside a narrow card instead of pushing the
            card's effective width past its column. */}
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


/** Small inline status badge — moved to ./TaskStatusBadge (now shared
 *  + interactive). */
