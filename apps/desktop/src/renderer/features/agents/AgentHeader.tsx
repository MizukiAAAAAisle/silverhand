import { useState } from 'react';
import { Power, Trash2 } from 'lucide-react';
import type { AgentDto, AgentRuntimeStateDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Button } from '@/components/ui/button';
import {
  HeroDot,
  PersonHero,
  PresencePill,
} from '@/features/common/PersonHero';
import { useStopAgent } from './hooks';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { DeleteAgentDialog } from './DeleteAgentDialog';

interface AgentHeaderProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
  onDeleted: () => void;
}

/**
 * Agent panel header. Thin adapter over the shared {@link PersonHero}
 * primitive — owns the agent-specific data wiring (Stop button +
 * mutation, Delete dialog, runtime presence aggregation, avatar
 * object URL) and forwards presentation to the Hero. Keeps `AgentView`
 * unchanged at the call site.
 */
export function AgentHeader({
  agent,
  runtimeState,
  onDeleted,
}: AgentHeaderProps): JSX.Element {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const stopAgent = useStopAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  // Hero presence == AgentSettings Stop predicate: count both
  // `starting` and `active` so an agent mid-spawn doesn't disappear
  // from the Hero between exec and first message.
  const running = (runtimeState?.conversation_agents ?? []).filter(
    s => s.status === 'starting' || s.status === 'active',
  );
  const runningCount = running.length;

  return (
    <>
      <PersonHero
        avatar={
          <AgentAvatar
            runtime={agent.runtime}
            size={48}
            avatarObjectUrl={avatarObjectUrl}
            alt={agent.display_name || agent.name}
          />
        }
        displayName={agent.display_name || agent.name}
        handle={agent.name}
        meta={
          <>
            <HeroDot />
            <span className="capitalize">{agent.runtime}</span>
            {agent.model ? (
              <>
                <HeroDot />
                <span>{agent.model}</span>
              </>
            ) : null}
            <HeroDot />
            <PresencePill runningCount={runningCount} />
          </>
        }
        bio={agent.description}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={runningCount === 0 || stopAgent.isPending}
              onClick={() => stopAgent.mutate()}
              title={
                runningCount === 0
                  ? 'Nothing is running'
                  : `Hard-stop ${runningCount} running conversation${runningCount === 1 ? '' : 's'}`
              }
            >
              <Power className="size-3.5" />
              Stop
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-error hover:bg-error/10 hover:text-error"
              onClick={() => setDeleteOpen(true)}
              title="Delete agent…"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </>
        }
      />
      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agent={agent}
        onDeleted={onDeleted}
      />
    </>
  );
}
