import { Plus, User } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '@/features/agents/hooks';
import { CreateAgentDialog } from '@/features/agents/CreateAgentDialog';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Button } from '@/components/ui/button';
import { SidebarRow, SidebarSection } from './sidebar-shared';

interface MembersPanelProps {
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string) => void;
}

export function MembersPanel({
  selectedAgentId,
  onSelectAgent,
}: MembersPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data: agents = [] } = useAgents();

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
              icon={<AgentAvatar runtime={a.runtime} size={20} />}
              title={a.display_name || a.name}
              subtitle={a.runtime}
              status="idle"
              selected={selectedAgentId === a.id}
              onClick={onSelectAgent ? () => onSelectAgent(a.id) : undefined}
            />
          ))
        )}
      </SidebarSection>

      <SidebarSection label="HUMANS" count={1}>
        <SidebarRow
          icon={<User className="size-3.5" />}
          title="local"
          subtitle="(you)"
        />
      </SidebarSection>

      <CreateAgentDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
