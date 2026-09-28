import { useCallback, useRef } from "react";
import { useNav, useRouteState } from "@/router";
import { TaskDetailDialog } from "@/features/task-shell/components/task-detail-dialog";
import type { MessageJumpTarget } from "@/features/channels/use-message-jump-controller";
import { resolveTaskDetailSurface } from "@/features/task-shell/model/task-detail-surface";
import { TaskBoard } from "./task-board";

export function TaskShell({ onJump }: { onJump: (target: MessageJumpTarget) => boolean }) {
  const route = useRouteState();
  const nav = useNav();
  const openTaskRef = useRef(nav.openTask);
  openTaskRef.current = nav.openTask;

  const openTask = useCallback((taskId: string) => openTaskRef.current(taskId), []);
  const taskId = resolveTaskDetailSurface(route) === "dialog" ? route.taskDetailId : null;

  return (
    <>
      <TaskBoard onOpenTask={openTask} />
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
    </>
  );
}
