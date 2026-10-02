import { DEFAULT_TASK_FILTERS, type TaskFilters } from "../../features/tasks/model/task-filters";
import { SectionLayer } from "@/components/layout/section-layer";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCompactLayout } from "@/navigation/layout";
import { useNavigationDriver } from "@/navigation/provider";
import { TaskDetailPanel } from "@/features/tasks/components/task-detail-panel";
import { useNav, useRouteState } from "@/router";
import { TaskDetailDialog } from "@/pages/task/components/task-detail-dialog";
import type { MessageJumpTarget } from "@/features/channels/use-message-jump-controller";
import { resolveTaskDetailSurface } from "@/features/tasks/model/task-detail-surface";
import { TaskBoard } from "./task-board";

export function TaskShell({
  onJump,
  mounted = true,
  visible = true,
}: {
  onJump: (target: MessageJumpTarget) => boolean;
  mounted?: boolean;
  visible?: boolean;
}) {
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const route = useRouteState();
  const nav = useNav();
  const openTaskRef = useRef(nav.openTask);
  openTaskRef.current = nav.openTask;

  const openTask = useCallback((taskId: string) => openTaskRef.current(taskId), []);
  const taskId = resolveTaskDetailSurface(route) === "dialog" ? route.taskDetailId : null;
  const compact = useCompactLayout();
  const { registerLeaveGuard } = useNavigationDriver();
  const editingRef = useRef(false);
  const setEditing = useCallback((editing: boolean) => {
    editingRef.current = editing;
  }, []);
  const pageTaskId = compact ? taskId : null;

  useEffect(
    () => registerLeaveGuard(() => pageTaskId === null || !editingRef.current),
    [registerLeaveGuard, pageTaskId],
  );

  if (!mounted) return null;

  // Compact presents the task as a pushed page: the board stays mounted beneath
  // it to keep its scroll, and Back pops the same history entry that opened it.
  if (compact) {
    return (
      <SectionLayer visible={visible}>
        <div className={pageTaskId ? "hidden" : "contents"}>
          <TaskBoard filters={filters} onFiltersChange={setFilters} onOpenTask={openTask} />
        </div>
        {pageTaskId ? (
          <TaskDetailPanel
            key={pageTaskId}
            taskId={pageTaskId}
            onEditingChange={setEditing}
            onJump={(target) => {
              if (!onJump(target)) {
                nav.closeTask();
              }
            }}
          />
        ) : null}
      </SectionLayer>
    );
  }

  return (
    <SectionLayer visible={visible}>
      <TaskBoard filters={filters} onFiltersChange={setFilters} onOpenTask={openTask} />
      <TaskDetailDialog
        taskId={taskId}
        onOpenChange={(open) => {
          if (!open) {
            nav.closeTask();
          }
        }}
        onJump={(target) => {
          // A successful jump already replaces the task URL; closing again would undo it.
          if (!onJump(target)) {
            nav.closeTask();
          }
        }}
      />
    </SectionLayer>
  );
}
