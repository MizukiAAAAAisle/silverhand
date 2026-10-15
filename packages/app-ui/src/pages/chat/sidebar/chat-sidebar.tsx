import { useListReadingPosition } from "@/navigation/view-memory";
import { Brandmark } from "@/components/brand/brandmark";
import { iconMarkup, nativeActionBar, useNativeBar } from "@/components/layout/native-page-bar";
import { SidebarRowsSkeleton } from "@/components/layout/sidebar-skeleton";
import type { DirectMessageTarget } from "@/features/direct-pairs/target";
import { useMemo, type ReactNode } from "react";
import { ArchiveIcon, BookmarkIcon, MoreIcon, PlusIcon, SearchIcon } from "@/icons";
import { AppDropdownMenu, AppDropdownMenuItem } from "@/components/menus/app-context-menu";
import type { AgentDto } from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  useAgentAvatarObjectUrls,
  type AgentAvatarSource,
} from "@/features/agents/hooks/avatar-hooks";
import { SortableGroup } from "@/components/layout/list-drag-sort";
import { SortableSidebarBranch } from "@/components/layout/sidebar-branch-drag";
import { useSidebarSort } from "../model/use-sidebar-sort";
import { sidebarBranches } from "../model/sidebar-branches";
import { WorkspaceBranch, type WorkspaceItem } from "./workspaces-panel";
import { FavoritesGroup } from "./favorites-panel";
import { DirectMessagesGroup } from "./direct-messages-panel";
import { useStarMembership } from "@/features/workspaces/favorites";
import { OUTER_GLYPH_INSET, sidebarRowStateClass } from "../../../components/layout/sidebar-shared";
import {
  partitionRailWorkspaces,
  type SelectedConversation,
} from "@/features/workspaces/home-grouping";
import { Sidebar } from "../../../components/layout/sidebar";
import { useSidebarStyle } from "@/features/conversation-shell/use-sidebar-style";
import { RecentList } from "./recent-list";

interface ChatSidebarProps {
  fill?: boolean;
  workspaces: WorkspaceItem[];
  workspacesLoading: boolean;
  /** Owner agents supply agent-space avatars. */
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** The workspace the primary pane is in. Since #task:1889 it never highlights
   *  anything — with `selectedChannelId` and the star fact it decides which
   *  collapsed container keeps the open row (see `branchHoldsSelectedRow`). */
  selectedWorkspaceId: string | null;
  /** The open conversation — the tree's ONE selection object: it FILLs its
   *  channel row (under its parent, or in STARRED when starred). */
  selectedChannelId: string | null;
  /** Open a channel in its own workspace (the merged tree's rows are
   *  cross-workspace, so the parent is always explicit). */
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  /** Start channel creation scoped to one workspace — the merged tree has no
   *  "current" workspace to imply. */
  onCreateChannel: (workspaceId: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  /** Open a `direct_pair` — a conversation with NO workspace coordinate.
   *  A separate handler from `onSelectConversation` because the two
   *  navigations land on different routes: passing a null workspace to the
   *  workspace-keyed one would either fabricate a coordinate or silently no-op. */
  onSelectDirectPair: (conversationId: string) => void;
  /** The participant whose pre-mint draft line is the open pane (`/chat/d/new/:agentId`),
   *  if any — the sidebar shows a transient row for it. Route state,
   *  not stored state: no pair exists yet. */
  directDraftTarget: DirectMessageTarget | null;
  /** Re-open that draft line. */
  onSelectDirectDraft: (target: DirectMessageTarget) => void;
  /** Open a conversation inside a given workspace. STARRED is global, so the
   *  parent workspace is explicit: the handler owns the cross-workspace open
   *  (remembered layout restore included), STARRED never a second nav model. */
  onSelectConversation: (workspaceId: string, conversationId: string) => void;
  onCreateWorkspace: () => void;
  /** When true, the Saved view is the active main view — channel rows
   *  appear unselected and the Saved entry highlights instead. */
  savedActive: boolean;
  onSelectSaved: () => void;
  /** Dedicated archived-channel index view under the chat section. */
  archivedActive: boolean;
  onSelectArchived: () => void;
  /** Dedicated global search view under the chat section. */
  searchActive: boolean;
  onSelectSearch: () => void;
  /** Live count from the saved-messages query cache. Pass undefined
   *  on first paint (before the query resolves) so the badge stays
   *  hidden instead of flashing 0. */
  savedCount: number | undefined;
  /** Open a reply inside its thread — the Recent list's rows can lead there. */
  onOpenThread: (target: {
    workspaceId: string | null;
    conversationId: string;
    threadRootId: string;
    messageId: string;
  }) => void;
}

export function ChatSidebar(props: ChatSidebarProps): JSX.Element {
  // Favorites watch all visible workspaces, including archived ones that may be restored.
  const { allVisibleIds: watchWorkspaceIds } = useMemo(
    () => partitionRailWorkspaces(props.workspaces),
    [props.workspaces],
  );

  // Resolve owner-agent avatar object URLs ONCE for the whole rail, over the
  // STABLE union of every owning agent (across every section, archived included)
  // from the RAW workspace set. Resolving over the raw set (not the home projection)
  // keeps the map identical across renders — so no avatar tears down + refetches (the
  // flash shiki saw came from per-section resolution churning when a row moved). The
  // raw set is the right basis because it is the one input that never changes with
  // ordering. #task:1146
  const ownerAvatarSources = useMemo<AgentAvatarSource[]>(() => {
    const agentsById = props.agentsById;
    if (!agentsById) {
      return [];
    }
    const out: AgentAvatarSource[] = [];
    for (const w of props.workspaces) {
      if (!w.owner_agent_id) {
        continue;
      }
      const agent = agentsById.get(w.owner_agent_id);
      if (!agent) {
        continue;
      }
      out.push({ id: agent.id, avatar_url: agent.avatar_url });
    }
    return out;
  }, [props.workspaces, props.agentsById]);

  const ownerAgentAvatarUrls = useAgentAvatarObjectUrls(ownerAvatarSources);

  const selectedStar = useStarMembership(props.selectedChannelId);
  const selected: SelectedConversation = {
    channelId: props.selectedChannelId,
    workspaceId: props.selectedWorkspaceId,
    starred: selectedStar,
  };

  const { order, reorder, pending, ready } = useSidebarSort();
  const branches = sidebarBranches(props.workspaces, order);
  const workspaceContext = {
    selected,
    onSelectChannel: props.onSelectChannel,
    onCreateChannel: props.onCreateChannel,
    onOpenWorkspaceSettings: props.onOpenWorkspaceSettings,
    agentsById: props.agentsById,
    ownerAgentAvatarUrls,
  };

  const readingPosition = useListReadingPosition("chat-list");
  const style = useSidebarStyle();
  // The compact list is the Chats root, titled like the other Tab roots. In the
  // Recent style the bar also takes the list's own entries: Search beside New
  // workspace, Saved and Archived behind the bar's menu.
  const recentEntries = style === "recent";
  const [chatsBar, chatsBarHandlers] = nativeActionBar(
    {
      title: "Chats",
      titleAction: null,
      largeTitle: true,
      tabs: null,
      addTabs: null,
      overflow: recentEntries ? { label: "More", icon: iconMarkup(MoreIcon) } : undefined,
    },
    [
      recentEntries
        ? {
            id: "search",
            label: "Search",
            icon: iconMarkup(SearchIcon),
            primary: true,
            run: props.onSelectSearch,
          }
        : null,
      {
        id: "create-workspace",
        label: "New workspace",
        icon: iconMarkup(PlusIcon),
        primary: true,
        run: props.onCreateWorkspace,
      },
      recentEntries
        ? {
            id: "saved",
            label: "Saved",
            icon: iconMarkup(BookmarkIcon),
            run: props.onSelectSaved,
          }
        : null,
      recentEntries
        ? {
            id: "archived",
            label: "Archived",
            icon: iconMarkup(ArchiveIcon),
            run: props.onSelectArchived,
          }
        : null,
    ],
  );
  const native = useNativeBar(props.fill ? chatsBar : null, chatsBarHandlers);

  return (
    <Sidebar
      name="workspaces"
      fill={props.fill}
      width="var(--sidebar-width)"
      sidebar={
        <>
          {native.active ? (
            native.clearance
          ) : (
            <header className="chat-sidebar-brand hidden h-14 shrink-0 items-center gap-2 px-2 text-text-primary">
              <Brandmark className="size-7 shrink-0" />
              <h1 className="text-xl font-bold">silverhand</h1>
            </header>
          )}
          <nav
            {...readingPosition}
            data-scroll-root
            className="scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 pr-1"
          >
            {style === "recent" ? (
              <>
                <RecentList
                  workspaces={props.workspaces}
                  selectedConversationId={props.selectedChannelId}
                  onSelectChannel={props.onSelectChannel}
                  onSelectDirectPair={props.onSelectDirectPair}
                  onOpenThread={props.onOpenThread}
                  actions={
                    native.active ? null : (
                      <RecentActions
                        searchActive={props.searchActive}
                        onSelectSearch={props.onSelectSearch}
                        savedActive={props.savedActive}
                        onSelectSaved={props.onSelectSaved}
                        savedCount={props.savedCount}
                        archivedActive={props.archivedActive}
                        onSelectArchived={props.onSelectArchived}
                      />
                    )
                  }
                />
              </>
            ) : (
              <>
                <div className="mb-3 space-y-1">
                  <SidebarNavigationButton
                    onClick={props.onSelectSearch}
                    active={props.searchActive}
                  >
                    <SearchIcon className="size-4" />
                    <span>Search</span>
                  </SidebarNavigationButton>

                  <SidebarNavigationButton onClick={props.onSelectSaved} active={props.savedActive}>
                    <BookmarkIcon
                      className={cn("size-4", props.savedActive ? "fill-current" : "")}
                    />
                    <span>Saved</span>
                    {props.savedCount !== undefined && props.savedCount > 0 ? (
                      <span
                        data-sidebar-count
                        className={cn(
                          "text-[10px] tabular-nums",
                          props.savedActive ? "text-text-nav-selected/70" : "text-text-muted",
                        )}
                      >
                        {props.savedCount}
                      </span>
                    ) : null}
                  </SidebarNavigationButton>

                  <SidebarNavigationButton
                    onClick={props.onSelectArchived}
                    active={props.archivedActive}
                  >
                    <ArchiveIcon className="size-4" />
                    <span>Archived</span>
                  </SidebarNavigationButton>
                </div>

                <SortableGroup ids={branches.map((branch) => branch.id)} onReorder={reorder}>
                  {branches.map((branch) => (
                    <SortableSidebarBranch
                      key={branch.id}
                      id={branch.id}
                      disabled={!ready || pending || branch.kind === "hidden"}
                    >
                      {branch.kind === "starred" ? (
                        <FavoritesGroup
                          selectedChannelId={props.selectedChannelId}
                          watchWorkspaceIds={watchWorkspaceIds}
                          onSelectConversation={props.onSelectConversation}
                        />
                      ) : branch.kind === "direct-messages" ? (
                        <DirectMessagesGroup
                          selectedChannelId={props.selectedChannelId}
                          onSelectDirectPair={props.onSelectDirectPair}
                          draftTarget={props.directDraftTarget}
                          onSelectDirectDraft={props.onSelectDirectDraft}
                        />
                      ) : branch.kind === "workspace" ? (
                        <WorkspaceBranch workspace={branch.workspace} ctx={workspaceContext} />
                      ) : null}
                    </SortableSidebarBranch>
                  ))}
                </SortableGroup>
                {props.workspacesLoading && props.workspaces.length === 0 ? (
                  <SidebarRowsSkeleton label="Loading workspaces" />
                ) : null}
              </>
            )}
            {native.active ? null : (
              <div
                data-sidebar-cta-slot
                className="sticky bottom-0 mt-auto shrink-0 bg-(--pane-bg,var(--bg-base)) px-1 pt-2"
              >
                <Button
                  type="button"
                  variant="neutral"
                  className="h-8 w-full"
                  data-sidebar-cta
                  onClick={props.onCreateWorkspace}
                >
                  <PlusIcon className="size-4" />
                  <span>New workspace</span>
                </Button>
              </div>
            )}
          </nav>
        </>
      }
    />
  );
}

/** Search opens a page rather than filtering in place, so it is an icon like
 *  the menu beside it, not a field. Saved and Archived are rare and wait in the
 *  menu. Both share the filter row, leaving the column to the conversations. */
function RecentActions(props: {
  searchActive: boolean;
  onSelectSearch: () => void;
  savedActive: boolean;
  onSelectSaved: () => void;
  savedCount: number | undefined;
  archivedActive: boolean;
  onSelectArchived: () => void;
}): JSX.Element {
  const elsewhere = props.savedActive || props.archivedActive;

  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Search"
        title="Search"
        aria-pressed={props.searchActive}
        onClick={props.onSelectSearch}
        className={cn(props.searchActive && "bg-bg-hover text-text-primary")}
      >
        <SearchIcon className="size-4" />
      </Button>
      <AppDropdownMenu
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="More"
            title="More"
            className={cn(elsewhere && "bg-bg-hover text-text-primary")}
          >
            <MoreIcon className="size-4" />
          </Button>
        }
      >
        <AppDropdownMenuItem
          icon={<BookmarkIcon className="size-3.5" />}
          trailing={
            props.savedCount !== undefined && props.savedCount > 0 ? (
              <span className="tabular-nums text-text-muted">{props.savedCount}</span>
            ) : undefined
          }
          onSelect={props.onSelectSaved}
        >
          Saved
        </AppDropdownMenuItem>
        <AppDropdownMenuItem
          icon={<ArchiveIcon className="size-3.5" />}
          onSelect={props.onSelectArchived}
        >
          Archived
        </AppDropdownMenuItem>
      </AppDropdownMenu>
    </div>
  );
}

interface SidebarNavigationButtonProps {
  active: boolean | undefined;
  onClick: () => void;
  children: ReactNode;
}

function SidebarNavigationButton({
  active,
  onClick,
  children,
}: SidebarNavigationButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "sidebar-row-border flex w-full items-center gap-2 border h-8 text-left text-sm font-medium leading-4",
        OUTER_GLYPH_INSET,
        sidebarRowStateClass(active),
      )}
    >
      {children}
    </button>
  );
}
