import { useMemo } from 'react';
import { Archive, Bookmark, Plus, Search } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
  useAgentAvatarObjectUrls,
  type AgentAvatarSource,
} from '@/features/agents/avatar-hooks';
import {
  useSetSortMode,
  useWorkspaceSortState,
} from '@/features/workspaces/hooks';
import { sortModeOf } from '@/lib/viewer-sort';
import { railSortGroupOf, type RailSortGroup } from '@/features/workspaces/rail-sort-group';
import { useListDragSort } from './list-drag-sort';
import { SortModeMenu } from './SortModeMenu';
import {
  AGENT_SPACES_SECTION_GLYPH,
  WORKSPACES_SECTION_GLYPH,
  WorkspaceGroup,
  type WorkspaceItem,
  type WorkspaceSortConfig,
} from './WorkspacesPanel';
import { FavoritesGroup } from './FavoritesPanel';
import { DirectMessagesGroup } from './DirectMessagesPanel';
import { useStarMembership } from '@/features/favorites/hooks';
import { OUTER_GLYPH_INSET, sidebarRowStateClass } from './sidebar-shared';
import {
  partitionRailWorkspaces,
  type SelectedConversation,
} from '@/lib/home-grouping';
import { paneChrome } from './pane-chrome';

interface SidebarProps {
  workspaces: WorkspaceItem[];
  /** Workspace agents indexed by id. Threaded through to
   *  `WorkspaceGroup` so an agent space's row can resolve `owner_agent_id` and
   *  render the agent's uploaded avatar (or runtime icon fallback) instead of
   *  the generic User glyph. Optional — when absent, those rows fall back
   *  to the User icon. #task:919 */
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
  /** Open a `direct_pair` — a conversation with NO workspace coordinate
   *  (#task:2035). A separate handler from `onSelectConversation` because the two
   *  navigations land on different routes: passing a null workspace to the
   *  workspace-keyed one would either fabricate a coordinate or silently no-op. */
  onSelectDirectPair: (conversationId: string) => void;
  /** The agent whose pre-mint draft line is the open pane (`/chat/d/new/:agentId`),
   *  if any — the sidebar shows a transient row for it (#task:2039). Route state,
   *  not stored state: no pair exists yet. */
  directDraftAgentId: string | null;
  /** Re-open that draft line. */
  onSelectDirectDraft: (agentId: string) => void;
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

/** The rail is one sortable list (`list_key='workspaces'`) with two live hard
 *  groups by ownership (agent space / people-owned). Each group is its own mode
 *  scope (#task:1146). STARRED is NOT a rail partition — it is the global Favorites
 *  list (#task:1253/#task:1254), a separate read-model, and since #task:1888 it
 *  holds CONVERSATIONS, so no rail row ever moves into it. A starred container
 *  stays in its own group and is only PINNED to the top of it. See
 *  docs/list-sort-v1.md.
 *
 *  These group keys ARE `SortGroup` values — they travel to the server as the
 *  mode scope (`user_list_sort_mode.scope`) and as the manual-rank group — so the
 *  agent space's key is the STORED `'agent_space'` token (it was `'dm'` until
 *  #task:2045 Delta 4 moved schema, backend and rows together in migration v86).
 *  `railSortGroupOf` is the one translation. */
type RailGroup = RailSortGroup;

const railGroupKeyOf = (workspace: WorkspaceItem): RailGroup => railSortGroupOf(workspace);

export function Sidebar(props: SidebarProps): JSX.Element {
  // Home rail groups by OWNERSHIP (agent_space / regular). Containers have exactly
  // ONE ordering authority — the viewer's sort mode plus manual drag (#task:1900: the container
  // star was a second one, applied on top of the drag, and it is gone). Archived
  // workspaces are dropped outright (#task:1889): the top-level `Archived` entry is
  // the one archive index. `props.workspaces` is the RAW full visible set; these are
  // the home projections (see lib/home-grouping).
  //
  // `allVisibleIds` comes out of the SAME call, not a second derivation: it is
  // STARRED's freshness scope (every workspace the viewer can see, archived
  // included — a restore is exactly when a hidden star returns), and taking it from
  // the projections would silently disarm the parents that show nothing. It is
  // branded `FavoritesWatchScope` so that substitution does not typecheck — the
  // shapes were identical before, so the wrong wiring compiled green.
  const {
    agentSpaces: homeAgentSpaces,
    regular: homeRegular,
    allVisibleIds: watchWorkspaceIds,
  } = useMemo(() => partitionRailWorkspaces(props.workspaces), [props.workspaces]);

  // Resolve owner-agent avatar object URLs ONCE for the whole rail, over the
  // STABLE union of every owning agent (across every section, archived included)
  // from the RAW workspace set. Resolving over the raw set (not the home projection)
  // keeps the map identical across renders — so no avatar tears down + refetches (the
  // flash shiki saw came from per-section resolution churning when a row moved). The
  // raw set is the right basis because it is the one input that never changes with
  // ordering. #task:1146
  const ownerAvatarSources = useMemo<AgentAvatarSource[]>(() => {
    const agentsById = props.agentsById;
    if (!agentsById) return [];
    const out: AgentAvatarSource[] = [];
    for (const w of props.workspaces) {
      // The id itself, not `isAgentSpace`: this loop needs the agent to build an
      // avatar source, so the null check is the identity read, not the grouping
      // one (#task:2078).
      if (!w.owner_agent_id) continue;
      const agent = agentsById.get(w.owner_agent_id);
      if (!agent) continue;
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

  const { data: viewerSort } = useWorkspaceSortState();
  const setSortMode = useSetSortMode();
  const { orderedGroups, onReorder } = useListDragSort<
    RailGroup,
    WorkspaceItem
  >({
    listKey: 'workspaces',
    groups: { agent_space: homeAgentSpaces, regular: homeRegular },
    viewerSort,
    getId: w => w.id,
    getCreatedAt: w => w.created_at,
    modeScopeOf: g => g,
  });
  const orderedAgentSpaces = orderedGroups.agent_space;
  const orderedRegular = orderedGroups.regular;

  // Each rail section owns its own sort menu (reads + writes that group's scope)
  // and its own single-group drag config.
  const sortMenuFor = (group: RailGroup): JSX.Element => (
    <SortModeMenu
      mode={sortModeOf(viewerSort, group)}
      onChange={m => setSortMode.mutate({ list_key: 'workspaces', group, mode: m })}
    />
  );
  const sortConfigFor = (group: RailGroup): WorkspaceSortConfig<RailGroup> => ({
    order: [group],
    groupKeyOf: railGroupKeyOf,
    onReorder,
  });

  // Saved / Search / Archived are top-level views, and on those routes there is
  // no `/w/:id/c/:id` to parse — so `selectedChannelId` is ALREADY null and the
  // tree already shows no FILL. The old `topLevelViewActive` suppressor existed
  // only because a container row used to highlight off `selectedWorkspaceId`;
  // with the workspace header demoted to pure chrome (#task:1889) selection is
  // one object (the open conversation) and there is nothing left to suppress.

  return (
    <aside
      data-sidebar="workspaces"
      className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]"
      style={{ ...paneChrome, overflow: 'hidden' }}
    >
      <nav className="scrollbar-hide flex-1 overflow-y-auto py-1.5">
        <div className="mb-3 space-y-1">
          <button
            type="button"
            onClick={props.onSelectSearch}
            className={cn(
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border pr-2 h-8 text-left text-sm font-medium leading-4 ' +
                OUTER_GLYPH_INSET,
              sidebarRowStateClass(props.searchActive),
            )}
          >
            <Search className="size-4" />
            <span>Search</span>
          </button>

          <button
            type="button"
            onClick={props.onSelectSaved}
            className={cn(
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border pr-2 h-8 text-left text-sm font-medium leading-4 ' +
                OUTER_GLYPH_INSET,
              sidebarRowStateClass(props.savedActive),
            )}
          >
            <Bookmark
              className={cn(
                'size-4',
                props.savedActive ? 'fill-current' : '',
              )}
            />
            <span>Saved</span>
            {props.savedCount !== undefined && props.savedCount > 0 ? (
              <span
                data-sidebar-count
                className={cn(
                  'text-xs tabular-nums',
                  props.savedActive ? 'text-text-on-selected/70' : 'text-text-muted',
                )}
              >
                {props.savedCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={props.onSelectArchived}
            className={cn(
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border pr-2 h-8 text-left text-sm font-medium leading-4 ' +
                OUTER_GLYPH_INSET,
              sidebarRowStateClass(props.archivedActive),
            )}
          >
            <Archive className="size-4" />
            <span>Archived</span>
          </button>
        </div>

        <FavoritesGroup
          selectedChannelId={props.selectedChannelId}
          watchWorkspaceIds={watchWorkspaceIds}
          onSelectConversation={props.onSelectConversation}
        />
        <WorkspaceGroup
          label="WORKSPACES"
          icon={WORKSPACES_SECTION_GLYPH}
          workspaces={orderedRegular}
          selected={selected}
          onSelectChannel={props.onSelectChannel}
          onCreateChannel={props.onCreateChannel}
          onOpenWorkspaceSettings={props.onOpenWorkspaceSettings}
          headerAction={
            <span className="flex items-center">
              {sortMenuFor('regular')}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={props.onCreateWorkspace}
                aria-label="add WORKSPACES"
              >
                <Plus className="size-3.5" />
              </Button>
            </span>
          }
          emptyHint={
            <>
              No workspaces
            </>
          }
          agentsById={props.agentsById}
          ownerAgentAvatarUrls={ownerAgentAvatarUrls}
          sort={sortConfigFor('regular')}
          persistId="workspaces"
        />
        <DirectMessagesGroup
          selectedChannelId={props.selectedChannelId}
          onSelectDirectPair={props.onSelectDirectPair}
          draftAgentId={props.directDraftAgentId}
          onSelectDirectDraft={props.onSelectDirectDraft}
        />
        <WorkspaceGroup
          label="AGENT SPACES"
          icon={AGENT_SPACES_SECTION_GLYPH}
          workspaces={orderedAgentSpaces}
          selected={selected}
          onSelectChannel={props.onSelectChannel}
          onCreateChannel={props.onCreateChannel}
          onOpenWorkspaceSettings={props.onOpenWorkspaceSettings}
          emptyHint="No agents"
          agentsById={props.agentsById}
          ownerAgentAvatarUrls={ownerAgentAvatarUrls}
          headerAction={sortMenuFor('agent_space')}
          sort={sortConfigFor('agent_space')}
          persistId="dm"
        />
      </nav>
    </aside>
  );
}
