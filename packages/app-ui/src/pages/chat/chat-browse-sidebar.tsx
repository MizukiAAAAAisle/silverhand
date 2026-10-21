import { ChatSidebar } from "./sidebar/chat-sidebar";
import type { WorkspaceActions } from "./use-workspace-actions";
import type { ChatShellModel } from "@/features/conversation-shell/conversation-shell-models";

/** The Chats browse sidebar wired to the shell model. Rendered docked by
 *  ChatShell and floating by the rail's hover peek. */
export function ChatBrowseSidebar({
  model,
  actions,
  fill = false,
}: {
  model: ChatShellModel;
  actions: WorkspaceActions;
  fill?: boolean;
}): JSX.Element {
  const {
    nav,
    view,
    selectedWorkspaceId,
    directDraftTarget,
    workspaces,
    workspacesLoading,
    agentsById,
    savedItems,
    attentionBadges,
    handleSelectChannel,
    handleJumpToMessage,
    sidebarSelectedConversationId,
  } = model;

  return (
    <ChatSidebar
      fill={fill}
      workspacesLoading={workspacesLoading}
      workspaces={workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        owner_agent_id: w.owner_agent_id,
        unread: attentionBadges?.by_workspace?.[w.id] ?? 0,
        // Both row signals come from the ONE roll-up (#task:1870):
        // the count and the mute marker must never disagree about
        // the same workspace.
        muted: attentionBadges?.muted_workspace_ids?.includes(w.id) ?? false,
        archived: w.archived_at !== null,
        created_at: w.created_at,
      }))}
      agentsById={agentsById}
      selectedWorkspaceId={selectedWorkspaceId}
      // The tree's ONE selection object. Carries forward the
      // secondary-pane preference the retired channel column owned;
      // `selectSidebarSelectedConversationId` holds the rule (a
      // resolved secondary owns the highlight only when its row is
      // in this sidebar — always true for a private line, which
      // lives in the workspace-independent DIRECT MESSAGES list).
      selectedChannelId={sidebarSelectedConversationId}
      onSelectChannel={handleSelectChannel}
      // A pair has no workspace to open it in, so it takes the
      // workspace-less route directly. No remembered-layout
      // restore: the panes that memory replays (thread /
      // threads-list / side) are channel-scoped, so there is
      // nothing recorded for a pair to restore (#task:2035).
      onSelectDirectPair={nav.toDirect}
      // The transient draft row (#task:2039) re-opens THE DRAFT,
      // never the pair: while the draft route is open that row is
      // the draft's (`mergeDirectLineRows`), and it holds unsent
      // text or a failed first send. Routing it through
      // `handleMessageAgent` — which prefers an existing pair —
      // would discard both (@Cindy, #task:2039 review).
      directDraftTarget={directDraftTarget}
      onSelectDirectDraft={nav.toDirectDraft}
      onCreateChannel={actions.setCreateChannelWorkspaceId}
      onOpenWorkspaceSettings={actions.setWorkspaceSettingsId}
      // STARRED is global, so the parent workspace is explicit —
      // `handleSelectChannel` then opens a starred channel in another
      // workspace with the SAME remembered-layout restore as its home
      // row, instead of a bare jump.
      onSelectConversation={(workspaceId, conversationId) =>
        handleSelectChannel(conversationId, workspaceId)
      }
      onCreateWorkspace={() => actions.setCreateWorkspaceOpen(true)}
      savedActive={view === "saved"}
      onSelectSaved={() => nav.toChatSaved()}
      archivedActive={view === "archived"}
      onSelectArchived={() => nav.toChatArchived()}
      searchActive={view === "search"}
      onSelectSearch={() => nav.toChatSearch()}
      savedCount={savedItems?.length}
      onOpenThread={(target) =>
        handleJumpToMessage({
          workspaceId: target.workspaceId ?? undefined,
          channelId: target.conversationId,
          threadRootId: target.threadRootId,
          messageId: target.messageId,
        })
      }
    />
  );
}
