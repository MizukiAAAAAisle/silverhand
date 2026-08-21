import { useCallback, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TaskFilters } from '@/features/tasks/taskFilters';
import { cn } from '@/lib/cn';
import { useUpdateTaskStatus } from '@/features/tasks/hooks';
import { useKanbanColumnCollapse } from '@/features/tasks/useKanbanColumnCollapse';
import { useTaskFilterOptions } from '@/features/tasks/useTaskFilterOptions';
import {
  useBoardColumns,
  useBoardCounts,
  useBoardFacets,
} from '@/features/tasks/useBoard';
import { useColumnWindow } from '@/features/tasks/useColumnWindow';
import {
  taskContainerBaseline,
  taskContainerKey,
  type TaskBoardContainer,
} from '@/features/tasks/taskContainer';
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

/**
 * The conversation's Tasks tab (#task:2121) — the five-column status kanban
 * rendered INLINE in the main pane, scoped to the conversation it opens in.
 *
 * The board BODY is the shared {@link TaskBoardColumns} — the same columns,
 * cards, drag/drop, collapse and paging the global section renders, so the two
 * surfaces cannot drift. This tab only supplies the SHELL: the filter bar
 * pre-focused on this conversation's CONTAINER
 * (`taskContainerBaseline` — a workspace channel anchors workspace + channel, a
 * direct line anchors its own conversation and mints no workspace), the create
 * entrance, and the main-pane fill vocabulary (columns `bg-bg-primary`, cards
 * `bg-bg-base`). Both filters stay switchable; Clear restores the baseline, not
 * global All.
 *
 * Render-window bound is surface-local: this board owns its own
 * (`useColumnWindow`) so its scrolling never inflates the global section's
 * mount cost.
 */
export interface ChannelTasksTabProps {
  container: TaskBoardContainer;
  /** Opens a task's detail modal (App writes `?task=<id>`) — the same one modal
   *  every board card shares. */
  onOpenTask: (taskId: string) => void;
}

export function ChannelTasksTab({
  container,
  onOpenTask,
}: ChannelTasksTabProps): JSX.Element {
  const baselineFilters = useMemo<TaskFilters>(
    () => taskContainerBaseline(container),
    // Keyed on the container's VALUE, not the prop's identity — a carrier
    // refetch returns equal facts as fresh objects (see taskContainer.ts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskContainerKey(container)],
  );
  const [filters, setFilters] = useState<TaskFilters>(baselineFilters);
  // Re-seed the filters when the container changes (switching conversations
  // remounts this tab, but keep the reset explicit for the in-place case).
  const prevKey = useRef(taskContainerKey(container));
  const currentKey = taskContainerKey(container);
  if (prevKey.current !== currentKey) {
    prevKey.current = currentKey;
    setFilters(baselineFilters);
  }

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

  const { workspaceOptions, channelOptions } = useTaskFilterOptions();
  const { isCollapsed, toggle: toggleCollapse } = useKanbanColumnCollapse();

  const columns = useBoardColumns({
    filters,
    enabled: true,
    window: columnWindow,
    isCollapsed,
  });
  const counts = useBoardCounts(filters);
  const people = useBoardFacets(filters);
  const updateStatus = useUpdateTaskStatus();

  const [createOpen, setCreateOpen] = useState(false);
  const submitCreate = useCreateTaskSubmit();
  // A direct line creates ONTO the pair conversation (no channel to pick,
  // contract §5); a workspace board offers the picker seeded from the current
  // channel filter when it resolves to a real member-channel option.
  const createTarget = useMemo<CreateTaskTarget>(() => {
    if (container.kind === 'direct_pair') {
      return { kind: 'locked', conversationId: container.conversationId };
    }
    const defaultChannelId = channelOptions.some(o => o.id === filters.channelId)
      ? filters.channelId
      : null;
    return { kind: 'pick', channelOptions, defaultChannelId };
  }, [container, channelOptions, filters.channelId]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-bg-base')}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2">
        <TaskFilterBar
          filters={filters}
          onChange={applyFilters}
          baselineFilters={baselineFilters}
          workspaceOptions={workspaceOptions}
          channelOptions={channelOptions}
          allChannelsLabel="ALL"
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
        onStatusChange={(taskId, status) => updateStatus.mutate({ taskId, status })}
        columnClassName="bg-bg-primary"
        cardClassName="bg-bg-base"
      />

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={createTarget}
        onSubmit={submitCreate}
      />
    </div>
  );
}
