import { createContext, useContext, type ReactNode } from 'react';

/**
 * Resolution context for inline `#task:<n>` sigils.
 *
 * Threaded through React context (rather than props) because Markdown
 * is rendered from many call sites (MessageItem, QuotedMessagePreview,
 * SystemMessage, AgentWorkspaceCard…) and prop-drilling
 * the workspace + open handler everywhere bloats the API surface.
 *
 * Consumers (the inline `TaskRef` chip) read the conversation-placement coords
 * (`workspaceId` + `conversationId`) to scope their `useTaskByNumber` lookup,
 * and `onOpenTask` to open the task's detail modal when the chip is clicked.
 *
 * Chat panes supply their board coordinates; missing context leaves references inert.
 */
export interface TaskRefContextValue {
  /** The conversation the sigil is rendered inside — the HTTP lookup anchor.
   *  The server derives its board and point-reads `(board_key, task_number)`,
   *  so a DirectPair task (no workspace) resolves through the pair conversation.
   *  Null disables resolution for the subtree (chips render inert). */
  conversationId: string | null;
  /** The board's workspace, when this conversation is workspace-placed; null for
   *  a DirectPair. Together with `conversationId` it projects the
   *  `TaskBoardCacheScope`, so sibling channels of one workspace board share a
   *  single by-number cache cell (a `task_changed` event reaches all of them).
   *  It is a CACHE coordinate only — the human read gate is conversation access
   *  alone, so no workspace scope travels to the server or to `onOpenTask`. */
  workspaceId: string | null;
  /** Click handler — writes `?task=<task_id>`, which opens the task's
   *  detail modal (#task:1715). Takes the RESOLVED task id, so no
   *  scope axis travels with it: a task id is globally unique and the
   *  human read gate is conversation access alone. `conversationId`
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
