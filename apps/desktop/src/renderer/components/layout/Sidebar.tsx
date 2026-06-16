import { useMemo } from 'react';
import { Archive, Bookmark, Plus, Search } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { useHostProvenanceGate } from '@/features/hosts/hooks';
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
  isWorkspacePinned,
  type WorkspaceItem,
  type WorkspaceSortConfig,
} from './WorkspacesPanel';

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
  onPinWorkspace: (workspaceId: string, pinned: boolean) => void;
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

/** The rail is one sortable list (`list_key='workspaces'`) with three live hard
 *  groups; a workspace's group is partitioned from its pin state first (PINNED
 *  is cross-kind), then its kind. Never stored. Each group is its own mode scope
 *  (#task:1146). See docs/list-sort-v1.md. */
type RailGroup = 'pinned' | 'dm' | 'regular';

function railGroupKeyOf(workspace: WorkspaceItem): RailGroup {
  if (isWorkspacePinned(workspace)) return 'pinned';
  return workspace.kind === 'dm' ? 'dm' : 'regular';
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const hostProvenance = useHostProvenanceGate();
  // Live partition: PINNED is the cross-kind top group (any pinned workspace OR
  // pinned DM); DM / WORKSPACES hold only the UNPINNED tail of each kind. So a
  // pinned DM leaves the DM section and joins PINNED (#task:1146 pin redesign).
  const { pinned, dms, regular, archived } = useMemo(() => {
    const pinned: WorkspaceItem[] = [];
    const dms: WorkspaceItem[] = [];
    const regular: WorkspaceItem[] = [];
    const archived: WorkspaceItem[] = [];
    for (const w of props.workspaces) {
      if (w.archived) archived.push(w);
      else if (isWorkspacePinned(w)) pinned.push(w);
      else if (w.kind === 'dm') dms.push(w);
      else regular.push(w);
    }
    return { pinned, dms, regular, archived };
  }, [props.workspaces]);

  // Resolve DM-agent avatar object URLs ONCE for the whole rail, over the
  // STABLE union of every DM agent (across pinned / dm / archived). Pin/unpin
  // only moves a DM between sections — the set of (agent, avatar_url) pairs is
  // unchanged — so this map stays identical and no avatar tears down + refetches
  // (the flash shiki saw came from per-section resolution churning on pin).
  // #task:1146
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
  // state machine (synchronous drop override, color-freeze, settle guard) lives
  // in the shared useListDragSort — the same hook the channel sidebar uses, so
  // the CDP-tuned flicker invariants can't drift between the two surfaces.
  // `modeScopeOf: g => g` makes each section its own [recent|manual] scope.
  const { data: viewerSort } = useWorkspaceSortState();
  const setSortMode = useSetSortMode();
  const { orderedGroups, onReorder, bridging } = useListDragSort<
    RailGroup,
    WorkspaceItem
  >({
    listKey: 'workspaces',
    groups: { pinned, dm: dms, regular },
    viewerSort,
    getId: w => w.id,
    getCreatedAt: w => w.created_at,
    modeScopeOf: g => g,
  });
  const orderedPinned = orderedGroups.pinned;
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
    bridging,
    onReorder,
  });

  // While the Saved view is active, suppress workspace highlighting so
  // the Saved entry visually owns selection.
  const workspaceHighlight =
    props.savedActive || props.searchActive || props.archivedActive
      ? null
      : props.selectedWorkspaceId;

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
      <nav className="flex-1 overflow-y-auto py-1.5">
        <button
          type="button"
          onClick={props.onSelectSearch}
          className={cn(
            'sidebar-row-border mx-1.5 mb-1 flex w-[calc(100%-0.75rem)] items-center gap-2 border px-2 py-1.5 text-left text-sm transition-colors',
            props.searchActive
              ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
              : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary',
          )}
        >
          <Search className="size-3.5" />
          <span>Search</span>
        </button>

        <button
          type="button"
          onClick={props.onSelectSaved}
          className={cn(
            'sidebar-row-border mx-1.5 mb-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border px-2 py-1.5 text-left text-sm transition-colors',
            props.savedActive
              ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
              : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary',
          )}
        >
          <Bookmark
            className={cn(
              'size-3.5',
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
            'sidebar-row-border mx-1.5 mb-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2 border px-2 py-1.5 text-left text-sm transition-colors',
            props.archivedActive
              ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
              : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary',
          )}
        >
          <Archive className="size-3.5" />
          <span>Archived</span>
        </button>

        {orderedPinned.length > 0 ? (
          <WorkspaceGroup
            label="PINNED"
            kind="regular"
            workspaces={orderedPinned}
            selectedWorkspaceId={workspaceHighlight}
            onSelectWorkspace={props.onSelectWorkspace}
            onPinWorkspace={props.onPinWorkspace}
            canRevealWorkspace={workspace =>
              hostProvenance.canUseLocalHostPathFor(workspace.workspace_host_id)
            }
            headerAction={sortMenuFor('pinned')}
            agentsById={props.agentsById}
            dmAgentAvatarUrls={dmAgentAvatarUrls}
            sort={sortConfigFor('pinned')}
          />
        ) : null}
        <WorkspaceGroup
          label="DM"
          kind="dm"
          workspaces={orderedDms}
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          onPinWorkspace={props.onPinWorkspace}
          canRevealWorkspace={workspace =>
            hostProvenance.canUseLocalHostPathFor(workspace.workspace_host_id)
          }
          emptyHint="新建 agent 时会自动创建 DM"
          agentsById={props.agentsById}
          dmAgentAvatarUrls={dmAgentAvatarUrls}
          headerAction={sortMenuFor('dm')}
          sort={sortConfigFor('dm')}
        />
        <WorkspaceGroup
          label="WORKSPACES"
          kind="regular"
          workspaces={orderedRegular}
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          onPinWorkspace={props.onPinWorkspace}
          canRevealWorkspace={workspace =>
            hostProvenance.canUseLocalHostPathFor(workspace.workspace_host_id)
          }
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
              还没有工作区。点{' '}
              <kbd className="inline-flex size-4 items-center justify-center rounded-[var(--control-radius)] bg-bg-elevated align-text-bottom text-[11px] leading-none">
                +
              </kbd>{' '}
              新建。
            </>
          }
          agentsById={props.agentsById}
          dmAgentAvatarUrls={dmAgentAvatarUrls}
          sort={sortConfigFor('regular')}
        />
        {archived.length > 0 ? (
          <WorkspaceGroup
            label="ARCHIVED"
            kind="regular"
            workspaces={archived}
            selectedWorkspaceId={workspaceHighlight}
            onSelectWorkspace={props.onSelectWorkspace}
            canRevealWorkspace={workspace =>
              hostProvenance.canUseLocalHostPathFor(workspace.workspace_host_id)
            }
            defaultExpanded={false}
            agentsById={props.agentsById}
            dmAgentAvatarUrls={dmAgentAvatarUrls}
          />
        ) : null}
      </nav>
    </aside>
  );
}
