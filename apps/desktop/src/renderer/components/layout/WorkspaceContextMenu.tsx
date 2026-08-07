import type { ReactElement } from 'react';
import { Star } from 'lucide-react';
import {
  AppContextMenu,
  AppContextMenuItem,
} from '@/components/menus/AppContextMenu';
import { WorkspaceMuteMenuItem } from './ChannelAttentionSurfaces';

/**
 * The single workspace/DM right-click menu, shared by the home-rail rows
 * (`WorkspaceRow`) and the STARRED rows (`FavoriteRow`). Starring MOVES a
 * workspace out of its home group into STARRED, so the same entity is reached
 * through two components; keeping the menu here means the two can't drift. One
 * entity, one menu: callers only supply the resolved capabilities/handlers, the
 * structure lives here so it can't fork again.
 */
export function WorkspaceContextMenu({
  trigger,
  canStar,
  isStarred,
  onToggleStar,
  muteWorkspaceId,
}: {
  trigger: ReactElement;
  canStar: boolean;
  isStarred: boolean;
  onToggleStar: () => void;
  /** The workspace whose mute suppressor this row can flip, or `null` when the
   *  row has none: an `agent_home` (DM) workspace is structurally un-mutable (a
   *  DM is directed-grade — there is no ambient traffic to silence, and the DB
   *  trigger forbids the row), and an archived workspace is not being listened to
   *  in the first place. Resolved by the caller, like `canStar`. */
  muteWorkspaceId?: string | null;
}): JSX.Element {
  // A row with no capability at all would render an empty menu, so it gets no
  // context menu.
  if (!canStar && !muteWorkspaceId) return trigger;
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
      {muteWorkspaceId ? <WorkspaceMuteMenuItem workspaceId={muteWorkspaceId} /> : null}
    </AppContextMenu>
  );
}
