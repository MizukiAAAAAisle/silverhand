import { useCompactLayout } from "@/navigation/layout";
import { useEffect, useRef } from "react";
import { routes, useNav, useRouteState } from "@/router";
import { useAgents } from "@/features/agents/hooks/hooks";
import { DirectoryShell, type DirectoryLifecycle } from "@/components/layout/directory-shell";
import { AgentSidebarShell } from "./agent-sidebar-shell";
import { AgentDetailPage, type AgentNavigation } from "./agent-detail-page";
import { resolveDefaultAgent } from "./selection";

export function AgentShell({
  mounted,
  visible,
  onMessageAgent,
  onOpenConversation,
}: DirectoryLifecycle & AgentNavigation): JSX.Element {
  const compact = useCompactLayout();
  const route = useRouteState();
  const nav = useNav();
  const { data: agents = [] } = useAgents();
  const lastSelectedAgentId = useRef<string | null>(null);

  useEffect(() => {
    if (route.agentId && agents.some((agent) => agent.id === route.agentId)) {
      lastSelectedAgentId.current = route.agentId;
    }
  }, [agents, route.agentId]);

  useEffect(() => {
    if (compact || route.section !== "members") {
      return;
    }

    const target = resolveDefaultAgent(
      agents.map((agent) => agent.id),
      route.agentId,
      route.userId,
      lastSelectedAgentId.current,
    );

    if (target) {
      nav.go(routes.membersAgent(target), { replace: true });
    }
  }, [compact, agents, route.section, route.agentId, route.userId, nav]);

  return (
    <DirectoryShell
      name="members"
      selected={Boolean(route.agentId || route.userId)}
      mounted={mounted}
      visible={visible}
      sidebar={
        <AgentSidebarShell
          selectedAgentId={route.agentId}
          selectedUserId={route.userId}
          onSelectAgent={(id) => nav.toMembers(id)}
          onSelectUser={(id) => nav.toMembersUser(id)}
        />
      }
    >
      <AgentDetailPage
        agentId={route.agentId}
        userId={route.userId}
        onExit={() => nav.toMembers()}
        onMessageAgent={onMessageAgent}
        onOpenConversation={onOpenConversation}
      />
    </DirectoryShell>
  );
}
