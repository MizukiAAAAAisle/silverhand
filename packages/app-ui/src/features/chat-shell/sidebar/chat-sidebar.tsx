import { useListReadingPosition } from "@/navigation/view-memory";
import { Brandmark } from "@/components/brand/brandmark";
import { SidebarRowsSkeleton } from "@/components/layout/sidebar-skeleton";
import type { DirectMessageTarget } from "@/features/direct-pairs/target";
import { useMemo, type ReactNode } from "react";
import { Archive, Bookmark, Plus, Search } from "lucide-react";
import type { AgentDto } from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  useAgentAvatarObjectUrls,
  type AgentAvatarSource,
} from "@/features/agent-shell/hooks/avatar-hooks";
import { SortableGroup } from "@/components/layout/list-drag-sort";
import { SortableSidebarBranch } from "@/components/layout/sidebar-branch-drag";
import { useSidebarSort } from "../model/use-sidebar-sort";
import { sidebarBranches } from "../model/sidebar-branches";
import { WorkspaceBranch, type WorkspaceItem } from "./workspaces-panel";
import { FavoritesGroup } from "./favorites-panel";
import { DirectMessagesGroup } from "./direct-messages-panel";
import { useStarMembership } from "@/features/favorites/hooks";
import { OUTER_GLYPH_INSET, sidebarRowStateClass } from "../../../components/layout/sidebar-shared";
import {
  partitionRailWorkspaces,
  type SelectedConversation,
} from "@/features/chat-shell/model/home-grouping";
import { Sidebar } from "../../../components/layout/sidebar";

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
  return (
    <Sidebar
      name="workspaces"
      fill={props.fill}
      width="var(--sidebar-width)"
      sidebar={
        <>
          <header className="chat-sidebar-brand hidden h-14 shrink-0 items-center gap-2 px-2 text-text-primary">
            <Brandmark className="size-7 shrink-0" />
            <h1 className="text-xl font-bold">silverhand</h1>
          </header>
          <nav
            {...readingPosition}
            data-scroll-root
            className="scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 pr-1"
          >
            <div className="mb-3 space-y-1">
              <SidebarNavigationButton onClick={props.onSelectSearch} active={props.searchActive}>
                <Search className="size-4" />
                <span>Search</span>
              </SidebarNavigationButton>

              <SidebarNavigationButton onClick={props.onSelectSaved} active={props.savedActive}>
                <Bookmark className={cn("size-4", props.savedActive ? "fill-current" : "")} />
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
                <Archive className="size-4" />
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
            <div
              data-sidebar-cta-slot
              className="sticky bottom-0 mt-auto shrink-0 bg-(--pane-bg,var(--bg-base)) px-1 pt-2"
            >
              <Button
                type="button"
                variant="primary"
                className="h-8 w-full"
                data-sidebar-cta
                onClick={props.onCreateWorkspace}
              >
                <Plus className="size-4" />
                <span>New workspace</span>
              </Button>
            </div>
          </nav>
        </>
      }
    />
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
