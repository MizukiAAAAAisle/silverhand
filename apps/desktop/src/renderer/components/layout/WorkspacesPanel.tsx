import type { ReactNode } from 'react';
import { Copy, FolderOpen, User } from 'lucide-react';
import { toast } from 'sonner';
import {
  AppContextMenu,
  AppContextMenuItem,
} from '@/components/menus/AppContextMenu';
import { SidebarRow, SidebarSection } from './sidebar-shared';

type WorkspaceUiKind = 'regular' | 'dm';

export interface WorkspaceItem {
  id: string;
  name: string;
  kind: WorkspaceUiKind;
  workspace_path: string;
  dm_agent_id: string | null;
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
          return (
            <AppContextMenu
              key={w.id}
              trigger={
                <SidebarRow
                  icon={ICON_BY_KIND[w.kind]}
                  title={title}
                  selected={w.id === selectedWorkspaceId}
                  status={w.active ? 'active' : null}
                  badge={w.unread}
                  onClick={() => onSelectWorkspace(w.id)}
                />
              }
            >
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
