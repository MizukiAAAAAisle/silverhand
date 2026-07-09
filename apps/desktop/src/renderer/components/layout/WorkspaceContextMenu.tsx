import type { ReactElement } from 'react';
import { Copy, FolderOpen, Star } from 'lucide-react';
import { toast } from 'sonner';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from '@/components/menus/AppContextMenu';

/**
 * The single workspace/DM right-click menu, shared by the home-rail rows
 * (`WorkspaceRow`) and the STARRED rows (`FavoriteRow`). Starring MOVES a
 * workspace out of its home group into STARRED, so the same entity is reached
 * through two components — before this, the two built their own menus and drifted
 * (a starred workspace lost "Open in Finder" / "Copy path"; #task:1439). One
 * entity, one menu: callers only supply the resolved capabilities/handlers, the
 * structure lives here so it can't fork again.
 */
export function WorkspaceContextMenu({
  trigger,
  canStar,
  isStarred,
  onToggleStar,
  canReveal,
  workspacePath,
}: {
  trigger: ReactElement;
  canStar: boolean;
  isStarred: boolean;
  onToggleStar: () => void;
  canReveal: boolean;
  /** Null only in the rare window where a starred row's full workspace record
   *  hasn't resolved yet — the path-based items hide rather than act on a
   *  missing path. A home-rail `WorkspaceItem` always has one, so nothing hides
   *  there. */
  workspacePath: string | null;
}): JSX.Element {
  return (
    <AppContextMenu trigger={trigger}>
      {canStar ? (
        <AppContextMenuItem
          icon={<Star className={'size-3.5' + (isStarred ? ' fill-current' : '')} />}
          onSelect={onToggleStar}
        >
          {isStarred ? 'Unstar' : 'Star'}
        </AppContextMenuItem>
      ) : null}
      {canStar ? <AppContextMenuSeparator /> : null}
      {canReveal && workspacePath ? (
        <AppContextMenuItem
          icon={<FolderOpen className="size-3.5" />}
          onSelect={() => {
            void window.agentHub.showItemInFolder(workspacePath);
          }}
        >
          Open in Finder
        </AppContextMenuItem>
      ) : null}
      {workspacePath ? (
        <AppContextMenuItem
          icon={<Copy className="size-3.5" />}
          onSelect={() => {
            void copyWorkspacePath(workspacePath);
          }}
        >
          Copy path
        </AppContextMenuItem>
      ) : null}
    </AppContextMenu>
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
