import type { AgentRuntimeConversation } from '@silverhand/shared';
import { AgentHeader } from './AgentHeader';
import { AgentProfileCard } from './AgentProfileCard';
import { AgentWorkspaceCard } from './AgentWorkspaceCard';
import { AgentRuntimeTable } from './AgentRuntimeTable';
import {
  useAgent,
  useAgentRuntimeState,
  useAgentWorkspace,
} from './hooks';

interface AgentViewProps {
  agentId: string;
  /** Called after a successful delete so the parent can navigate
   *  away (back to channels, typically). */
  onDeleted: () => void;
  /** Click "Open" on a conversation row → switch the main view to that
   *  channel/thread. Optional: if not provided, the column is
   *  still shown but rows aren't actionable. */
  onOpenConversation?: (s: AgentRuntimeConversation) => void;
}

export function AgentView({
  agentId,
  onDeleted,
  onOpenConversation,
}: AgentViewProps): JSX.Element {
  const agentQuery = useAgent(agentId);
  const workspaceQuery = useAgentWorkspace(agentId);
  const runtimeQuery = useAgentRuntimeState(agentId);

  if (agentQuery.isLoading) {
    return (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
          overflow: 'hidden',
        }}
      >
        Loading agent…
      </main>
    );
  }
  if (agentQuery.isError || !agentQuery.data) {
    return (
      <main
        className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
        style={{
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
          overflow: 'hidden',
        }}
      >
        Agent not found.
      </main>
    );
  }

  const agent = agentQuery.data;

  return (
    <main
      className="flex h-full flex-1 flex-col overflow-hidden bg-bg-base"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      <AgentHeader
        agent={agent}
        runtimeState={runtimeQuery.data}
        onDeleted={onDeleted}
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <AgentProfileCard agent={agent} runtimeState={runtimeQuery.data} />
            <AgentWorkspaceCard
              workspace={workspaceQuery.data}
              isLoading={workspaceQuery.isLoading}
            />
          </div>
          <AgentRuntimeTable
            state={runtimeQuery.data}
            onOpenConversation={onOpenConversation}
          />
        </div>
      </div>
    </main>
  );
}
