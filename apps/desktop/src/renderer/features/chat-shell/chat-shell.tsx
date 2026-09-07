import { useChatBrowse } from './use-chat-browse';
import { useWorkspaceActions } from './use-workspace-actions';
import { Sidebar } from '@/components/layout/Sidebar';
import { SectionLayer } from '@/components/layout/SectionLayer';
import { SavedListView } from '@/components/layout/SavedListView';
import { SearchPanel } from '@/components/layout/SearchPanel';
import { ArchivedChannelsPanel } from '@/components/layout/ArchivedChannelsPanel';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import {
  SIDEBAR_ANIMATE_LAYOUT,
  SIDEBAR_PERFORMANCE_VARIANT,
} from '@/sidebar-performance-experiment';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { CreateWorkspaceDialog } from '@/features/workspaces/CreateWorkspaceDialog';
import { CreateChannelDialog } from '@/features/workspaces/CreateChannelDialog';
import { WorkspaceSettingsDialog } from '@/features/workspaces/WorkspaceSettingsDialog';
import { workspaceCapabilities } from '@/features/workspaces/workspace-capabilities';
import type { ConversationShellModel } from '@/features/conversation-shell/use-conversation-shell';
import type { ConversationContent } from '@/features/conversation-shell/conversation-content';
import { ConversationStage } from '@/features/conversation-shell/conversation-stage';

export function ChatShell({
  model,
  content,
  fullscreen,
}: {
  model: ConversationShellModel['chat'];
  content: ConversationContent;
  fullscreen: boolean;
}) {
  const {
    route,
    nav,
    appSection,
    view,
    selectedWorkspaceId,
    directDraftAgentId,
    workspaceSidebarPane,
    workspaceSidebarVisible,
    workspaces,
    agentsById,
    savedItems,
    attentionBadges,
    resolveNavWorkspaceId,
    deferredSection,
    handleSelectWorkspace,
    handleSelectChannel,
    handleJumpToMessage,
    sidebarSelectedConversationId,
  } = model;

  const {
    createWorkspaceOpen,
    setCreateWorkspaceOpen,
    createChannelWorkspaceId,
    setCreateChannelWorkspaceId,
    workspaceSettingsId,
    setWorkspaceSettingsId,
    settingsWorkspace,
    createChannelWorkspace,
    handleWorkspaceDeleted,
  } = useWorkspaceActions(workspaces, selectedWorkspaceId);

  const {
    savedFilter,
    setSavedFilter,
    searchFilter,
    setSearchFilter,
    archivedFilter,
    setArchivedFilter,
  } = useChatBrowse();

  const sidebar = useResizableWidth({
    storageKey: 'silverhand.layout.sidebar-width',
    defaultWidth: 240,
    min: 230,
    max: 400,
    cssVar: '--sidebar-width',
  });

  return (
    <>
      {(appSection === 'chat' || deferredSection === 'chat') && (
        <SectionLayer visible>
          <>
            <div
              className="sidebar-slot"
              data-animating={
                SIDEBAR_ANIMATE_LAYOUT && workspaceSidebarPane.transitioning ? 'true' : undefined
              }
              data-performance-variant={SIDEBAR_PERFORMANCE_VARIANT}
              style={{
                flexBasis: workspaceSidebarVisible ? 'var(--sidebar-width)' : '0px',
                // When hidden, eat the right-side flex gap so the sheet's
                // `gap: var(--pane-gap)` doesn't render twice (once on
                // each side of the 0-width slot). Animates alongside
                // flex-basis so the collapse stays smooth end-to-end.
                marginRight: workspaceSidebarVisible ? '0px' : 'calc(-1 * var(--pane-gap))',
              }}
              // hidden subtree must not steal focus or grab pointer events
              // mid-slide; `inert` removes it from the a11y tree too.
              {...(workspaceSidebarVisible ? {} : { inert: '' })}
              aria-hidden={workspaceSidebarVisible ? undefined : true}
            >
              {workspaceSidebarPane.present ? (
                <div
                  className="sidebar-surface"
                  data-state={workspaceSidebarPane.surfaceState}
                  style={{ width: 'var(--sidebar-width)' }}
                >
                  <Sidebar
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
                    directDraftAgentId={directDraftAgentId}
                    onSelectDirectDraft={nav.toDirectDraft}
                    onCreateChannel={setCreateChannelWorkspaceId}
                    onOpenWorkspaceSettings={setWorkspaceSettingsId}
                    // STARRED is global, so the parent workspace is explicit —
                    // `handleSelectChannel` then opens a starred channel in another
                    // workspace with the SAME remembered-layout restore as its home
                    // row, instead of a bare jump.
                    onSelectConversation={(workspaceId, conversationId) =>
                      handleSelectChannel(conversationId, workspaceId)
                    }
                    onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
                    savedActive={view === 'saved'}
                    onSelectSaved={() => nav.toChatSaved()}
                    archivedActive={view === 'archived'}
                    onSelectArchived={() => nav.toChatArchived()}
                    searchActive={view === 'search'}
                    onSelectSearch={() => nav.toChatSearch()}
                    savedCount={savedItems?.length}
                  />
                </div>
              ) : null}
            </div>
            {/* Splitter stays mounted for the entire animation lifecycle —
             * keying it to `present` (not `visible`) avoids the 4 px
             * layout snap that happens if the splitter unmounts at frame
             * zero of the hide animation while the slot is still 220 ms
             * away from finishing its collapse. The splitter slides
             * leftward in lockstep with the slot's right edge and
             * unmounts together with the surface at the end. */}
            {workspaceSidebarPane.present ? (
              <VerticalSplitter onPointerDown={sidebar.startResize} active={sidebar.isDragging} />
            ) : null}
            {view === 'saved' ? (
              <SavedListView
                workspaces={workspaces}
                filter={savedFilter}
                onFilterChange={setSavedFilter}
                onJump={(params) => handleJumpToMessage(params)}
              />
            ) : view === 'search' ? (
              <SearchPanel
                workspaces={workspaces}
                initialQuery={route.searchQuery ?? undefined}
                filter={searchFilter}
                onFilterChange={setSearchFilter}
                onJumpMessage={(params) => handleJumpToMessage(params)}
                onOpenWorkspace={(id) => nav.toWorkspace(id)}
                onOpenConversation={(workspaceId, channelId) => {
                  const navWorkspaceId = resolveNavWorkspaceId(workspaceId, channelId);
                  if (!navWorkspaceId) {
                    return;
                  }
                  nav.toChannel(navWorkspaceId, channelId);
                }}
              />
            ) : view === 'archived' ? (
              <ArchivedChannelsPanel
                workspaces={workspaces}
                filter={archivedFilter}
                onFilterChange={setArchivedFilter}
                onOpenChannel={(workspaceId, channelId) => {
                  // Mirror SearchPanel: resolve through the same nav helper
                  // so a cross-workspace open lands on the right UI workspace
                  // item. For the archived aggregate `workspaceId` is already
                  // the channel's own workspace id (agent_home for a DM), so
                  // this is a no-op there — but it keeps both cross-workspace
                  // panels on one resolution path (#task:1145).
                  const navWorkspaceId = resolveNavWorkspaceId(workspaceId, channelId);
                  if (!navWorkspaceId) {
                    return;
                  }
                  nav.toChannel(navWorkspaceId, channelId);
                }}
                onOpenWorkspace={handleSelectWorkspace}
                onOpenWorkspaceSettings={setWorkspaceSettingsId}
              />
            ) : (
              <>
                <ConversationStage
                  content={content}
                  ready={deferredSection === 'chat'}
                  fullscreen={fullscreen}
                  storageKey="silverhand.layout.split-ratio"
                />
              </>
            )}
          </>
        </SectionLayer>
      )}{' '}
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={({ workspaceId, channelId }) => nav.toChannel(workspaceId, channelId)}
      />
      <CreateChannelDialog
        open={createChannelWorkspaceId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateChannelWorkspaceId(null);
          }
        }}
        workspaceId={createChannelWorkspace?.id ?? null}
        capabilities={workspaceCapabilities(createChannelWorkspace)}
        onCreated={(id) => {
          if (createChannelWorkspaceId) {
            nav.toChannel(createChannelWorkspaceId, id);
          }
        }}
      />
      <WorkspaceSettingsDialog
        key={workspaceSettingsId ?? 'closed'}
        open={workspaceSettingsId !== null && settingsWorkspace !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWorkspaceSettingsId(null);
          }
        }}
        workspaceId={settingsWorkspace?.id ?? null}
        workspaceName={settingsWorkspace?.name ?? null}
        capabilities={workspaceCapabilities(settingsWorkspace)}
        archivedAt={settingsWorkspace?.archived_at ?? null}
        onDeleted={() => {
          if (workspaceSettingsId) {
            handleWorkspaceDeleted(workspaceSettingsId);
          }
        }}
      />
    </>
  );
}
