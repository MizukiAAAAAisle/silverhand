import type { ReactNode } from 'react';
import type { ChannelKind } from '@silverhand/shared';
import { Hash, MessageCircle } from 'lucide-react';
import { SidebarRow, SidebarSection } from './sidebar-shared';

export interface ChannelItem {
  id: string;
  name: string;
  kind: ChannelKind;
  dm_agent_id: string | null;
  active?: boolean;
  /** Unread mention notifications scoped to this channel. Falsy / 0
   *  hides the badge. */
  unread?: number;
  /** True for soft-archived channels — drives the Archived sidebar
   *  group; the row itself looks the same once you're inside it. */
  archived?: boolean;
}

interface ChannelGroupProps {
  label: string;
  /** Default kind for icon picking when a row's `kind` is the same.
   *  For mixed groups (e.g. Archived combines DM + regular) the per-row
   *  `c.kind` wins. Kept on the group for the empty-state messaging. */
  kind: ChannelKind;
  channels: ChannelItem[];
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  /** Optional `+` button. DM groups omit this — DM channels are
   *  auto-created when an agent is provisioned. */
  onAdd?: () => void;
  /** Shown when `channels` is empty. */
  emptyHint?: ReactNode;
  /** Whether the group starts expanded. Defaults to true; archive group
   *  defaults to false so it stays out of the way. */
  defaultExpanded?: boolean;
}

const ICON_BY_KIND: Record<ChannelKind, JSX.Element> = {
  regular: <Hash className="size-3.5" />,
  dm: <MessageCircle className="size-3.5" />,
};

export function ChannelGroup({
  label,
  channels,
  selectedChannelId,
  onSelectChannel,
  onAdd,
  emptyHint,
  defaultExpanded,
}: ChannelGroupProps): JSX.Element {
  return (
    <SidebarSection
      label={label}
      count={channels.length}
      onAdd={onAdd}
      collapsible
      defaultExpanded={defaultExpanded ?? true}
    >
      {channels.length === 0 ? (
        <li className="px-2 py-2 text-xs text-text-muted">{emptyHint ?? '空'}</li>
      ) : (
        channels.map(c => (
          <SidebarRow
            key={c.id}
            icon={ICON_BY_KIND[c.kind]}
            title={c.kind === 'dm' ? displayDmName(c.name) : c.name}
            selected={c.id === selectedChannelId}
            status={c.active ? 'active' : null}
            badge={c.unread}
            onClick={() => onSelectChannel(c.id)}
          />
        ))
      )}
    </SidebarSection>
  );
}

/** DM channels are stored as `dm-<agentName>` (see provision.ts).
 *  Strip the prefix in the sidebar so the user just sees `@<agentName>`. */
function displayDmName(stored: string): string {
  return stored.startsWith('dm-') ? `@${stored.slice(3)}` : stored;
}
