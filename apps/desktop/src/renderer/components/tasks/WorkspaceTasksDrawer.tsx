import { taskChannelLabel } from '../../features/tasks/taskPlace.js';
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
import { useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useKanbanColumnCollapse } from '@/features/tasks/useKanbanColumnCollapse';
import { useRevealTaskRow } from '@/features/tasks/useRevealTaskRow';
import { FIRST_COLUMN_WINDOW } from '@/features/tasks/columnWindow';
import {
  boardColumnTotal,
  boardCountLabel,
} from '@/features/tasks/boardAuthority';
import {
  boardColumnCanGrow,
  boardVisibleItems,
  useBoardColumns,
  useBoardCounts,
  useBoardFacets,
} from '@/features/tasks/useBoard';
import { useBoardReveal } from '@/features/tasks/useBoardReveal';
import {
  useColumnEndSentinel,
  useColumnWindow,
} from '@/features/tasks/useColumnWindow';
import { useTaskFilterOptions } from '@/features/tasks/useTaskFilterOptions';
import {
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
} from '@/features/tasks/taskFilters';
import {
  taskContainerBaseline,
  taskContainerKey,
  taskContainerLabel,
  type TaskBoardContainer,
} from '@/features/tasks/taskContainer';
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
  type CreateTaskTarget,
} from '@/components/tasks/CreateTaskDialog';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/features/common/PrimaryAction';

/**
 * Conversation tasks panel — a floating right-side drawer that overlays
 * the main layout without displacing it. Width is user-adjustable via a
 * drag handle on the left edge and persisted in localStorage.
 *
 * Content is a five-column status kanban (Todo / In progress / In review /
 * Done / Closed) with a unified TaskFilterBar (channel / assignee /
 * creator) and card → jump navigation.
 *
 * It opens for a CONTAINER (`TaskBoardContainer`, #task:2041) — a workspace
 * channel or a direct line — not for a workspace with a channel hanging off it.
 * A `direct_pair` has no workspace, and the old `workspaceId: string` prop is
 * what made the DM position unable to host this panel at all.
 */
export interface WorkspaceTasksDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which container this drawer was opened for — decides the header label and
   *  the baseline narrowing (`taskContainerBaseline`). */
  container: TaskBoardContainer;
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
  container,
  revealTaskId = null,
  onRevealConsumed,
  detailOpen = false,
  onOpenTask,
}: WorkspaceTasksDrawerProps): JSX.Element {
  const drawerShellRef = useRef<HTMLDivElement>(null);
  const { width: drawerWidth, startResize } = useDrawerWidth(drawerShellRef);
  const containerLabel = taskContainerLabel(container);

  // Unified filter model (channel / assignee / creator), shared with the
  // global Tasks board. `channelId` is a conversation id:
  //  - a channel id → matches that channel + all its threads;
  //  - a thread id  → matches only that thread.
  // Baseline (= reset/Clear target) is the drawer's entry context, derived from
  // the CONTAINER it was opened for (`taskContainerBaseline`, #task:2041): the
  // workspace arm anchors workspace + channel, the pair arm anchors the pair's
  // own conversation and mints no workspace. It anchors on open — the drawer
  // opens from inside a conversation, so defaulting to ALL surfaced unrelated
  // workspaces' tasks (#task:1432). Both filters stay switchable to any
  // workspace/channel or All; Clear restores this baseline rather than jumping
  // to All.
  const baselineFilters = useMemo<TaskFilters>(
    () => taskContainerBaseline(container),
    // Keyed on the container's VALUE (`taskContainerKey`), not on the prop's
    // identity: the container is assembled from query rows, so a refetch that
    // returns equal facts still hands over fresh objects. Identity here would
    // re-run the baseline effect below on every such refetch and discard the
    // narrowing the viewer set while the drawer was open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskContainerKey(container)],
  );
  const [filters, setFilters] = useState<TaskFilters>(baselineFilters);
  // Render window (#task:1885) — this drawer's OWN bound, not the pane's. The
  // two surfaces share one query cache but must not share a render ceiling: the
  // drawer stays mounted for the whole time a workspace is selected, so
  // inheriting a pane session's grown window is exactly the mount cost this
  // window exists to remove.
  const {
    columnWindow,
    grow: growColumn,
    reset: resetColumnWindow,
    coverIndex: coverColumnIndex,
  } = useColumnWindow();
  // Every filter write goes through here. Changing what a column HOLDS resets
  // what it RENDERS — otherwise a window grown against the previous population
  // renders a deep prefix of the new one, which reads as "the filter loaded more
  // results than it has". Kept as an explicit funnel rather than an effect keyed
  // on `filters` so a reveal's reset and its coverage land in ONE commit (see
  // `useColumnWindow`).
  const applyFilters = useCallback(
    (next: TaskFilters) => {
      setFilters(next);
      resetColumnWindow();
    },
    [resetColumnWindow],
  );
  // Baseline re-sync: the drawer's own entry context, re-applied on the OPEN
  // transition and whenever the baseline identity changes. It does NOT consult
  // the reveal intent — a filter state that depends on whether a transient
  // one-shot has been consumed yet reintroduces exactly the ordering bug the
  // two effects below are split to avoid (Cindy BLOCKER 2).
  useEffect(() => {
    if (!open) return;
    applyFilters(baselineFilters);
  }, [open, baselineFilters, applyFilters]);

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

  // The bound the columns actually render against. A CLOSED drawer is pinned to
  // the first page: the shell stays mounted (translated off-screen) for the whole
  // time a workspace is selected, so its card tree is pure cost while nobody can
  // see it — pinning is what keeps a Chat mount cheap, and it costs nothing on
  // reopen because the grown state is discarded, not hidden. Growth state itself
  // is left untouched; the OPEN transition re-applies the baseline through
  // `applyFilters`, which resets it anyway.
  //
  // Pinning bounds RENDERING only. What stops the closed drawer from READING is
  // `enabled: open` below — the two are separate because the cache is shared: a
  // closed drawer may hold five pages the pane fetched, and must still render one.
  const renderWindow = open ? columnWindow : FIRST_COLUMN_WINDOW;

  // Collapse is read here, not only inside the column, because it gates the
  // queries as well as the body (a collapsed column must fetch nothing). The
  // store is shared with the pane, so the two surfaces stay in sync.
  const { isCollapsed, toggle: toggleCollapse } = useKanbanColumnCollapse();

  // The authority read faces (#task:1884), the same three the pane consumes and
  // through the SAME query keys — one cache per `(status, filter)`, so opening
  // the drawer over a board the pane already read costs no refetch, and the two
  // surfaces still cannot inherit each other's render ceiling (that is
  // `renderWindow`, above).
  //
  // `enabled: open` is the drawer's whole cost story: closed, it issues no read
  // at all — not the columns, not the counts, not the facets. Channel / assignee
  // / creator are narrowed server-side now, so nothing here slices a full array.
  const columns = useBoardColumns({
    filters,
    enabled: open,
    window: renderWindow,
    isCollapsed,
  });
  const counts = useBoardCounts(filters, { enabled: open });
  const people = useBoardFacets(filters, { enabled: open });
  const updateStatus = useUpdateTaskStatus();

  // Make a reveal target renderable: the row may live in another
  // workspace/channel that the anchored baseline filters out, so widening the
  // filters back to All is this surface's own obligation (Cindy BLOCKER 10).
  // Closed tasks are always in the tree (a status column, not a hidden tier), so
  // no visibility widening is needed. Once widened the view stays widened and the
  // user can re-select.
  //
  // Widening is now ONLY the filter reset. The other two ways a held row can go
  // unrendered — past this surface's window, or on a page nobody fetched — are
  // not one-shot writes but a walk, owned by `useBoardReveal` below.
  //
  // Called by `useRevealTaskRow` once per intent, BEFORE it trusts the rendered
  // set — so this reacts to the intent's arrival and never to whether the intent
  // has been consumed yet (Cindy BLOCKER 2). It runs after the baseline effect
  // above in the same commit (effects run in declaration order), so on a reveal
  // that opens the drawer the widening is the last write.
  const ensureRevealRenderable = useCallback(() => {
    applyFilters({ ...DEFAULT_TASK_FILTERS });
  }, [applyFilters]);

  // A plain card click opens the detail modal (`?task=<id>`, hosted by App);
  // jumping to the conversation is the modal's own explicit action.
  const handleCardClick = (t: TaskSummaryDto): void => {
    onOpenTask?.(t.id);
  };

  // Create entrance. A direct line's drawer creates ONTO the pair conversation —
  // there is no channel to pick (contract §5), so the target is locked. A
  // workspace drawer offers the channel picker, seeded from the current channel
  // FILTER only when it resolves to a real member-channel option — the drawer
  // opens focused on its entry channel, so that is usually the default, but an
  // ALL / thread filter leaves it unseeded (the actor picks one). On success the
  // dialog closes and the list refreshes in place; the new task is NOT opened in
  // a detail modal (shiki 2026-07-30). (`createOpen` state lives above the Escape
  // effect, which must defer to the dialog.)
  const submitCreate = useCreateTaskSubmit();
  const createTarget = useMemo<CreateTaskTarget>(() => {
    if (container.kind === 'direct_pair') {
      return { kind: 'locked', conversationId: container.conversationId };
    }
    const defaultChannelId = channelOptions.some(o => o.id === filters.channelId)
      ? filters.channelId
      : null;
    return { kind: 'pick', channelOptions, defaultChannelId };
  }, [container, channelOptions, filters.channelId]);

  // Focus trap: keep focus inside drawer while open.
  const drawerRef = useRef<HTMLDivElement>(null);

  // Where the target is, whether it can still be widened or paged to, and the
  // evidence clocks of the ONE column that may answer for it — the paged board's
  // reveal inputs, shared with the pane so neither surface can grow its own
  // version (`useBoardReveal`). `active: open` is what makes this drawer stand
  // down: a closed drawer holds no intent (App hands it `null`) and can deliver
  // nothing.
  const reveal = useBoardReveal({
    revealTaskId,
    active: open,
    columns,
    window: renderWindow,
    grow: growColumn,
    coverIndex: coverColumnIndex,
  });

  // Scroll + pulse + one-shot consumption, shared with the `/tasks` board so the
  // "absence is only terminal with positive evidence" rule and the pulse's
  // re-arming exist once (see `useRevealTaskRow`).
  const { highlightedTaskId } = useRevealTaskRow({
    revealTaskId,
    active: open,
    rootRef: drawerRef,
    target: reveal.target,
    ensureRenderable: ensureRevealRenderable,
    canWiden: reveal.canWiden,
    onWiden: reveal.widen,
    canFetch: reveal.canFetch,
    onPage: reveal.page,
    authority: reveal.authority,
    isFetching: reveal.isFetching,
    dataUpdatedAt: reveal.dataUpdatedAt,
    errorUpdateCount: reveal.errorUpdateCount,
    refetch: reveal.refetch,
    onConsumed: onRevealConsumed,
  });

  return (
    <>
      {/* Click-away backdrop — `no-drag` so its inset-0 footprint doesn't
          re-activate the titlebar drag region; conditionally rendered so
          Electron triggers a fresh hit-test recalculation on open/close. */}
      {open ? (
        <div
          className="fixed inset-0 z-[var(--z-drawer)] no-drag"
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
          'fixed inset-y-0 right-0 z-[var(--z-dialog)]',
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
            <CheckSquare
              data-tasks-hero
              data-sticker
              data-sticker-tone="task"
              data-sticker-size="sm"
              className="size-4 text-text-muted"
            />
            <span className="font-serif text-base font-semibold text-text-primary">
              Tasks
              {containerLabel ? (
                <span className="ml-2 text-sm font-normal text-text-muted">
                  {/* No `#`: that sigil belongs to channels. A workspace name
                      is a free-text label (#task:1827), so prefixing it reads
                      as a broken channel reference — and a direct line's label
                      is a person, which is even less of a channel. */}
                  · {containerLabel}
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
              onChange={applyFilters}
              baselineFilters={baselineFilters}
              // Full option sets, same as the pane (#task:1165). The container
              // axis inside the bar decides which secondary controls describe the
              // current container: a DM baseline opens on the `direct_messages`
              // axis, which hides the workspace/channel controls and shows the
              // 对端 leaf instead — no drawer-local withholding, one model
              // (#task:2041).
              workspaceOptions={workspaceOptions}
              channelOptions={channelOptions}
              allChannelsLabel="ALL"
              people={people}
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
                items={boardVisibleItems(columns[col.status], renderWindow, col.status)}
                total={boardColumnTotal(counts, col.status)}
                hasMore={boardColumnCanGrow(columns[col.status], renderWindow, col.status)}
                onReachEnd={() => growColumn(col.status)}
                isLoading={columns[col.status].isLoading}
                isError={columns[col.status].isError}
                collapsed={isCollapsed(col.status)}
                onToggleCollapse={() => toggleCollapse(col.status)}
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
        target={createTarget}
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

// ── Kanban column ────────────────────────────────────────────────────

function KanbanColumn({
  title,
  status,
  icon: Icon,
  iconClass,
  items,
  total,
  hasMore,
  onReachEnd,
  isLoading,
  isError,
  collapsed,
  onToggleCollapse,
  onCardClick,
  onStatusChange,
  highlightedTaskId,
}: {
  title: string;
  status: TaskStatus;
  icon: LucideIcon;
  iconClass: string;
  /** The rows this surface may render — the loaded prefix under its own window
   *  bound, never the whole column. */
  items: TaskSummaryDto[];
  /** The column's authoritative total under the current filters (counts face),
   *  which is what the header shows: bounding the body must not shrink the
   *  number. `null` while the counts face has not answered — independent of this
   *  column's own body read, so a loaded body can show its rows with no number,
   *  and a known total can stand over a failed body. */
  total: number | null;
  /** Anything left past the rendered rows — loaded or still on the server. */
  hasMore: boolean;
  /** The reader reached the end of this column — render one more page. */
  onReachEnd: () => void;
  isLoading: boolean;
  isError: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCardClick: (t: TaskSummaryDto) => void;
  onStatusChange: (taskId: string, next: TaskStatus) => void;
  highlightedTaskId: string | null;
}): JSX.Element {
  // Drag-over highlight (#task:779) — mirrors TasksSection.
  const [dragOver, setDragOver] = useState(false);
  // Per-column collapse (#task:1169) — the resolved bit and its toggle arrive
  // from the drawer, which needs them to gate the reads too. Mirrors
  // TasksSection.
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  // A collapsed column renders no body, so it arms no observer — the sentinel
  // isn't in the tree and an unmounted root would grow the window forever.
  const canGrow = !collapsed && hasMore;
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  useColumnEndSentinel({
    rootRef: bodyRef,
    sentinelRef,
    hasMore: canGrow,
    renderedCount: items.length,
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
        'flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-[var(--card-radius)] border border-border-subtle bg-bg-base transition-colors',
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
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} column`}
        className="flex w-full shrink-0 cursor-pointer items-center gap-2 border-b border-border-subtle px-3 py-2 text-left transition-colors hover:bg-bg-hover"
      >
        <Chevron className="size-3.5 shrink-0 text-text-muted" aria-hidden />
        <Icon data-tasks-column-icon className={cn('size-3.5 shrink-0', iconClass)} aria-hidden />
        <span className="text-[length:var(--text-meta)] font-medium uppercase tracking-wider text-text-secondary">
          {title}
        </span>
        <span className="text-[length:var(--text-badge)] tabular-nums text-text-muted">
          {boardCountLabel(total)}
        </span>
      </button>
      {collapsed ? null : (
        <div
          ref={bodyRef}
          data-tasks-column-body
          className="min-h-0 flex-auto overflow-y-auto p-2"
        >
          {isLoading ? (
            <p className="px-2 py-3 text-center text-[length:var(--text-meta)] text-text-muted">
              Loading…
            </p>
          ) : isError ? (
            <p className="px-2 py-3 text-center text-[length:var(--text-meta)] text-text-muted">
              Couldn’t load tasks
            </p>
          ) : items.length === 0 && !dragOver ? (
            <p className="px-2 py-3 text-center text-[length:var(--text-meta)] italic text-text-muted">
              No {title.toLowerCase()} tasks
            </p>
          ) : (
            <ul className="space-y-1.5">
              {dragOver ? <TaskDropPlaceholder /> : null}
              {items.map(t => (
                <li key={t.id}>
                  <TaskCard
                    task={t}
                    highlighted={highlightedTaskId === t.id}
                    onClick={() => onCardClick(t)}
                    onStatusChange={next => onStatusChange(t.id, next)}
                  />
                </li>
              ))}
              {/* Tail sentinel — grows the window as it comes into view, which is
                  also what asks for the next page (the window drives fetching).
                  No visual of its own: the rows either arrive on the next commit
                  (already cached) or with the page, and a spinner pinned to the
                  tail would flicker on every local growth. */}
              {canGrow ? <li ref={sentinelRef} aria-hidden className="h-px" /> : null}
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
  const channelLabel = taskChannelLabel(task);
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
          'group relative min-w-0 cursor-grab rounded-[var(--card-radius)] border border-border-subtle bg-bg-primary transition-all hover:border-accent hover:bg-bg-hover active:cursor-grabbing',
          // Brief outline pulse when this card is the focused-task target.
          // Cleared by the drawer's setTimeout (~1.4s) so the highlight
          // doesn't linger on next open. `transition-all` lets the outline
          // fade in/out smoothly without a custom keyframe.
          highlighted && '[outline:2px_solid_var(--accent)] [outline-offset:1px]',
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
        className="absolute inset-0 z-0 rounded-[var(--card-radius)] focus-outline-accent"
      />
      {/* Content layer. `pointer-events-none` so text clicks fall
          through to the jump overlay; only the status badge re-enables
          pointer events. `min-w-0` propagates the row's narrow-width
          shrink down to the title/meta rows below (#task:918). */}
      <div className="pointer-events-none relative z-[var(--z-raised)] min-w-0 p-2">
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
          <span data-tasks-num className="shrink-0 font-mono text-[length:var(--text-badge)] text-text-muted">
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
        <div className="mt-1 flex items-center gap-x-2 text-[length:var(--text-badge)] text-text-muted">
          <span className="shrink-0 text-text-secondary">
            {task.assignee ? task.assignee.name : (
              <span className="italic">unassigned</span>
            )}
          </span>
          {channelLabel !== null ? (
            <span
              className="inline-flex min-w-0 items-center gap-0.5 text-text-secondary"
              title={channelLabel}
            >
              <ChannelIcon variant="sticker" density="sm" className="text-text-muted" />
              <span className="min-w-0 truncate">{channelLabel}</span>
            </span>
          ) : null}
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
