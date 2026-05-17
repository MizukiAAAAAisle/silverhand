import { useState } from 'react';
import { Power, Trash2 } from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { AgentDto, AgentRuntimeStateDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Button } from '@/components/ui/button';
import { useStopAgent } from './hooks';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { DeleteAgentDialog } from './DeleteAgentDialog';

dayjs.extend(relativeTime);

interface AgentHeaderProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
  onDeleted: () => void;
}

export function AgentHeader({
  agent,
  runtimeState,
  onDeleted,
}: AgentHeaderProps): JSX.Element {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const stopAgent = useStopAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  const running = (runtimeState?.conversation_agents ?? []).filter(
    s => s.status === 'starting' || s.status === 'active',
  );
  const runningCount = running.length;

  return (
    <header className="flex shrink-0 items-start gap-4 border-b border-border-subtle bg-bg-floating px-6 py-4">
      <AgentAvatar
        runtime={agent.runtime}
        size={48}
        avatarObjectUrl={avatarObjectUrl}
        alt={agent.display_name || agent.name}
      />

      <div className="min-w-0 flex-1">
        <h1 className="truncate font-serif text-lg font-semibold text-text-primary">
          {agent.display_name || agent.name}
        </h1>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className="font-mono">@{agent.name}</span>
          <span>·</span>
          <span className="capitalize">{agent.runtime}</span>
          {agent.model ? (
            <>
              <span>·</span>
              <span>{agent.model}</span>
            </>
          ) : null}
          <span>·</span>
          <span title={dayjs(agent.created_at).format('YYYY-MM-DD HH:mm')}>
            created {dayjs(agent.created_at).fromNow()}
          </span>
        </div>
        <div className="mt-1 text-xs text-text-secondary">
          {runningCount === 0
            ? 'Idle in every conversation'
            : `${runningCount} running conversation${runningCount === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
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
      </div>

      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agent={agent}
        onDeleted={onDeleted}
      />
    </header>
  );
}
