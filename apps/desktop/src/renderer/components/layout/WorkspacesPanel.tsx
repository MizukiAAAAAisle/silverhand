import type { ReactNode } from 'react';
import type { ChannelKind } from '@silverhand/shared';
import { Hash, MessageCircle } from 'lucide-react';
import { SidebarRow, SidebarSection } from './sidebar-shared';

export interface WorkspaceItem {
  id: string;
  name: string;
  kind: ChannelKind;
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
  kind: ChannelKind;
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

const ICON_BY_KIND: Record<ChannelKind, JSX.Element> = {
  regular: <Hash className="size-3.5" />,
  dm: <MessageCircle className="size-3.5" />,
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
        workspaces.map(w => (
          <SidebarRow
            key={w.id}
            icon={ICON_BY_KIND[w.kind]}
            title={w.kind === 'dm' ? displayDmName(w.name) : w.name}
            selected={w.id === selectedWorkspaceId}
            status={w.active ? 'active' : null}
            badge={w.unread}
            onClick={() => onSelectWorkspace(w.id)}
          />
        ))
      )}
    </SidebarSection>
  );
}

/** DM workspaces are stored as `dm-<agentName>` (see provision.ts).
 *  Strip the prefix in the sidebar so the user just sees `@<agentName>`. */
function displayDmName(stored: string): string {
  return stored.startsWith('dm-') ? `@${stored.slice(3)}` : stored;
}
