import { Archive, ArchiveRestore, Bell, Copy, Star } from 'lucide-react';
import type { ChannelAttentionModeRowDto } from '@silverhand/shared';
import {
  AppContextMenuItem,
  AppContextMenuSeparator,
  AppContextMenuSub,
} from '@/components/menus/AppContextMenu';
import { ChannelAttentionMenuItems } from './ChannelAttentionSurfaces';
import { copyConversationName } from './sidebar-shared';

/** Sidebar placement changes star state, never channel management capabilities. */
export function ChannelRowMenuItems({
  channelId, title, rosterPolicy, isMember, isArchived, starred,
  attention, workspaceMuted, onStar, onArchive, archivePending,
}: {
  channelId: string;
  title: string;
  rosterPolicy: 'open' | 'fixed';
  isMember: boolean;
  isArchived: boolean;
  starred: boolean;
  attention?: ChannelAttentionModeRowDto;
  workspaceMuted: boolean | undefined;
  onStar: () => void;
  onArchive: () => void;
  archivePending: boolean;
}): JSX.Element {
  return (
    <>
      <AppContextMenuItem
        icon={<Star className={'size-3.5' + (starred ? ' fill-current' : '')} />}
        onSelect={onStar}
      >
        {starred ? 'Unstar' : 'Star'}
      </AppContextMenuItem>
      {isMember && rosterPolicy === 'open' ? (
        <AppContextMenuSub icon={<Bell className="size-3.5" />} label="Notifications">
          <ChannelAttentionMenuItems channelId={channelId} mode={attention?.mode} workspaceMuted={workspaceMuted} />
        </AppContextMenuSub>
      ) : null}
      {isMember ? (
        <AppContextMenuItem
          icon={isArchived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          disabled={archivePending}
          onSelect={onArchive}
        >
          {isArchived ? 'Restore' : 'Archive'}
        </AppContextMenuItem>
      ) : null}
      <AppContextMenuSeparator />
      <AppContextMenuItem icon={<Copy className="size-3.5" />} onSelect={() => void copyConversationName(title)}>
        Copy name
      </AppContextMenuItem>
    </>
  );
}
