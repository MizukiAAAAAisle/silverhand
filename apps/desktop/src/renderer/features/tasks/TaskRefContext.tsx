import { createContext, useContext, type ReactNode } from 'react';

/**
 * Resolution context for inline `#task:<n>` sigils.
 *
 * Threaded through React context (rather than props) because Markdown
 * is rendered from many call sites (MessageItem, QuotedMessagePreview,
 * SystemMessage, SavedListView, AgentWorkspaceCard…) and prop-drilling
 * the workspace + open handler everywhere bloats the API surface.
 *
 * Consumers (the inline `TaskRef` chip) read `workspaceId` to scope
 * their `useTaskByNumber` lookup, and `onOpenTask` to open the task's
 * detail modal when the chip is clicked.
 *
 * Missing context → `TaskRef` renders inert text. That's deliberate:
 * Saved/Search list views render messages outside any conversation
 * context and have no obvious "open which workspace's task?" answer.
 */
export interface TaskRefContextValue {
  /** Workspace whose task numbers should resolve. Null disables
   *  resolution for the subtree (chips render inert). */
  workspaceId: string | null;
  /** Click handler — writes `?task=<task_id>`, which opens the task's
   *  detail modal (#task:1715). Takes the RESOLVED task id, so no
   *  workspace axis travels with it: a task id is globally unique and
   *  the human read gate is conversation access alone. `workspaceId`
   *  above is only for resolving the chip's `#<n>` to that id. */
  onOpenTask?: (taskId: string) => void;
}

const TaskRefContext = createContext<TaskRefContextValue | null>(null);

export function TaskRefContextProvider({
  value,
  children,
}: {
  value: TaskRefContextValue;
  children?: ReactNode;
}): JSX.Element {
  return (
    <TaskRefContext.Provider value={value}>{children}</TaskRefContext.Provider>
  );
}

export function useTaskRefContext(): TaskRefContextValue | null {
  return useContext(TaskRefContext);
}
