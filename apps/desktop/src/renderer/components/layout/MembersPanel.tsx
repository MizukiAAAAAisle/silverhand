import { Plus, User } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { CreateAgentDialog } from '@/features/agents/CreateAgentDialog';
import {
  isRegistrationRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from '@/features/me/hooks';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Button } from '@/components/ui/button';
import { CURRENT_USER_SUBTITLE } from '@/lib/current-user';
import { SidebarRow, SidebarSection } from './sidebar-shared';

interface MembersPanelProps {
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string) => void;
  /** Currently focused human-id in the right pane (`/members/u/:id`).
   *  Used to highlight the corresponding HUMANS row. */
  selectedUserId?: string | null;
  /** Click handler for HUMANS rows. Wired to `nav.toMembersUser(id)` in
   *  the App. When omitted the rows render but aren't clickable —
   *  matches the pre-#314 behaviour for surfaces that just want the
   *  list. */
  onSelectUser?: (id: string) => void;
}

export function MembersPanel({
  selectedAgentId,
  onSelectAgent,
  selectedUserId,
  onSelectUser,
}: MembersPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data: agents = [] } = useAgents();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const viewerQuery = useViewerUser();
  const viewerAvatarObjectUrl = useViewerAvatarObjectUrl();
  const viewer =
    viewerQuery.data && !isRegistrationRequired(viewerQuery.data)
      ? viewerQuery.data
      : null;

  return (
    <>
      <SidebarSection
        label="AGENTS"
        count={agents.length}
        action={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpen(true)}
            aria-label="新建 agent"
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {agents.length === 0 ? (
          <li className="px-2 py-2 text-xs text-text-muted">
            还没有 agent。点 + 创建一个。
          </li>
        ) : (
          agents.map(a => (
            <SidebarRow
              key={a.id}
              icon={
                <AgentAvatar
                  runtime={a.runtime}
                  size={20}
                  avatarObjectUrl={agentAvatarUrls.get(a.id) ?? null}
                  alt={a.display_name || a.name}
                />
              }
              title={a.display_name || a.name}
              subtitle={a.runtime}
              status="idle"
              selected={selectedAgentId === a.id}
              onClick={onSelectAgent ? () => onSelectAgent(a.id) : undefined}
            />
          ))
        )}
      </SidebarSection>

      <SidebarSection label="HUMANS" count={viewer ? 1 : 0}>
        {viewer ? (
          <SidebarRow
            icon={
              viewerAvatarObjectUrl ? (
                <span className="grid size-5 place-items-center overflow-hidden rounded-none bg-bg-row-hover">
                  {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
                  <img
                    src={viewerAvatarObjectUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                </span>
              ) : (
                <User className="size-3.5" />
              )
            }
            title={viewer.display_name || viewer.name}
            subtitle={CURRENT_USER_SUBTITLE}
            selected={selectedUserId === viewer.id}
            onClick={
              onSelectUser ? () => onSelectUser(viewer.id) : undefined
            }
          />
        ) : (
          <li className="px-2 py-2 text-xs text-text-muted">
            No human registered yet.
          </li>
        )}
      </SidebarSection>

      <CreateAgentDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
