import { useMemo } from 'react';
import { Archive, Bookmark, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { CURRENT_USER_ID, formatUserDisplayName } from '@/lib/current-user';
import { WorkspaceGroup, type WorkspaceItem } from './WorkspacesPanel';

interface SidebarProps {
  workspaces: WorkspaceItem[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
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

export function Sidebar(props: SidebarProps): JSX.Element {
  const { dms, regular, archived } = useMemo(() => {
    const dms: WorkspaceItem[] = [];
    const regular: WorkspaceItem[] = [];
    const archived: WorkspaceItem[] = [];
    for (const w of props.workspaces) {
      if (w.archived) archived.push(w);
      else if (w.kind === 'dm') dms.push(w);
      else regular.push(w);
    }
    return { dms, regular, archived };
  }, [props.workspaces]);

  // While the Saved view is active, suppress workspace highlighting so
  // the Saved entry visually owns selection.
  const workspaceHighlight =
    props.savedActive || props.searchActive || props.archivedActive
      ? null
      : props.selectedWorkspaceId;

  return (
    <aside
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

        <WorkspaceGroup
          label="DM"
          kind="dm"
          workspaces={dms}
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          emptyHint="新建 agent 时会自动创建 DM"
        />
        <WorkspaceGroup
          label="WORKSPACES"
          kind="regular"
          workspaces={regular}
          selectedWorkspaceId={workspaceHighlight}
          onSelectWorkspace={props.onSelectWorkspace}
          onAdd={props.onCreateWorkspace}
          emptyHint={
            <>
              还没有工作区。点{' '}
              <kbd className="rounded bg-bg-elevated px-1 py-0.5">+</kbd> 新建。
            </>
          }
        />
        {archived.length > 0 ? (
          <WorkspaceGroup
            label="ARCHIVED"
            kind="regular"
            workspaces={archived}
            selectedWorkspaceId={workspaceHighlight}
            onSelectWorkspace={props.onSelectWorkspace}
            defaultExpanded={false}
          />
        ) : null}
      </nav>

      <div className="border-t border-border-subtle px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <div className="size-7 rounded-full bg-bg-elevated" />
          <div className="min-w-0 flex-1 truncate text-text-secondary">
            {formatUserDisplayName(CURRENT_USER_ID)}
          </div>
        </div>
      </div>
    </aside>
  );
}
