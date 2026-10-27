import type { ChatShellModel } from "@/features/conversation-shell/conversation-shell-models";
import { ChatBrowseSidebar } from "./chat-browse-sidebar";
import { useWorkspaceActions } from "./use-workspace-actions";
import { WorkspaceActionDialogs } from "./workspace-action-dialogs";

/** The Chats sidebar as the rail's hover peek, with its own dialogs. */
export function ChatPeekSidebar({ model }: { model: ChatShellModel }): JSX.Element {
  const actions = useWorkspaceActions(model.workspaces, model.selectedWorkspaceId);

  return (
    <>
      <ChatBrowseSidebar model={model} actions={actions} />
      <WorkspaceActionDialogs actions={actions} />
    </>
  );
}
