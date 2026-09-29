import { DEFAULT_TASK_FILTERS, type TaskFilters } from "./model/task-filters";
import { SectionLayer } from "@/components/layout/section-layer";
import { useCallback, useRef, useState } from "react";
import { useNav, useRouteState } from "@/router";
import { TaskDetailDialog } from "@/features/task-shell/components/task-detail-dialog";
import type { MessageJumpTarget } from "@/features/channels/use-message-jump-controller";
import { resolveTaskDetailSurface } from "@/features/task-shell/model/task-detail-surface";
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

  if (!mounted) return null;
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
