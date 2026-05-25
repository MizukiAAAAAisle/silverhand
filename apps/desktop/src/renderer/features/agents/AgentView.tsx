import { useEffect, useState } from 'react';
import type { AgentRuntimeConversation } from '@silverhand/shared';
import { AgentHeader } from './AgentHeader';
import { AgentProfileCard } from './AgentProfileCard';
import { AgentSchedulesCard } from './AgentSchedulesCard';
import { AgentWorkspaceCard } from './AgentWorkspaceCard';
import { AgentConversationActivityList } from './AgentConversationActivityList';
import { AgentSidebar, type AgentSection } from './AgentSidebar';
import {
  useAgent,
  useAgentRuntimeState,
  useAgentWorkspace,
} from './hooks';
import { useHostProvenanceGate } from '@/features/hosts/hooks';

const SECTION_STORAGE_KEY = 'silverhand:layout.agent-section';
const VALID_SECTIONS: ReadonlyArray<AgentSection> = [
  'profile',
  'workspace',
  'runtime',
  'schedules',
];

function readSection(): AgentSection {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (raw && (VALID_SECTIONS as readonly string[]).includes(raw)) {
      return raw as AgentSection;
    }
  } catch {
    /* private mode / quota — fall back to default */
  }
  return 'profile';
}

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
  const hostProvenance = useHostProvenanceGate();

  // Selected section persists globally (not per-agent) so the user
  // doesn't have to re-pick after switching agents — the more common
  // case is repeatedly viewing the same section across different agents.
  const [section, setSection] = useState<AgentSection>(() => readSection());
  useEffect(() => {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, section);
    } catch {
      /* ignore */
    }
  }, [section]);

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

      <div className="flex min-h-0 flex-1">
        <AgentSidebar active={section} onChange={setSection} />

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="px-8 py-6">
            {section === 'profile' ? (
              <AgentProfileCard agent={agent} runtimeState={runtimeQuery.data} />
            ) : null}
            {section === 'workspace' ? (
              <AgentWorkspaceCard
                workspace={workspaceQuery.data}
                isLoading={workspaceQuery.isLoading}
                canRevealPath={hostProvenance.canUseLocalHostPathFor(agent.host_id)}
              />
            ) : null}
            {section === 'runtime' ? (
              <AgentConversationActivityList
                state={runtimeQuery.data}
                onOpenConversation={onOpenConversation}
              />
            ) : null}
            {section === 'schedules' ? (
              <AgentSchedulesCard agentId={agent.id} />
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
