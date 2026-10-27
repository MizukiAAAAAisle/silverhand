import { type MessageDto, readTaskSystemMetadataPartial } from "@silverhand/shared";

export interface TaskEventFold {
  /** Stable React key: the run's first event. */
  key: string;
  /** Oldest first; the last one is what the folded line shows. */
  events: MessageDto[];
}

/** Splits an activity run into folds of consecutive events on the same task. An
 *  event that names no task stands alone. */
export function foldTaskRuns(messages: readonly MessageDto[]): TaskEventFold[] {
  const folds: TaskEventFold[] = [];
  let lastTask: number | null = null;

  for (const message of messages) {
    const task = readTaskSystemMetadataPartial(message.metadata)?.task_number ?? null;
    const current = folds[folds.length - 1];
    if (current && task !== null && task === lastTask) {
      current.events.push(message);
    } else {
      folds.push({ key: message.id, events: [message] });
    }
    lastTask = task;
  }

  return folds;
}
