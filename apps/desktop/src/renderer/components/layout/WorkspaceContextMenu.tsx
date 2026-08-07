import type { ReactElement } from 'react';
import { Star } from 'lucide-react';
import {
  AppContextMenu,
  AppContextMenuItem,
} from '@/components/menus/AppContextMenu';
import { WorkspaceMuteMenuItem } from './ChannelAttentionSurfaces';

/**
 * The workspace/DM right-click menu — the container species' menu, mounted on
 * the tree's header rows (`WorkspaceRow`). STARRED holds CONVERSATIONS only
 * (#task:1888: a container star pins the row to the top of its own group rather
 * than moving it), so `FavoriteRow` carries the conversation menu instead and
 * this one has a single consumer today. It stays a component because the
 * structure — which capabilities appear, in what order, and the "no capability ⇒
 * no menu at all" rule — is the part that must not fork; callers supply only the
 * resolved capabilities/handlers.
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
