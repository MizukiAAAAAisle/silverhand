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
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDashed,
  CircleEllipsis,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { TaskStatus, TaskSummaryDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useTasks, useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useRelativeTime } from '@/components/chat/useRelativeTime';

/**
 * Workspace-wide tasks panel — a floating right-side drawer that overlays
 * the main layout without displacing it. Width is user-adjustable via a
 * drag handle on the left edge and persisted in localStorage.
 *
 * Content is a four-column kanban with a conversation filter strip and
 * card → jump navigation.
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
    threadId?: string | null;
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

  // Filter is a discriminated union so we can distinguish:
  //  - `null`            → all tasks in the workspace
  //  - `{ channel, id }` → all tasks under that channel (incl. its threads)
  //  - `{ thread, id }`  → only tasks in that one thread
  // The previous shape (`conversation_id` only) treated "channel" as
  // strictly that conversation row, which excluded thread tasks even
  // when the dropdown said "All". That made the All option look broken
  // — see #214.
  const [conversationFilter, setConversationFilter] = useState<TaskFilterValue>(
    defaultConversationId ? { kind: 'channel', id: defaultConversationId } : null,
  );
  // Re-sync to the active conversation every time the drawer opens.
  // When a `?task=<n>` focus is in flight, override the filter to "all"
  // so the focused row is in the rendered tree (the channel filter
  // would silently hide it if the task lives in a different channel).
  useEffect(() => {
    if (open) {
      if (focusedTaskNumber !== null) {
        setConversationFilter(null);
      } else {
        setConversationFilter(
          defaultConversationId ? { kind: 'channel', id: defaultConversationId } : null,
        );
      }
    }
  }, [open, defaultConversationId, focusedTaskNumber]);

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

  // Always fetch the workspace-wide list, then narrow client-side.
  // Channel-mode filtering needs `task.channel_id === id`, which spans
  // the channel row + all its thread rows; the API's single
  // `conversation_id` filter can't express that, so we drop the
  // server-side filter entirely and let the renderer slice. Workspace
  // task counts here are small enough that the extra payload is fine.
  const { data: allTasks = [], isLoading } = useTasks(
    { workspace_id: workspaceId },
    { workspaceScopeIds },
  );
  const tasks = useMemo(
    () => filterTasks(allTasks, conversationFilter),
    [allTasks, conversationFilter],
  );
  const updateStatus = useUpdateTaskStatus();

  // Channels with their threads grouped underneath. Threads attach to
  // their parent via `parent_channel_id`; orphaned threads (parent
  // missing for any reason) are surfaced as their own chip so the user
  // can still filter to them. Top-level channels are sorted newest-first;
  // threads inside each channel mirror that ordering.
  const channelGroups = useMemo<ChannelGroup[]>(
    () => buildChannelGroups(conversations),
    [conversations],
  );

  const grouped = groupByStatus(tasks);

  const handleCardClick = (t: TaskSummaryDto): void => {
    onJumpToMessage?.({
      workspaceId: t.workspace_id,
      channelId: t.channel_id,
      threadId: t.thread_id,
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

          {/* Conversation filter strip */}
          <div className="shrink-0 border-b border-border-subtle px-4 py-2">
            <ConversationStrip
              value={conversationFilter}
              groups={channelGroups}
              onChange={setConversationFilter}
            />
          </div>

          {/* Kanban board — flex row of columns. Each column hugs its
              own content height (items-start) but caps at `max-h-full`,
              so a sparse column doesn't claim 100% of the page. */}
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
  /** Color token for the icon — kept in sync with TasksSection so both
   *  surfaces share one status vocabulary. */
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

// ── Conversation strip ───────────────────────────────────────────────

/**
 * Drawer-local filter shape. Distinguishes "all tasks under this
 * channel including its threads" from "tasks in exactly this thread";
 * see the dispatch comment on `setConversationFilter` for why the API
 * `conversation_id` parameter alone can't express the channel form.
 */
export type TaskFilterValue =
  | { kind: 'channel'; id: string }
  | { kind: 'thread'; id: string }
  | null;

function filterTasks(
  tasks: TaskSummaryDto[],
  filter: TaskFilterValue,
): TaskSummaryDto[] {
  if (filter === null) return tasks;
  if (filter.kind === 'channel') {
    // Tasks created in a thread carry the parent channel's id in
    // `channel_id` (and the thread id in `thread_id`), so this single
    // predicate captures both channel-direct and thread tasks.
    return tasks.filter(t => t.channel_id === filter.id);
  }
  return tasks.filter(t => t.thread_id === filter.id);
}

interface StripConversation {
  id: string;
  title: string;
  closed_at: number | null;
  created_at: number;
}

interface ChannelGroup {
  channel: StripConversation;
  threads: StripConversation[];
}

/**
 * Build a channels-with-threads tree from the flat conversation list.
 * Threads collapse under their parent so the strip reads as one chip
 * per channel (with a thread dropdown when relevant), matching how the
 * sidebar already organizes the same data.
 */
function buildChannelGroups(
  conversations: WorkspaceTasksDrawerProps['conversations'],
): ChannelGroup[] {
  const channels = conversations.filter(c => c.kind !== 'thread');
  const threads = conversations.filter(c => c.kind === 'thread');
  const byParent = new Map<string, StripConversation[]>();
  for (const t of threads) {
    if (!t.parent_channel_id) continue;
    const arr = byParent.get(t.parent_channel_id) ?? [];
    arr.push({
      id: t.id,
      title: t.title,
      closed_at: t.closed_at,
      created_at: t.created_at,
    });
    byParent.set(t.parent_channel_id, arr);
  }
  // Sort threads inside each channel newest-first to match the channel
  // ordering.
  for (const arr of byParent.values()) {
    arr.sort((a, b) => b.created_at - a.created_at);
  }
  const channelGroups: ChannelGroup[] = channels
    .map(c => ({
      channel: {
        id: c.id,
        title: c.title,
        closed_at: c.closed_at,
        created_at: c.created_at,
      },
      threads: byParent.get(c.id) ?? [],
    }))
    .sort((a, b) => b.channel.created_at - a.channel.created_at);

  // Orphaned threads — parent missing from the list. Render as their
  // own chips after the channel groups so the user can still filter to
  // them. This is defensive; the data should normally always include
  // the parent.
  const orphanThreads: ChannelGroup[] = [];
  const knownChannelIds = new Set(channels.map(c => c.id));
  for (const t of threads) {
    if (t.parent_channel_id && knownChannelIds.has(t.parent_channel_id)) continue;
    orphanThreads.push({
      channel: {
        id: t.id,
        title: t.title,
        closed_at: t.closed_at,
        created_at: t.created_at,
      },
      threads: [],
    });
  }
  orphanThreads.sort((a, b) => b.channel.created_at - a.channel.created_at);

  return [...channelGroups, ...orphanThreads];
}

function ConversationStrip({
  value,
  groups,
  onChange,
}: {
  value: TaskFilterValue;
  groups: ChannelGroup[];
  onChange: (next: TaskFilterValue) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ConversationChip selected={value === null} onClick={() => onChange(null)}>
        All
      </ConversationChip>
      {groups.map(group => (
        <ChannelChip
          key={group.channel.id}
          group={group}
          value={value}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

/**
 * One chip per channel. When the channel has threads, a small caret
 * splits the chip into a button + dropdown trigger. Selecting "All"
 * filters by the channel scope (channel + its threads); selecting a
 * thread narrows to that thread alone. The chip body shows
 * `Channel › Thread` while a thread is active so the breadcrumb stays
 * visible.
 */
function ChannelChip({
  group,
  value,
  onChange,
}: {
  group: ChannelGroup;
  value: TaskFilterValue;
  onChange: (next: TaskFilterValue) => void;
}): JSX.Element {
  const { channel, threads } = group;
  const isChannelSelected =
    value !== null && value.kind === 'channel' && value.id === channel.id;
  const activeThread =
    value !== null && value.kind === 'thread'
      ? threads.find(t => t.id === value.id) ?? null
      : null;
  const isBranchSelected = isChannelSelected || activeThread !== null;
  const dim = channel.closed_at !== null;
  const hasThreads = threads.length > 0;

  if (!hasThreads) {
    return (
      <ConversationChip
        selected={isChannelSelected}
        dim={dim}
        onClick={() => onChange({ kind: 'channel', id: channel.id })}
        title={channel.title}
      >
        {channel.title}
      </ConversationChip>
    );
  }

  // Split-button form: chip body + caret. Same border/typography as the
  // plain ConversationChip so the strip stays visually uniform; the
  // internal divider is a 1px subtle line that matches whichever side
  // is currently active.
  const baseSelected =
    'border-accent bg-accent text-text-on-accent hover:bg-accent';
  const baseIdle =
    'border-border-subtle bg-bg-primary text-text-secondary hover:border-accent hover:text-text-primary';
  const groupBaseClass = cn(
    'inline-flex items-stretch overflow-hidden rounded-full border text-[11px] transition-colors',
    isBranchSelected ? baseSelected : baseIdle,
    dim && !isBranchSelected && 'opacity-60',
  );
  const dividerClass = isBranchSelected
    ? 'border-text-on-accent/40'
    : 'border-border-subtle';

  const labelText = activeThread
    ? `${channel.title} › ${activeThread.title}`
    : channel.title;

  return (
    <span className={groupBaseClass} title={labelText}>
      <button
        type="button"
        onClick={() => onChange({ kind: 'channel', id: channel.id })}
        className="max-w-[200px] truncate px-2.5 py-0.5 outline-none"
      >
        {labelText}
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Filter by thread"
            className={cn(
              'flex items-center justify-center border-l px-1.5 outline-none transition-colors',
              dividerClass,
              // Lighten the trigger half a touch so the user sees the
              // split affordance even on the selected (filled) variant.
              isBranchSelected
                ? 'hover:bg-accent/80'
                : 'hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-[80] min-w-[200px] rounded-md border border-border bg-bg-floating p-1 text-xs text-text-primary shadow-lg outline-none"
          >
            <DropdownMenu.Item
              onSelect={() => onChange({ kind: 'channel', id: channel.id })}
              className={cn(
                'flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none transition-colors',
                'data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary',
              )}
            >
              <span className="truncate">All</span>
              {isChannelSelected ? (
                <Check className="size-3 shrink-0 text-accent" />
              ) : null}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border-subtle/60" />
            {threads.map(t => {
              const selected = activeThread?.id === t.id;
              const tDim = t.closed_at !== null;
              return (
                <DropdownMenu.Item
                  key={t.id}
                  onSelect={() => onChange({ kind: 'thread', id: t.id })}
                  className={cn(
                    'flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none transition-colors',
                    'data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary',
                    tDim && 'opacity-60',
                  )}
                >
                  <span className="truncate" title={t.title}>
                    {t.title}
                  </span>
                  {selected ? (
                    <Check className="size-3 shrink-0 text-accent" />
                  ) : null}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

function ConversationChip({
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
  return (
    <section
      data-tasks-column
      data-status={status}
      className={cn(
        // Mirrors TasksSection — column hugs content height with a
        // `max-h-full` cap; body scrolls inside when content overflows.
        'flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-base',
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
  return (
    <div
      data-task-number={task.task_number}
      className={cn(
        'group relative rounded-md border border-border-subtle bg-bg-primary transition-all hover:border-accent hover:bg-bg-hover',
        // Brief ring pulse when this card is the focused-task target.
        // Cleared by the drawer's setTimeout (~1.4s) so the highlight
        // doesn't linger on next open. `transition-all` lets the ring
        // fade in/out smoothly without a custom keyframe.
        highlighted && 'ring-2 ring-accent ring-offset-1 ring-offset-bg-base',
      )}
    >
      {/* Jump to message — full card content area */}
      <button
        type="button"
        onClick={onClick}
        className="block w-full p-2 pr-7 text-left"
      >
        {/* Row 1: #number + status badge inline */}
        <div className="flex items-center gap-1.5 pb-0.5">
          <span data-tasks-num className="font-mono text-[10px] text-text-muted">
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
  const labels: Record<TaskStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    in_review: 'in review',
    done: 'done',
  };
  return (
    <span
      data-task-status={status}
      className="rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide"
    >
      {labels[status]}
    </span>
  );
}
