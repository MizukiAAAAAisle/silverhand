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
import { partitionRailWorkspaces } from '@/lib/home-grouping';

interface SidebarProps {
  workspaces: WorkspaceItem[];
  /** Workspace agents indexed by id. Threaded through to
   *  `WorkspaceGroup` so DM rows can resolve `dm_agent_id` and render
   *  the agent's uploaded avatar (or runtime icon fallback) instead of
   *  the generic User glyph. Optional — when absent, DM rows fall back
   *  to the User icon. #task:919 */
  agentsById?: ReadonlyMap<string, AgentDto>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onStarWorkspace: (workspaceId: string, starred: boolean) => void;
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
  localWorkspacePaths: ReadonlyMap<string, string>;
}

/** The rail is one sortable list (`list_key='workspaces'`) with two live hard
 *  groups by kind (DM / regular); never stored. Each group is its own mode scope
 *  (#task:1146). STARRED is NOT a rail partition — it is the global Favorites
 *  overlay (#task:1253/#task:1254), a separate read-model. Under the EXCLUSIVE
 *  model a starred workspace/DM is MOVED out of these home groups into STARRED
 *  (it appears once, not in both). See docs/list-sort-v1.md. */
type RailGroup = 'dm' | 'regular';

function railGroupKeyOf(workspace: WorkspaceItem): RailGroup {
  return workspace.kind === 'dm' ? 'dm' : 'regular';
}

export function Sidebar(props: SidebarProps): JSX.Element {
  // Home rail groups by KIND (DM / regular), plus archived. STARRED is NOT a rail
  // partition — it is the global Favorites overlay (#task:1253/#task:1254). Under
  // the EXCLUSIVE model a starred (non-archived) workspace/DM is MOVED into
  // STARRED and removed from its DM/WORKSPACES home group here, so it appears
  // exactly once. The exclusion reads each item's `starred_at` (joined upstream
  // from `viewer_sort.entries[].starred_at` — the same fact the backend's reorder
  // validation uses), never a second favorites query. `props.workspaces` is the
  // RAW full visible set; these are the home projections (see lib/home-grouping).
  const { dms: homeDms, regular: homeRegular, archived } = useMemo(
    () => partitionRailWorkspaces(props.workspaces),
    [props.workspaces],
  );

  // Resolve DM-agent avatar object URLs ONCE for the whole rail, over the
  // STABLE union of every DM agent (across dm / regular / archived) from the RAW
  // workspace set. Resolving over the raw set (not the home projection) keeps the
  // map identical across renders even though star/unstar now MOVES a DM between
  // the home group and STARRED — so no avatar tears down + refetches (the flash
  // shiki saw came from per-section resolution churning on star). #task:1146
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

  // Saved / Search / Archived are top-level views (not a workspace) — suppress
  // the workspace-row highlight so the nav doesn't show a workspace AND a
  // top-level view both selected (Cindy review). (Activity is now its own
  // NavRail section, no longer a chat-sidebar entry — #task:1394.)
  const topLevelViewActive =
    props.savedActive || props.searchActive || props.archivedActive;
  const workspaceHighlight = topLevelViewActive ? null : props.selectedWorkspaceId;

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
          * all three sidebar row classes (rail / channel / tool) one row-language. */}
        <div className="mb-3 space-y-0.5">
          <button
            type="button"
            onClick={props.onSelectSearch}
            className={cn(
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border px-2 h-8 text-left text-sm',
              props.searchActive
                ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
                : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary',
            )}
          >
            <Search className="size-4" />
            <span>Search</span>
          </button>

          <button
            type="button"
            onClick={props.onSelectSaved}
            className={cn(
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border px-2 h-8 text-left text-sm',
              props.savedActive
                ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
                : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary',
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
              'sidebar-row-border mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border px-2 h-8 text-left text-sm',
              props.archivedActive
                ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
                : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary',
            )}
          >
            <Archive className="size-4" />
            <span>Archived</span>
          </button>
        </div>

        {/* STARRED = global Favorites overlay (#task:1253/#task:1254).
          * Self-contained (owns its read-model, dm-avatar resolution, unstar);
          * renders nothing when empty. EXCLUSIVE — a starred entity lives HERE
          * only; it has been removed from the DM/WORKSPACES groups below.
          *
          * Every rail section persists its collapse state across restarts
          * (#task:1632) — the rail is nav chrome the user arranges once, so
          * re-collapsing three sections on every launch is a chore. The
          * `persistId` (storage identity — see `SidebarSection`) is passed at
          * each section below; STARRED carries its own inside FavoritesGroup,
          * which owns its whole section. */}
        <FavoritesGroup
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          localWorkspacePaths={props.localWorkspacePaths}
        />
        <WorkspaceGroup
          label="DM"
          kind="dm"
          workspaces={orderedDms}
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          onStarWorkspace={props.onStarWorkspace}
          localWorkspacePaths={props.localWorkspacePaths}
          emptyHint="Creating an agent opens a DM"
          agentsById={props.agentsById}
          dmAgentAvatarUrls={dmAgentAvatarUrls}
          headerAction={sortMenuFor('dm')}
          sort={sortConfigFor('dm')}
          persistId="dm"
        />
        <WorkspaceGroup
          label="WORKSPACES"
          kind="regular"
          workspaces={orderedRegular}
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          onStarWorkspace={props.onStarWorkspace}
          localWorkspacePaths={props.localWorkspacePaths}
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
        {archived.length > 0 ? (
          <WorkspaceGroup
            label="ARCHIVED"
            kind="regular"
            workspaces={archived}
            selectedWorkspaceId={workspaceHighlight}
            onSelectWorkspace={props.onSelectWorkspace}
            localWorkspacePaths={props.localWorkspacePaths}
            defaultExpanded={false}
            persistId="archived"
            agentsById={props.agentsById}
            dmAgentAvatarUrls={dmAgentAvatarUrls}
          />
        ) : null}
      </nav>
    </aside>
  );
}
