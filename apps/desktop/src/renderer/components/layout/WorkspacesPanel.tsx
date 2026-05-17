import { useState, type ReactNode } from 'react';
import { Copy, FolderOpen, Pin, PinOff, User } from 'lucide-react';
import { toast } from 'sonner';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from '@/components/menus/AppContextMenu';
import { SidebarRow, SidebarSection } from './sidebar-shared';

type WorkspaceUiKind = 'regular' | 'dm';

export interface WorkspaceItem {
  id: string;
  name: string;
  kind: WorkspaceUiKind;
  workspace_path: string;
  dm_agent_id: string | null;
  pinned_at?: number | null;
  active?: boolean;
  /** Unread mention notifications scoped to this workspace. Falsy / 0
   *  hides the badge. */
  unread?: number;
  /** True for soft-archived workspaces — drives the Archived sidebar
   *  group; the row itself looks the same once you're inside it. */
  archived?: boolean;
}

interface WorkspaceGroupProps {
  label: string;
  /** Default kind for icon picking when a row's `kind` is the same.
   *  For mixed groups (e.g. Archived combines DM + regular) the per-row
   *  `w.kind` wins. Kept on the group for the empty-state messaging. */
  kind: WorkspaceUiKind;
  workspaces: WorkspaceItem[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onPinWorkspace?: (id: string, pinned: boolean) => void;
  /** Optional `+` button. DM groups omit this — DM workspaces are
   *  auto-created when an agent is provisioned. */
  onAdd?: () => void;
  /** Shown when `workspaces` is empty. */
  emptyHint?: ReactNode;
  /** Whether the group starts expanded. Defaults to true; archive group
   *  defaults to false so it stays out of the way. */
  defaultExpanded?: boolean;
}

const ICON_BY_KIND: Record<WorkspaceUiKind, JSX.Element> = {
  regular: (
    <span className="inline-flex size-3.5 items-center justify-center font-serif text-[14px] font-semibold leading-none">
      W
    </span>
  ),
  dm: <User className="size-3.5" />,
};

export function WorkspaceGroup({
  label,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onPinWorkspace,
  onAdd,
  emptyHint,
  defaultExpanded,
}: WorkspaceGroupProps): JSX.Element {
  return (
    <SidebarSection
      label={label}
      count={workspaces.length}
      onAdd={onAdd}
      collapsible
      defaultExpanded={defaultExpanded ?? true}
    >
      {workspaces.length === 0 ? (
        <li className="px-2 py-2 text-xs text-text-muted">{emptyHint ?? '空'}</li>
      ) : (
        workspaces.map(w => {
          const title = w.kind === 'dm' ? displayDmName(w.name) : w.name;
          const canPin = w.kind === 'regular' && !w.archived && !!onPinWorkspace;
          const pinned = isWorkspacePinned(w);
          return (
            <AppContextMenu
              key={w.id}
              trigger={
                canPin ? (
                  <li>
                    <WorkspaceRow
                      workspace={w}
                      title={title}
                      selected={w.id === selectedWorkspaceId}
                      onClick={() => onSelectWorkspace(w.id)}
                      onPin={(id, pinned) => onPinWorkspace?.(id, pinned)}
                    />
                  </li>
                ) : (
                  <SidebarRow
                    icon={ICON_BY_KIND[w.kind]}
                    title={title}
                    selected={w.id === selectedWorkspaceId}
                    status={w.active ? 'active' : null}
                    badge={w.unread}
                    onClick={() => onSelectWorkspace(w.id)}
                  />
                )
              }
            >
              {canPin ? (
                <AppContextMenuItem
                  icon={
                    pinned ? (
                      <PinOff className="size-3.5" />
                    ) : (
                      <Pin className="size-3.5" />
                    )
                  }
                  onSelect={() => onPinWorkspace?.(w.id, !pinned)}
                >
                  {pinned ? 'Unpin' : 'Pin'}
                </AppContextMenuItem>
              ) : null}
              {canPin ? <AppContextMenuSeparator /> : null}
              <AppContextMenuItem
                icon={<FolderOpen className="size-3.5" />}
                onSelect={() => {
                  void window.agentHub.showItemInFolder(w.workspace_path);
                }}
              >
                Open in Finder
              </AppContextMenuItem>
              <AppContextMenuItem
                icon={<Copy className="size-3.5" />}
                onSelect={() => {
                  void copyWorkspacePath(w.workspace_path);
                }}
              >
                Copy path
              </AppContextMenuItem>
            </AppContextMenu>
          );
        })
      )}
    </SidebarSection>
  );
}

interface WorkspaceRowProps {
  workspace: WorkspaceItem;
  title: string;
  selected: boolean;
  onClick: () => void;
  onPin: (id: string, pinned: boolean) => void;
}

function WorkspaceRow({
  workspace,
  title,
  selected,
  onClick,
  onPin,
}: WorkspaceRowProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const isPinned = isWorkspacePinned(workspace);
  const showPin = hovered || isPinned;
  const rowBg = selected
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary';

  return (
    <div
      className={'sidebar-row-border flex w-full items-stretch border transition-colors ' + rowBg}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
      >
        <span className="shrink-0 text-text-muted">{ICON_BY_KIND[workspace.kind]}</span>
        <span
          className={
            'flex min-w-0 flex-1 items-baseline gap-1.5 ' +
            (workspace.unread && workspace.unread > 0 && !selected
              ? 'font-semibold text-text-primary'
              : '')
          }
        >
          <span className="truncate">{title}</span>
        </span>
        {workspace.unread && workspace.unread > 0 ? (
          <span
            className={
              'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ' +
              (selected
                ? 'bg-bg-floating text-accent'
                : 'bg-accent text-text-on-accent')
            }
            aria-label={`${workspace.unread} unread`}
          >
            {workspace.unread > 99 ? '99+' : workspace.unread}
          </span>
        ) : workspace.active ? (
          <span className="size-1.5 rounded-full bg-success" />
        ) : null}
      </button>

      <button
        type="button"
        aria-label={isPinned ? '取消固定' : '固定'}
        title={isPinned ? '取消固定' : '固定'}
        onClick={e => {
          e.stopPropagation();
          onPin(workspace.id, !isPinned);
        }}
        className={
          'group/pin flex shrink-0 items-center justify-center px-1 ' +
          (!showPin ? 'pointer-events-none opacity-0' : '') +
          (selected
            ? isPinned
              ? ' text-text-on-selected'
              : ' text-text-on-selected/60 hover:text-text-on-selected'
            : isPinned
              ? ' text-accent'
              : ' text-text-muted hover:text-text-primary')
        }
        tabIndex={showPin ? 0 : -1}
      >
        {isPinned ? (
          <PinOff className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
        ) : (
          <Pin className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
        )}
      </button>
    </div>
  );
}

function isWorkspacePinned(workspace: WorkspaceItem): boolean {
  return workspace.pinned_at !== null && workspace.pinned_at !== undefined;
}

async function copyWorkspacePath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success('已复制路径');
  } catch {
    toast.error('复制路径失败');
  }
}

/** DM workspaces are stored as `dm-<agentName>` (see provision.ts).
 *  Strip the prefix in the sidebar so the user just sees `@<agentName>`. */
function displayDmName(stored: string): string {
  return stored.startsWith('dm-') ? `@${stored.slice(3)}` : stored;
}
