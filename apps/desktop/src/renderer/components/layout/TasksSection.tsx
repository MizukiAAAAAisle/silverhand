import { memo, useCallback, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { TaskIcon } from '@/components/tasks/TaskIcon';
import { useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useKanbanColumnCollapse } from '@/features/tasks/useKanbanColumnCollapse';
import { useTaskFilterOptions } from '@/features/tasks/useTaskFilterOptions';
import {
  activeTaskCount,
  boardCountLabel,
  totalTaskCount,
} from '@/features/tasks/boardAuthority';
import {
  useBoardColumns,
  useBoardCounts,
  useBoardFacets,
} from '@/features/tasks/useBoard';
import { useColumnWindow } from '@/features/tasks/useColumnWindow';
import {
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
} from '@/features/tasks/taskFilters';
import { TaskBoardColumns } from '@/components/tasks/TaskBoardColumns';
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
import { paneChrome } from './pane-chrome';

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
 */
export interface TasksSectionProps {
  onOpenTask: (taskId: string) => void;
}

export const TasksSection = memo(function TasksSection({
  onOpenTask,
}: TasksSectionProps): JSX.Element {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
  const updateStatus = useUpdateTaskStatus();
  // Per-column render bound, local to THIS surface (#task:1885). Every write that
  // changes what the columns hold goes through `applyFilters` below, which resets
  // the window in the same commit.
  const {
    columnWindow,
    grow: growColumn,
    reset: resetColumnWindow,
  } = useColumnWindow();
  const applyFilters = useCallback(
    (next: TaskFilters) => {
      setFilters(next);
      resetColumnWindow();
    },
    [resetColumnWindow],
  );
  // Workspace + channel options + scope ids (#task:1165): DM + regular workspace
  // channels, grouped by data source; regular workspaces for the upstream cascade
  // axis (#task:1387).
  const { workspaceOptions, channelOptions } = useTaskFilterOptions();

  // Collapse is read HERE, not only inside the column: a collapsed column must
  // render no body AND fetch none, so the gate has to reach the queries. The
  // column still receives the resolved bit + its toggle, so the store stays the
  // single source both surfaces share.
  const { isCollapsed, toggle: toggleCollapse } = useKanbanColumnCollapse();

  // The authority read faces (#task:1884): one paged query per column, the
  // per-status totals, and the filter menus' option sets. Every filter axis is
  // narrowed SERVER-side now — nothing here slices a full array, so the board's
  // cost no longer scales with the workspace's task count. Realtime freshness is
  // App's (`useTaskBoardRealtime` — one listener for both surfaces + the badge).
  const columns = useBoardColumns({
    filters,
    enabled: true,
    window: columnWindow,
    isCollapsed,
  });
  const counts = useBoardCounts(filters);
  const people = useBoardFacets(filters);

  const selectedChannelName = filters.channelId
    ? channelOptions.find(o => o.id === filters.channelId)?.label
    : null;

  // A task must name a channel; seed the create picker from the current channel
  // FILTER only when it resolves to a real member-channel option (a thread-scoped
  // or ALL filter has no channel to pre-select — the actor picks one). On success
  // the dialog closes and the list refreshes in place; the new task is NOT opened
  // in a detail modal (shiki 2026-07-30). The global board always PICKS a channel
  // — it never guesses a DM as the target (contract §5); a DM task is created only
  // from that direct line's own Tasks tab.
  const createTarget = useMemo<CreateTaskTarget>(() => {
    const defaultChannelId = channelOptions.some(o => o.id === filters.channelId)
      ? filters.channelId
      : null;
    return { kind: 'pick', channelOptions, defaultChannelId };
  }, [channelOptions, filters.channelId]);
  const submitCreate = useCreateTaskSubmit();

  return (
    <main
      className="flex h-full flex-1 flex-col bg-bg-base"
      style={{ ...paneChrome, overflow: 'hidden' }}
    >
      {/* Header padding: `pl-[6px]` matches the forza6 tasks-hero
        * sticker's 6px vertical clearance (22+1+1=24px sticker in 36px
        * titlebar → (36-24)/2 = 6px top/bottom), so left ≈ vertical
        * = symmetric breathing room around the hero stamp. Other
        * themes show a plain 16px Task icon here; 6px left is tight
        * but not broken — the icon leads the header content tight to
        * the left edge by intent (shiki #task:917 v6.7.3, "在不同的
        * 地方用不同的外层样式来控制"). */}
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle pl-[6px] pr-4">
        <TaskIcon
          data-tasks-hero
          data-sticker
          data-sticker-tone="task"
          data-sticker-size="sm"
          className="size-4 text-text-muted"
        />
        <span className="font-serif text-sm font-semibold text-text-primary">
          {selectedChannelName ? `Tasks in #${selectedChannelName}` : 'All Tasks'}
        </span>
        <span className="text-xs text-text-muted">
          · {boardCountLabel(totalTaskCount(counts))}
        </span>
        <span className="ml-auto text-[length:var(--text-badge)] text-text-muted">
          {boardCountLabel(activeTaskCount(counts))} active
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
          people={people}
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

      {/* Five-column kanban — the shared board body (`TaskBoardColumns`); this
        * section supplies the shell + the main-pane fill vocabulary. */}
      <TaskBoardColumns
        columns={columns}
        counts={counts}
        window={columnWindow}
        isCollapsed={isCollapsed}
        onToggleCollapse={toggleCollapse}
        onGrow={growColumn}
        onOpenTask={onOpenTask}
        onStatusChange={(taskId, next) => updateStatus.mutate({ taskId, status: next })}
        columnClassName="bg-bg-primary"
        cardClassName="bg-bg-base"
      />

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={createTarget}
        onSubmit={submitCreate}
      />
    </main>
  );
});
