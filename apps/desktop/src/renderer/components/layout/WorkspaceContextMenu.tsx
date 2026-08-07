import type { ReactElement } from 'react';
import { AppContextMenu } from '@/components/menus/AppContextMenu';
import { WorkspaceMuteMenuItem } from './ChannelAttentionSurfaces';

/**
 * The workspace/DM right-click menu — the container species' menu, mounted on
 * the tree's header rows (`WorkspaceRow`). Conversations carry their own menu
 * (`FavoriteRow` / `ChannelRow`), so this one has a single consumer today. It
 * stays a component because the structure — which capabilities appear, in what
 * order, and the "no capability ⇒ no menu at all" rule — is the part that must
 * not fork; callers supply only the resolved capabilities/handlers.
 *
 * NO STAR (shiki, 2026-08-08). A container star could only ever pin the row to
 * the top of its own group, which is a second ordering authority on a list that
 * already has manual drag — and the pin was applied after the sort, so a drag
 * that put an unstarred row above a starred one silently snapped back. It also
 * made one glyph mean two things: on a conversation Star MOVES the row into the
 * global STARRED list, on a container it only re-sorted. Containers are ordered
 * by drag alone; STARRED holds conversations only.
 */
export function WorkspaceContextMenu({
  trigger,
  muteWorkspaceId,
}: {
  trigger: ReactElement;
  /** The workspace whose mute suppressor this row can flip, or `null` when the
   *  row has none: an `agent_home` (DM) workspace is structurally un-mutable (a
   *  DM is directed-grade — there is no ambient traffic to silence, and the DB
   *  trigger forbids the row), and an archived workspace is not being listened to
   *  in the first place. Resolved by the caller. */
  muteWorkspaceId?: string | null;
}): JSX.Element {
  // A row with no capability at all would render an empty menu, so it gets no
  // context menu.
  if (!muteWorkspaceId) return trigger;
  return (
    <AppContextMenu trigger={trigger}>
      <WorkspaceMuteMenuItem workspaceId={muteWorkspaceId} />
    </AppContextMenu>
  );
}
