import { focusAgentSideSection } from "@/features/agents/components/agent-view";
import { useNav } from "@/router";

/** Opens an agent's panel at its activity, as the activity line does. */
export function useOpenAgentActivity(): (agentId: string) => void {
  const { openAgentPanel } = useNav();
  return (agentId) => {
    focusAgentSideSection(agentId, "activity");
    openAgentPanel(agentId);
  };
}
