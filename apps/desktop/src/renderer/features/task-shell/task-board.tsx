import { memo, useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { TaskIcon } from "@/features/task-shell/components/task-icon";
import { useUpdateTaskStatus } from "@/features/task-shell/hooks/hooks";
import { useKanbanColumnCollapse } from "@/features/task-shell/hooks/use-kanban-column-collapse";
import { useTaskFilterOptions } from "@/features/task-shell/hooks/use-task-filter-options";
import {
  activeTaskCount,
  boardCountLabel,
  totalTaskCount,
} from "@/features/task-shell/model/board-authority";
import {
  useBoardColumns,
  useBoardCounts,
  useBoardFacets,
} from "@/features/task-shell/hooks/use-board";
import { useColumnWindow } from "@/features/task-shell/hooks/use-column-window";
import { DEFAULT_TASK_FILTERS, type TaskFilters } from "@/features/task-shell/model/task-filters";
import { TaskBoardColumns } from "@/features/task-shell/components/task-board-columns";
import {
  TaskFilterBar,
  FILTER_ROW_TRIGGER_BOX,
} from "@/features/task-shell/components/task-filter-bar";
import {
  CreateTaskDialog,
  useCreateTaskSubmit,
  type CreateTaskTarget,
} from "@/features/task-shell/components/create-task-dialog";
import { Button } from "@/components/ui/button";
import { primaryAction } from "@/components/common/primary-action";
import { PaneHeader, PaneShell } from "@/components/layout/pane-shell";

export interface TaskBoardProps {
  onOpenTask: (taskId: string) => void;
}

export const TaskBoard = memo(function TaskBoard({ onOpenTask }: TaskBoardProps): JSX.Element {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
  const updateStatus = useUpdateTaskStatus();
  // Per-column render bound, local to THIS surface (#task:1885). Every write that
  // changes what the columns hold goes through `applyFilters` below, which resets
  // the window in the same commit.
  const { columnWindow, grow: growColumn, reset: resetColumnWindow } = useColumnWindow();
  const applyFilters = useCallback(
    (next: TaskFilters) => {
      setFilters(next);
      resetColumnWindow();
    },
    [resetColumnWindow],
  );

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
    ? channelOptions.find((o) => o.id === filters.channelId)?.label
    : null;

  // A task must name a channel; seed the create picker from the current channel
  // FILTER only when it resolves to a real member-channel option (a thread-scoped
  // or ALL filter has no channel to pre-select — the actor picks one). On success
  // the dialog closes and the list refreshes in place; the new task is NOT opened
  // in a detail modal (shiki 2026-07-30). The global board always PICKS a channel
  // — it never guesses a DM as the target (contract §5); a DM task is created only
  // from that direct line's own Tasks tab.
  const createTarget = useMemo<CreateTaskTarget>(() => {
    const defaultChannelId = channelOptions.some((o) => o.id === filters.channelId)
      ? filters.channelId
      : null;
    return { kind: "pick", channelOptions, defaultChannelId };
  }, [channelOptions, filters.channelId]);
  const submitCreate = useCreateTaskSubmit();

  return (
    <PaneShell>
      <PaneHeader
        icon={<TaskIcon data-sticker-size="sm" className="size-4 text-text-muted" />}
        title={selectedChannelName ? `Tasks in #${selectedChannelName}` : "All Tasks"}
        count={boardCountLabel(totalTaskCount(counts))}
        trailing={
          <span className="ml-auto text-(length:--text-badge) text-text-muted">
            {boardCountLabel(activeTaskCount(counts))} active
          </span>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
        <TaskFilterBar
          filters={filters}
          onChange={applyFilters}
          baselineFilters={DEFAULT_TASK_FILTERS}
          workspaceOptions={workspaceOptions}
          channelOptions={channelOptions}
          allChannelsLabel="All"
          people={people}
        />
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          {...primaryAction(`shrink-0 gap-1.5 ${FILTER_ROW_TRIGGER_BOX}`)}
        >
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>

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
    </PaneShell>
  );
});
