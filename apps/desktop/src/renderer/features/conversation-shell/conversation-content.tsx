import { ChannelView } from '@/components/layout/ChannelView';
import { ThreadPanel } from '@/components/layout/ThreadPanel';
import { ChannelThreadsPanel } from '@/components/layout/ChannelThreadsPanel';
import { ChannelAttachmentsPanel } from '@/components/layout/ChannelAttachmentsPanel';
import { directPairSenderSeed } from '@/features/search/advanced-search-seed';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { AgentView } from '@/features/agents/AgentView';
import { SideUnresolvedPlaceholder } from '@/components/layout/SideUnresolvedPlaceholder';
import { ConversationPaneCapabilitiesProvider } from '@/features/conversations/pane-capabilities-context';
import { DirectPairDraftPane } from '@/features/direct-pairs/DirectPairDraftPane';
import type { ConversationPanesModel } from './conversation-shell-models';

export function renderConversationPanes(model: ConversationPanesModel) {
  const {
    nav,
    selectedWorkspaceId,
    selectedChannelId,
    directDraftAgentId,
    threadRootId,
    agentPanelId,
    requestJump,
    workspaceNameById,
    archivePending,
    handleOpenAdvancedSearch,
    directPair,
    directPairLoadFailed,
    directPairNotFound,
    secondaryDescriptor,
    selectedChannel,
    parentMembership,
    channelIndexesAvailable,
    filesListMounted,
    threadsListMounted,
    parentChannelResolving,
    conversationRefsById,
    openTaskInPane,
    taskPaneId,
    setTaskPaneEditing,
    requestCloseTaskPane,
    paneAttachmentRequest,
    setPaneAttachmentRequest,
    handleOpenChannelByName,
    handleJumpToMessage,
    closeSecondary,
    handleMessageAgent,
    handleDraftOpenedPair,
    handleJumped,
    handleArchiveChannelMutation,
    handleRenameChannelMutation,
    handleSetChannelVisibilityMutation,
    handleLeaveChannelMutation,
    selectedChannelDescriptor,
    primaryPaneDescriptor,
    primaryPaneCapabilities,
    primaryPaneHasChannelNamespace,
    primaryThreadComposerDirectory,
    secondaryViewInputs,
    secondaryConversationDescriptor,
    handleArchiveSecondaryChannelMutation,
    handleRenameSecondaryChannelMutation,
    parentJumpTarget,
    secondaryJumpTarget,
    secondaryJumpPrimePending,
    threadJumpMessageId,
    parentJumpPrimePending,
    threadJumpPhase,
    handleOpenThreadFromChannel,
  } = model;
  const parentView = directDraftAgentId ? (
    // The pre-mint direct line (#task:2039). Its own pane rather than a
    // `ChannelView` with a synthetic descriptor: every conversation-keyed reader
    // ChannelView owns (messages, roster, read cursor, attachments) would be
    // asking about an id that does not exist yet. It renders the same chrome, and
    // the first send replaces this route with the pair's own.
    // Keyed by agent identity: the draft (and the send's error/pending state) is
    // ABOUT one agent, so `/new/A → /new/B` must remount rather than re-use the
    // instance. Without this, text written to A survives into B's pane and one
    // Enter sends it to the wrong agent (@Cindy, #task:2039 review).
    <DirectPairDraftPane
      key={directDraftAgentId}
      agentId={directDraftAgentId}
      onOpenPair={handleDraftOpenedPair}
    />
  ) : (
    <ChannelView
      hasChannelNamespace={primaryPaneHasChannelNamespace}
      workspaceName={workspaceNameById(primaryPaneDescriptor?.workspace_id ?? null)}
      conversation={primaryPaneDescriptor}
      resolving={parentChannelResolving}
      // The pair arm's failed read (#task:2035 B8): neither a loader nor "Select
      // a channel" would be true — the first promises an answer that is not
      // coming, the second claims the viewer chose nothing.
      loadFailed={directPairLoadFailed}
      // …and its ANSWERED absence: `/chat/d/<bad or no-longer-visible id>`. The
      // route named a conversation and the authority said no, so this is neither
      // a wait nor a failure nor "you chose nothing".
      notFound={directPairNotFound}
      parentTitle={null}
      jumpTarget={parentJumpTarget}
      jumpPrimePending={parentJumpPrimePending}
      onJumped={handleJumped}
      // Reply clusters resolve through the backend's `getChannelLike`, which
      // spans every top-level placement — a `direct_pair` included (#task:2096).
      // So the primary pane always offers "open thread"; `handleOpenThreadFromChannel`
      // already tolerates a workspace-less conversation (`selectedWorkspaceId ??
      // undefined`). Secondary panes withhold it at their own call sites.
      onOpenThread={handleOpenThreadFromChannel}
      // Threads-list pane toggle (#task:1073). The primary pane gets it for any
      // open top-level conversation — a workspace `channel` and a workspace-less
      // `direct_pair` alike carry a channel-scoped thread index (the backend's
      // threads route resolves via `getChannelLike`, #task:2096). `primaryPaneDescriptor`
      // is the resolved descriptor for whichever arm is open, so the toggle waits
      // for it rather than for the workspace arm specifically. Thread / dm-side /
      // `?side` *secondary* primaries don't get it (they aren't the index).
      onToggleThreadsList={
        channelIndexesAvailable && primaryPaneDescriptor != null ? nav.toggleThreadsList : undefined
      }
      threadsListActive={threadsListMounted}
      // Attachments-list pane toggle. Same gate as threads: any open top-level
      // conversation (channel or `direct_pair`) carries a channel-scoped
      // attachments index; thread / dm-side / `?side` secondary primaries don't.
      onToggleFilesList={
        channelIndexesAvailable && primaryPaneDescriptor != null ? nav.toggleFilesList : undefined
      }
      filesListActive={filesListMounted}
      // Tasks moved from the old header Tasks button to the per-conversation
      // Tasks TAB (#task:2121) — the manual opener is the tab, so the header no
      // longer carries a Tasks button (dual navigation removed).
      onArchiveChannel={handleArchiveChannelMutation}
      onRenameChannel={handleRenameChannelMutation}
      onSetChannelVisibility={handleSetChannelVisibilityMutation}
      onLeaveChannel={handleLeaveChannelMutation}
      archivePending={archivePending}
      conversationRefsById={conversationRefsById}
      onOpenConversationRef={nav.openSide}
      onOpenChannelRef={handleOpenChannelByName}
      onOpenTask={openTaskInPane}
      onJumpToMessage={handleJumpToMessage}
      onOpenAdvancedSearch={handleOpenAdvancedSearch}
      // Per-conversation view tabs — primary pane only. A Tasks-tab card opens
      // task detail through `onOpenTask` above, the same side pane an inline
      // `#task` chip uses.
      viewTabsEnabled
      // A md/html click in the sibling Attachments list opens here, in the
      // primary pane's previewer tab (#task:2122). The list hands the attachment
      // up; ChannelView applies the same previewable + tab-strip gate the message
      // card uses, or falls back to open-with-OS.
      openAttachmentRequest={paneAttachmentRequest}
      onAttachmentRequestConsumed={() => setPaneAttachmentRequest(null)}
    />
  );

  // Secondary pane render shapes:
  //   - Resolved `?side` — a channel/dm_channel in ANY workspace, or a private
  //     line (#task:2038) → real ChannelView. The conversation descriptor's
  //     `workspace_id` carries the *foreign* workspace for cross-workspace
  //     `?side`, so ChannelView's workspace-scoped hooks auto-target the right
  //     cache without a separate prop; for a private line it is null, which
  //     withholds those hooks entirely.
  //   - Loading / unauthorized / not_found / unresolved (the identity
  //     resolution named no conversation) → SideUnresolvedPlaceholder.
  //   - null → no secondary, render only `parentView`.
  let secondaryView: JSX.Element | null = null;
  if (agentPanelId) {
    // Agent side panel (`?agent=<id>`, #task:1189). Renders an agent's compact
    // panel beside the channel so chat + the agent's Activity show together
    // (dual-screen). It is NOT a conversation, so it sits ahead of the
    // `secondaryDescriptor`/thread/threads-list chain. It OVERLAYS the
    // thread / threads-list pane rather than replacing it: `withAgentQuery`
    // preserves `?thread` / `?threads` so closing the panel restores whatever
    // was open (#task:1433). `?side` is the exception — cleared on open,
    // because a secondary conversation feeds notification suppression and
    // must not stay "visible" while covered. Activity locks to the current
    // channel (A — shiki).
    secondaryView = (
      <AgentView
        key={`side-${agentPanelId}`}
        variant="side"
        agentId={agentPanelId}
        contextConversationId={selectedChannelId}
        contextWorkspaceId={selectedWorkspaceId ?? null}
        onClose={nav.closeAgentPanel}
        onDeleted={nav.closeAgentPanel}
        // The same DM entry the full page offers (@shiki, #task:2039): reaching an
        // agent through the side panel must not be the one way that loses it.
        onMessageAgent={handleMessageAgent}
      />
    );
  } else if (filesListMounted && selectedChannelId) {
    // Channel Attachments panel (`?files=1`). An OVERLAY utility pane, so it
    // sits just below the agent panel in precedence (agent > files > task >
    // side > thread > threads) and ahead of the conversation panes: opening it
    // preserves `?thread` / `?threads` in the URL (cleared only `?side` /
    // `?agent`), so closing it reveals whatever conversation pane was
    // underneath — the URL is the restore stack (same model as `?agent`,
    // #task:1433). Not a conversation, so it doesn't feed
    // `secondaryDescriptor` / notification suppression. The row's main
    // click previews/opens the attachment; a separate locate button jumps
    // to the source message via the shared `handleJumpToMessage`.
    secondaryView = (
      <ChannelAttachmentsPanel
        channelId={selectedChannelId}
        // Null for a `direct_pair` (no workspace coordinate). The panel's core
        // attachments read is channel-scoped; the workspace only scopes the
        // sender-filter directory, which already treats null as "workspace-less"
        // (#task:2096).
        workspaceId={selectedWorkspaceId ?? null}
        parentTitle={selectedChannel?.title ?? null}
        onClose={nav.closeFilesList}
        onJumpToMessage={handleJumpToMessage}
        // md/html rows open in the primary pane's in-app previewer tab
        // (#task:2122) instead of open-with-OS. A fresh wrapper per click so a
        // re-click of the same file re-fires the one-shot (App.is-equal state
        // would otherwise swallow it). ChannelView owns the previewable/gate
        // decision; images (lightbox) and other files stay panel-local.
        onOpenAttachment={(attachment) =>
          setPaneAttachmentRequest({
            conversationId: selectedChannelId,
            attachment,
          })
        }
      />
    );
  } else if (taskPaneId && selectedChannelId) {
    // Task detail pane (`?task=<id>`, #task:1721). An OVERLAY pane like `?agent`
    // / `?files`: opening it cleared `?side` and the other overlays but PRESERVED
    // `?thread` / `?threads`, so it renders ahead of the side/thread/threads
    // chain and closing it reveals whatever conversation pane was underneath (the
    // URL is the restore stack). Not a conversation, so it doesn't feed
    // `secondaryDescriptor` / notification suppression. Rendered whenever this
    // pointer's frozen host is `pane`.
    secondaryView = (
      <TaskDetailPanel
        key={`task-${taskPaneId}`}
        taskId={taskPaneId}
        onClose={requestCloseTaskPane}
        onEditingChange={setTaskPaneEditing}
      />
    );
  } else if (secondaryDescriptor) {
    if (secondaryDescriptor.source === 'side' && secondaryDescriptor.status !== 'resolved') {
      secondaryView = (
        <SideUnresolvedPlaceholder
          conversationId={secondaryDescriptor.id}
          status={secondaryDescriptor.status}
          onClose={closeSecondary}
        />
      );
    } else if (secondaryConversationDescriptor) {
      secondaryView = (
        <ChannelView
          hasChannelNamespace={secondaryViewInputs.hasChannelNamespace}
          workspaceName={workspaceNameById(secondaryConversationDescriptor.workspace_id)}
          conversation={secondaryConversationDescriptor}
          parentTitle={null}
          jumpTarget={secondaryJumpTarget}
          jumpPrimePending={secondaryJumpPrimePending}
          onJumped={handleJumped}
          onCloseChild={closeSecondary}
          // The secondary pane only ever renders a channel/dm `?side`
          // overlay, so the close affordance is the generic
          // "Close side pane" — never the thread wording.
          closeLabel="Close side pane"
          isFullscreen={false}
          // PR-2: cross-workspace archive invalidation — the secondary
          // pane uses a dedicated callback so the React Query
          // invalidation targets the foreign workspace's channels list,
          // not the primary's.
          onArchiveChannel={handleArchiveSecondaryChannelMutation}
          onRenameChannel={handleRenameSecondaryChannelMutation}
          archivePending={archivePending}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={nav.openSide}
          onOpenChannelRef={handleOpenChannelByName}
          onOpenTask={openTaskInPane}
          // No thread open from the secondary pane: a reply cluster shares
          // its parent channel's context, so opening a thread only makes
          // sense from the primary channel pane. Undefined hides the reply
          // affordance on the side secondary pane.
          onOpenThread={undefined}
        />
      );
    }
  } else if (threadRootId && selectedChannelId) {
    // Thread pane (`?thread=<rootMessageId>`). A thread is NOT a
    // conversation — it shares the parent channel's context — so it does
    // not flow through `secondaryDescriptor`/`ChannelView`. It renders
    // only when no side/threads-list secondary is present (those win),
    // matching the nav-layer mutual exclusion (`openThread` clears `?side`).
    // A `direct_pair`'s reply cluster resolves via `getChannelLike` too, so it
    // mounts here with a null workspace — no workspace coordinate is required
    // (#task:2096); the panel's workspace-scoped facets already accept null.
    //
    // Captured into consts so the `onViewInChannel` closure keeps the
    // narrowed types (TS widens branch-narrowed `let`s back to
    // nullable inside a deferred callback).
    const threadChannelId = selectedChannelId;
    const threadWorkspaceId = selectedWorkspaceId ?? null;
    const threadRoot = threadRootId;
    secondaryView = (
      // The thread's affordances are the PARENT conversation's, provided here
      // because this pane does not flow through `ChannelView` and so would
      // otherwise read the context default — which is channel-shaped, and made a
      // DM thread start a roster read and answer `Not here` for an agent the
      // mainline showed as Online (#task:2098). Presence is not keyed by
      // placement; the roster's `Not here` answer is the one thing this gates.
      <ConversationPaneCapabilitiesProvider value={primaryPaneCapabilities}>
        <ThreadPanel
          channelId={threadChannelId}
          workspaceId={threadWorkspaceId}
          // The composer's `@`/`#` directory is INHERITED from the parent
          // conversation (#task:2147) — projected once by App from the same
          // descriptor `primaryPaneCapabilities` uses, never re-derived in the leaf.
          // A `direct_pair` parent yields the `viewer` arm (the viewer's own agents
          // + every channel they're in); a workspace parent yields that workspace's
          // members/channels; a null parent yields `withheld`, so a cold DM-thread
          // deep link never assumes a channel namespace.
          directory={primaryThreadComposerDirectory}
          rootMessageId={threadRoot}
          onOpenAttachment={(attachment) =>
            setPaneAttachmentRequest({
              conversationId: threadChannelId,
              attachment,
            })
          }
          parentTitle={selectedChannel?.title ?? null}
          closed={selectedChannelDescriptor?.closed_at != null}
          archived={selectedChannelDescriptor?.archived_at != null}
          // Thread reply/follow/react/save are member mutations.
          // Participation follows the PARENT channel's membership, and the panel
          // takes the gate ALREADY DERIVED from it (same object ChannelView's own
          // hook produces) so the two panes can't drift: `unknown` yields neither
          // composer nor Join, and the panel derives nothing itself.
          gate={parentMembership.gate}
          onClose={nav.closeThread}
          onViewInChannel={() => {
            // Scroll-locate + flash the root in the main channel stream,
            // then drop the thread pane so the channel is unobstructed.
            requestJump({
              workspaceId: threadWorkspaceId ?? undefined,
              channelId: threadChannelId,
              messageId: threadRoot,
            });
            nav.closeThread();
          }}
          // Same inline-ref resolution + nav handlers the channel pane
          // gets, so thread replies render `#conv:` / `#<channel>` /
          // `#task:` sigils identically (#task:1052).
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={nav.openSide}
          onOpenChannelRef={handleOpenChannelByName}
          onOpenTask={openTaskInPane}
          jumpMessageId={threadJumpMessageId}
          jumpPhase={threadJumpPhase}
          onJumped={handleJumped}
          onJumpToMessage={handleJumpToMessage}
          onOpenAdvancedSearch={handleOpenAdvancedSearch}
          // A DM thread's find seeds the SAME sender the mainline pair seeds
          // (#task:2114). Read from the pair carrier rather than projected from a
          // pane mode, for the reason the capabilities comment above gives: a
          // thread has no placement of its own. Null on the channel arm, where
          // `workspaceId` above is the expressible narrowing instead.
          advancedSearchSender={directPairSenderSeed(directPair?.counterpart)}
        />
      </ConversationPaneCapabilitiesProvider>
    );
  } else if (threadsListMounted && selectedChannelId) {
    // Channel Threads-list pane (`?threads=1`, #task:1073). Like a single
    // thread it is NOT a conversation — it is a channel-scoped index — so it
    // renders here rather than through `secondaryDescriptor`/`ChannelView`,
    // and only when no side/thread secondary is present (those win, matching
    // the nav-layer mutual exclusion in `withThreadsQuery`). Opening a row
    // calls `nav.openThread`, which clears `?threads` and swaps in the
    // ThreadPanel for that thread.
    secondaryView = (
      <ChannelThreadsPanel
        channelId={selectedChannelId}
        parentTitle={selectedChannel?.title ?? null}
        onClose={nav.closeThreadsList}
        onOpenThread={nav.openThread}
      />
    );
  }

  return { primary: parentView, secondary: secondaryView };
}
export type ConversationContent = ReturnType<typeof renderConversationPanes>;
