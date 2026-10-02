import { AgentView } from "@/features/agents/components/agent-view";
import { HumanView } from "@/features/profile/human-view";
import { DirectoryPlaceholder } from "@/components/layout/directory-shell";

export interface AgentNavigation {
  onMessageAgent: (agentId: string) => void;
  onOpenConversation: (conversationId: string, workspaceId: string | null) => void;
}

export function AgentDetailPage({
  agentId,
  userId,
  onExit,
  onMessageAgent,
  onOpenConversation,
}: AgentNavigation & {
  agentId: string | null;
  userId: string | null;
  onExit: () => void;
}): JSX.Element {
  if (userId) {
    return <HumanView key={userId} userId={userId} onUnreachable={onExit} />;
  }

  if (agentId) {
    return (
      <AgentView
        key={agentId}
        agentId={agentId}
        onDeleted={onExit}
        onMessageAgent={onMessageAgent}
        onOpenChat={(target) => onOpenConversation(target.conversationId, target.workspaceId)}
      />
    );
  }

  return <DirectoryPlaceholder>Select an agent to see its details</DirectoryPlaceholder>;
}
