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
  Archive,
  CheckCircle2,
  CheckSquare,
  Circle,
  CircleDashed,
  CircleEllipsis,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
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
import { TaskFilterBar, type ChannelOption, buildChannelFilterOptions } from '@/components/tasks/TaskFilterBar';

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
  workspaceScopeIds?: readonly string[];
  conversations: Array<{
    id: string;
    title: string;
    kind: 'channel' | 'dm_channel' | 'thread';
    /** Parent channel id if this is a thread; null for top-level channels. */
    parent_channel_id: string | null;
    /** Archived channels are never offered as filter options. */
    archived_at: number | null;
    closed_at: number | null;
    created_at: number;
  }>;
  /** Initially-selected conversation for the filter. null → all conversations. */
  defaultConversationId: string | null;
  /** Workspace-scoped task number to focus. When set (sourced from
   *  `?task=<n>` URL state), the drawer overrides the conversation
   *  filter to "all" so the target row is reachable, scrolls it into
   *  view, and applies a brief highlight. Cleared by `onClearFocus` so
   *  the URL writer (`closeTask`) and the drawer state stay in sync. */
  focusedTaskNumber?: number | null;
  /** Called after the drawer has scrolled-and-highlighted the focused
   *  row. Wired to `nav.closeTask` so the URL drops `?task=<n>` once the
   *  visual focus has been delivered, preventing a stale highlight on
   *  next open. */
  onClearFocus?: () => void;
  onJumpToMessage?: (params: {
    workspaceId?: string;
    channelId: string;
    threadRootId?: string | null;
    messageId: string;
  }) => void;
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
  workspaceScopeIds,
  conversations,
  defaultConversationId,
  focusedTaskNumber = null,
  onClearFocus,
  onJumpToMessage,
}: WorkspaceTasksDrawerProps): JSX.Element {
  const drawerShellRef = useRef<HTMLDivElement>(null);
  const { width: drawerWidth, startResize } = useDrawerWidth(drawerShellRef);

  // Unified filter model (channel / assignee / creator), shared with the
  // global Tasks board. `channelId` is a conversation id:
  //  - a channel id → matches that channel + all its threads;
  //  - a thread id  → matches only that thread.
  // Baseline (= reset/Clear target) is the current channel — the drawer's
  // entry context — but it stays switchable to any channel/thread or All
  // (shiki/Cindy: don't lock the drawer to the current channel). Clear
  // restores this baseline rather than jumping to All.
  const baselineFilters = useMemo<TaskFilters>(
    () => ({ ...DEFAULT_TASK_FILTERS, channelId: defaultConversationId }),
    [defaultConversationId],
  );
  const [filters, setFilters] = useState<TaskFilters>(baselineFilters);
  // Re-sync every time the drawer opens. When a `?task=<n>` focus is in
  // flight, widen channel → All so the focused row is in the rendered
  // tree (a different channel would otherwise be filtered out and the
  // scroll-and-highlight effect below couldn't find `[data-task-number]`).
  // Closed tasks are always in the tree now (a status column, not a
  // hidden visibility tier), so no visibility widening is needed. The
  // user can still re-select afterward.
  useEffect(() => {
    if (!open) return;
    if (focusedTaskNumber !== null) {
      setFilters({ ...DEFAULT_TASK_FILTERS, channelId: null });
    } else {
      setFilters(baselineFilters);
    }
  }, [open, baselineFilters, focusedTaskNumber]);

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

  // Always fetch the workspace-wide list (all statuses, incl. closed —
  // it's just the 5th column). Channel / assignee / creator are sliced
  // client-side via applyTaskFilters (channel match spans a channel + its
  // threads, which the API's single `conversation_id` filter can't
  // express — see #214).
  const { data: allTasks = [], isLoading } = useTasks(
    { workspace_id: workspaceId },
    { workspaceScopeIds },
  );

  // Channel filter options. Eligibility (skip fossil threads + archived,
  // dedup, map) is single-sourced in buildChannelFilterOptions so this
  // drawer and the task pane cannot drift; this surface only owns its scope
  // (this workspace's conversations) and its sort (newest-created first).
  const channelOptions = useMemo<ChannelOption[]>(() => {
    return buildChannelFilterOptions(
      conversations
        .slice()
        .sort((a, b) => b.created_at - a.created_at)
        .map(c => ({
          id: c.id,
          title: c.title,
          kind: c.kind,
          archived_at: c.archived_at,
        })),
    );
  }, [conversations]);

  const tasks = useMemo(
    () =>
      applyTaskFilters(
        allTasks,
        filters,
        // Channel-scoped: cluster + fossil tasks both resolve to a real
        // channel through `channel_id` (the read model maps a fossil's
        // channel_id to its parent channel).
        (task, conversationId) => task.channel_id === conversationId,
      ),
    [allTasks, filters],
  );
  const updateStatus = useUpdateTaskStatus();

  const assigneeOptions = useMemo(() => collectAssignees(allTasks), [allTasks]);
  const creatorOptions = useMemo(() => collectCreators(allTasks), [allTasks]);
  const hasUnassigned = useMemo(() => allTasks.some(t => !t.assignee), [allTasks]);

  const grouped = useMemo(() => groupByStatus(tasks), [tasks]);

  const handleCardClick = (t: TaskSummaryDto): void => {
    onJumpToMessage?.({
      workspaceId: t.workspace_id,
      channelId: t.channel_id,
      // New reply-cluster tasks carry `thread_root_id`; the cluster pane
      // opens to it.
      threadRootId: t.thread_root_id,
      messageId: t.message_id,
    });
    onOpenChange(false);
  };

  // Focus trap: keep focus inside drawer while open.
  const drawerRef = useRef<HTMLDivElement>(null);

  // Visual highlight for the focused-task row. Distinct from
  // `focusedTaskNumber` (the URL-driven *intent* — "scroll me here"):
  // once delivered, we clear the URL pointer via `onClearFocus` but
  // keep the highlight on for ~1.4s so a quick second click on the
  // same chip still produces a perceptible flash.
  const [highlightedTaskNumber, setHighlightedTaskNumber] = useState<number | null>(
    null,
  );
  // Scroll-and-highlight on focused-task arrival. We wait one
  // animation frame so the filter override committed in the effect
  // above has a chance to flush — the matching row may have just
  // appeared in the DOM. Once we find the element we scroll it into
  // view and immediately call `onClearFocus` so the URL drops the
  // pointer; the highlight outlives the URL state via
  // `highlightedTaskNumber` to keep visual feedback uncoupled from
  // navigation.
  useEffect(() => {
    if (!open) return;
    if (focusedTaskNumber == null) return;
    if (isLoading) return; // tasks list not ready yet — wait for fetch
    let cancelled = false;
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;
      const root = drawerRef.current;
      if (!root) return;
      const el = root.querySelector<HTMLElement>(
        `[data-task-number="${focusedTaskNumber}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setHighlightedTaskNumber(focusedTaskNumber);
      }
      onClearFocus?.();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [open, focusedTaskNumber, isLoading, onClearFocus]);

  // Auto-clear the highlight ring after a short pulse so the row
  // settles back into the column visually. Independent of the URL —
  // re-clicking the same chip refreshes `focusedTaskNumber` (no-op if
  // unchanged), so the effect above re-arms the highlight.
  useEffect(() => {
    if (highlightedTaskNumber == null) return;
    const t = setTimeout(() => setHighlightedTaskNumber(null), 1400);
    return () => clearTimeout(t);
  }, [highlightedTaskNumber]);

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
              aria-label="关闭 Tasks"
              className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Unified filter bar — replaces the old conversation chip strip */}
          <div className="shrink-0 border-b border-border-subtle px-4 py-2">
            <TaskFilterBar
              filters={filters}
              onChange={setFilters}
              baselineFilters={baselineFilters}
              channelOptions={channelOptions}
              allChannelsLabel="ALL"
              assigneeOptions={assigneeOptions}
              creatorOptions={creatorOptions}
              hasUnassigned={hasUnassigned}
            />
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
                onStatusChange={(messageId, status) =>
                  updateStatus.mutate({ messageId, status })
                }
                highlightedTaskNumber={highlightedTaskNumber}
              />
            ))}
          </div>
        </div>
      </div>
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
  highlightedTaskNumber,
}: {
  title: string;
  status: TaskStatus;
  icon: LucideIcon;
  iconClass: string;
  tasks: TaskSummaryDto[];
  isLoading: boolean;
  onCardClick: (t: TaskSummaryDto) => void;
  onStatusChange: (messageId: string, next: TaskStatus) => void;
  highlightedTaskNumber: number | null;
}): JSX.Element {
  // Drag-over highlight (#task:779) — mirrors TasksSection.
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
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={e => {
        const payload = readTaskDrag(e.dataTransfer);
        setDragOver(false);
        if (!payload) return;
        e.preventDefault();
        if (payload.from === status) return; // same-column drop = no-op
        onStatusChange(payload.messageId, status);
      }}
      className={cn(
        // Mirrors TasksSection — column hugs content height with a
        // `max-h-full` cap; body scrolls inside when content overflows.
        'flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-base transition-colors',
        (status === 'done' || status === 'closed') && 'opacity-80',
        // Drop affordance (`data-drop-target`) is painted in CSS, not here —
        // forza6's high-specificity `[data-tasks-column]` background/border
        // can't be beaten by a Tailwind utility (shiki #task:784, Cindy
        // review). See global.css / forza6-components.css.
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
        {isLoading ? (
          <p className="px-2 py-3 text-center text-[11px] text-text-muted">
            加载中…
          </p>
        ) : tasks.length === 0 && !dragOver ? (
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
                  highlighted={highlightedTaskNumber === t.task_number}
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
        draggable
        onDragStart={e => {
          writeTaskDrag(e.dataTransfer, { messageId: task.message_id, from: task.status });
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
        aria-label="跳转到消息"
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
        {/* Row 3: assignee · in conversation · created (inline meta,
            mirrors the popover layout — see TaskRef.TaskPopoverBody).
            `flex-wrap` (#task:918): narrow cards let each segment drop
            to a new line instead of overflowing. The conversation span
            keeps `min-w-0 truncate` so it still ellipsizes when forced
            onto a single line with siblings; gap-y-0 keeps stacked
            lines tight. */}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[10px] text-text-muted">
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


/** Small inline status badge — moved to ./TaskStatusBadge (now shared
 *  + interactive). */
