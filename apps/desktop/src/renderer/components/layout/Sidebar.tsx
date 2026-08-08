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
import { useListDragSort } from './list-drag-sort';
import { SortModeMenu } from './SortModeMenu';
import {
  WorkspaceGroup,
  type WorkspaceItem,
  type WorkspaceSortConfig,
} from './WorkspacesPanel';
import { FavoritesGroup } from './FavoritesPanel';
import { useStarMembership } from '@/features/favorites/hooks';
import { OUTER_GLYPH_INSET, sidebarRowStateClass } from './sidebar-shared';
import {
  partitionRailWorkspaces,
  type SelectedConversation,
} from '@/lib/home-grouping';

interface SidebarProps {
  workspaces: WorkspaceItem[];
  /** Workspace agents indexed by id. Threaded through to
   *  `WorkspaceGroup` so DM rows can resolve `dm_agent_id` and render
   *  the agent's uploaded avatar (or runtime icon fallback) instead of
   *  the generic User glyph. Optional — when absent, DM rows fall back
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
 *  groups by kind (DM / regular); never stored. Each group is its own mode scope
 *  (#task:1146). STARRED is NOT a rail partition — it is the global Favorites
 *  list (#task:1253/#task:1254), a separate read-model, and since #task:1888 it
 *  holds CONVERSATIONS, so no rail row ever moves into it. A starred container
 *  stays in its kind group and is only PINNED to the top of it. See
 *  docs/list-sort-v1.md. */
type RailGroup = 'dm' | 'regular';

function railGroupKeyOf(workspace: WorkspaceItem): RailGroup {
  return workspace.kind === 'dm' ? 'dm' : 'regular';
}

export function Sidebar(props: SidebarProps): JSX.Element {
  // Home rail groups by KIND (DM / regular). Containers have exactly ONE ordering
  // authority — the viewer's sort mode plus manual drag (#task:1900: the container
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
    dms: homeDms,
    regular: homeRegular,
    allVisibleIds: watchWorkspaceIds,
  } = useMemo(() => partitionRailWorkspaces(props.workspaces), [props.workspaces]);

  // Resolve DM-agent avatar object URLs ONCE for the whole rail, over the
  // STABLE union of every DM agent (across dm / regular / archived) from the RAW
  // workspace set. Resolving over the raw set (not the home projection) keeps the
  // map identical across renders — so no avatar tears down + refetches (the flash
  // shiki saw came from per-section resolution churning when a row moved). The raw
  // set is the right basis because it is the one input that never changes with
  // ordering. #task:1146
  const dmAvatarSources = useMemo<AgentAvatarSource[]>(() => {
    const agentsById = props.agentsById;
    if (!agentsById) return [];
    const out: AgentAvatarSource[] = [];
    for (const w of props.workspaces) {
      if (w.kind !== 'dm' || !w.dm_agent_id) continue;
      const agent = agentsById.get(w.dm_agent_id);
      if (!agent) continue;
      out.push({ id: agent.id, avatar_url: agent.avatar_url });
    }
    return out;
  }, [props.workspaces, props.agentsById]);
  const dmAgentAvatarUrls = useAgentAvatarObjectUrls(dmAvatarSources);

  // The tree's selection, composed ONCE here, because the third field can only be
  // answered above the sections: whether the open conversation has moved into
  // STARRED (#task:1888) decides WHICH container renders its row, and therefore
  // which collapsed container may keep it (`branchHoldsSelectedRow`). Reading it
  // from the parent's own channel list would be circular — that list is the thing
  // being decided about. A cache observer, not a second owner of the favorites
  // freshness scope: `FavoritesGroup` below still owns it. It is tri-state, and
  // stays tri-state all the way to the predicate: collapsing "the list hasn't
  // answered" into "not starred" here would put the guess back (#task:1901).
  const selectedStar = useStarMembership(props.selectedChannelId);
  const selected: SelectedConversation = {
    channelId: props.selectedChannelId,
    workspaceId: props.selectedWorkspaceId,
    starred: selectedStar,
  };

  // Per-user rail ordering (#task:1146). The whole rail is ONE list; the drag
  // state machine (synchronous drop override, settle guard) lives in the shared
  // useListDragSort — the same hook the channel sidebar uses, so the CDP-tuned
  // drop invariants can't drift between the two surfaces.
  // `modeScopeOf: g => g` makes each section its own [recent|manual] scope.
  const { data: viewerSort } = useWorkspaceSortState();
  const setSortMode = useSetSortMode();
  const { orderedGroups, onReorder } = useListDragSort<
    RailGroup,
    WorkspaceItem
  >({
    listKey: 'workspaces',
    groups: { dm: homeDms, regular: homeRegular },
    viewerSort,
    getId: w => w.id,
    getCreatedAt: w => w.created_at,
    modeScopeOf: g => g,
  });
  const orderedDms = orderedGroups.dm;
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
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      <nav className="scrollbar-hide flex-1 overflow-y-auto py-1.5">
        {/* App-level tool entries (Search/Saved/Archived). Kept a SOFT group:
          * tight inner gap + `mb-3` below (matching the inter-section `pb-3`)
          * to separate them from the workspace nav by spacing alone — no hard
          * divider, which read as odd above just three entries (#task:1159,
          * shiki review).
          *
          * No `transition-colors`: these rows carry the SAME selected classes as
          * channel/workspace rows, so selection must commit instantly here too —
          * fading a discrete committed state is the flicker (#task:1162). Keeps
          * all three sidebar row classes (rail / channel / tool) one row-language.
          *
          * Their glyphs sit on the OUTER column (`OUTER_GLYPH_INSET`,
          * #task:1889) — the same x as a group header and as a workspace / DM
          * header row, which is what lets the three of them line up with the tree
          * instead of floating in their own gutter. */}
        <div className="mb-3 space-y-0.5">
          <button
            type="button"
            onClick={props.onSelectSearch}
            className={cn(
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border pr-2 h-8 text-left text-[13px] ' +
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
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border pr-2 h-8 text-left text-[13px] ' +
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
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border pr-2 h-8 text-left text-[13px] ' +
                OUTER_GLYPH_INSET,
              sidebarRowStateClass(props.archivedActive),
            )}
          >
            <Archive className="size-4" />
            <span>Archived</span>
          </button>
        </div>

        {/* STARRED = the global Favorites list (#task:1253/#task:1254), holding
          * CONVERSATIONS since #task:1888. Self-contained (owns its read-model,
          * tier batches, unstar); renders nothing when empty. EXCLUSIVE — a starred conversation lives HERE only, removed from
          * its parent's channel list.
          *
          * Every rail section persists its collapse state across restarts
          * (#task:1632) — the rail is nav chrome the user arranges once, so
          * re-collapsing three sections on every launch is a chore. The
          * `persistId` (storage identity — see `SidebarSection`) is passed at
          * each section below; STARRED carries its own inside FavoritesGroup,
          * which owns its whole section. */}
        <FavoritesGroup
          selectedChannelId={props.selectedChannelId}
          watchWorkspaceIds={watchWorkspaceIds}
          onSelectConversation={props.onSelectConversation}
        />
        {/* Order: STARRED → WORKSPACES → DM (shiki, 2026-08-08). WORKSPACES is the
          * deep half of the tree — every row can expand into channels — so it takes
          * the position right under STARRED, and DM (flat, one row per agent) sits
          * at the bottom where its length doesn't push the workspaces off-screen. */}
        <WorkspaceGroup
          label="WORKSPACES"
          kind="regular"
          workspaces={orderedRegular}
          selected={selected}
          onSelectChannel={props.onSelectChannel}
          onCreateChannel={props.onCreateChannel}
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
              No workspaces yet. Use{' '}
              <kbd className="inline-flex size-4 items-center justify-center rounded-[var(--control-radius)] bg-bg-elevated align-text-bottom text-[11px] leading-none">
                +
              </kbd>{' '}
              to create one.
            </>
          }
          agentsById={props.agentsById}
          dmAgentAvatarUrls={dmAgentAvatarUrls}
          sort={sortConfigFor('regular')}
          persistId="workspaces"
        />
        <WorkspaceGroup
          label="DM"
          kind="dm"
          workspaces={orderedDms}
          selected={selected}
          onSelectChannel={props.onSelectChannel}
          onCreateChannel={props.onCreateChannel}
          emptyHint="Creating an agent opens a DM"
          agentsById={props.agentsById}
          dmAgentAvatarUrls={dmAgentAvatarUrls}
          headerAction={sortMenuFor('dm')}
          sort={sortConfigFor('dm')}
          persistId="dm"
        />
        {/* No bottom ARCHIVED group since #task:1889: the top-level `Archived`
          * entry above is the ONE archive index (#task:1890 gave it archived
          * WORKSPACES and their restore), so a second, differently-shaped archive
          * surface in the tree was the duplicate. */}
      </nav>
    </aside>
  );
}
