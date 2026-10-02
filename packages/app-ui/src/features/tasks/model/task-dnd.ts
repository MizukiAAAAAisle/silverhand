import type { TaskStatus } from "@silverhand/shared";

/**
 * Shared drag-and-drop contract for task cards → status columns
 * (#task:779). Both surfaces — the global section (`TasksSection`) and the
 * per-conversation Tasks tab (`ChannelTasksTab`) —
 * use native HTML5 drag/drop — no extra dependency — so this module is
 * the single source of the payload shape + (de)serialization, keeping the
 * two surfaces from drifting.
 *
 * A custom MIME type (not `text/plain`) so an accidental drop of selected
 * text or an external item never parses as a task move, and so dragover
 * can cheaply assert "this is one of ours".
 */
export const TASK_DND_MIME = "application/x-silverhand-task";

export interface TaskDragPayload {
  taskId: string;
  /** Status the card was dragged FROM — lets a column drop short-circuit
   *  to a no-op when the source and target status match (Cindy review:
   *  don't fire a meaningless status mutation). */
  from: TaskStatus;
}

export function writeTaskDrag(dataTransfer: DataTransfer, payload: TaskDragPayload): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(TASK_DND_MIME, JSON.stringify(payload));
}

/** Parse a drop's payload; returns null when the drag isn't one of ours
 *  or the data is malformed. */
export function readTaskDrag(dataTransfer: DataTransfer): TaskDragPayload | null {
  const raw = dataTransfer.getData(TASK_DND_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TaskDragPayload>;
    if (typeof parsed.taskId === "string" && typeof parsed.from === "string") {
      return { taskId: parsed.taskId, from: parsed.from as TaskStatus };
    }
  } catch {
    // malformed — fall through to null
  }
  return null;
}

/** True when a dragover event carries a task drag (so a column can
 *  preventDefault to accept the drop without inspecting the payload —
 *  the payload is only readable on drop, not dragover, in some browsers). */
export function isTaskDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TASK_DND_MIME);
}
