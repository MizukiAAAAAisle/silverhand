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
 * their `useTaskByNumber` lookup, and `onOpenTask` to dispatch the
 * Tasks-drawer focus when the chip is clicked.
 *
 * Missing context → `TaskRef` renders inert text. That's deliberate:
 * Saved/Search list views render messages outside any conversation
 * context and have no obvious "open which workspace's task?" answer.
 */
export interface TaskRefContextValue {
  /** Workspace whose task numbers should resolve. Null disables
   *  resolution for the subtree (chips render inert). */
  workspaceId: string | null;
  /** Click handler — typically writes `?task=<n>` and opens the
   *  Tasks drawer focused on the target row. */
  onOpenTask?: (taskNumber: number) => void;
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
