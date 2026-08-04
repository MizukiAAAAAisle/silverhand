import type { ReactElement } from 'react';
import { Star } from 'lucide-react';
import {
  AppContextMenu,
  AppContextMenuItem,
} from '@/components/menus/AppContextMenu';

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
}: {
  trigger: ReactElement;
  canStar: boolean;
  isStarred: boolean;
  onToggleStar: () => void;
}): JSX.Element {
  // Star is the only item today; a row that can't star (archived) would render
  // an empty menu, so it gets no context menu at all.
  if (!canStar) return trigger;
  return (
    <AppContextMenu trigger={trigger}>
      <AppContextMenuItem
        icon={<Star className={'size-3.5' + (isStarred ? ' fill-current' : '')} />}
        onSelect={onToggleStar}
      >
        {isStarred ? 'Unstar' : 'Star'}
      </AppContextMenuItem>
    </AppContextMenu>
  );
}
