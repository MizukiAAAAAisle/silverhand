/**
 * Owner-audit read hook for the Agent page's Chats section (#task:2036 part ②).
 *
 * This is a PURE READ of the owner-audit list face (`GET /api/agents/:id/chats`):
 * the owner may see which conversations their agent is a party to, because they
 * already bear its runtime (@shiki's ruling). There is deliberately no mutation
 * hook here and nothing that advances a cursor — the audit read touches no
 * per-viewer state.
 *
 * The in-place transcript reader that used to live here is gone with the
 * master-detail pane it served (#task:2040): a row now leads to the ordinary chat
 * surface when the VIEWER takes part in the conversation, and nowhere when they
 * do not, so nothing in the renderer reads an audited transcript any more. The
 * backend face is untouched and unreferenced by design (@shiki: 后端 API 先留着).
 *
 * Owner-only is enforced by the backend (404 then 403); {@link canAuditAgentChats}
 * only decides whether the renderer even mounts this. `enabled` keeps a
 * non-owner from firing a request that would just 403.
 */
import { useQuery } from "@tanstack/react-query";
import type { AgentAuditChatListResponse } from "@silverhand/shared";
import { apiPaths } from "@silverhand/shared";
import { api } from "@/lib/api";

/** Query key for one agent's owner-audit chats list. Keyed by the AGENT (the
 *  subject), the only coordinate the list takes. */
export const agentAuditChatsKey = (agentId: string) => ["agent-audit-chats", agentId] as const;

/**
 * The agent's chats, as its owner may audit them. A plain read — no live sync:
 * the set of conversations an agent is a party to changes rarely and an audit
 * view is not a live inbox, so it refetches on mount / focus like any other
 * query rather than arming a viewer-scope subscription.
 */
export function useAgentAuditChats(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: agentAuditChatsKey(agentId),
    enabled,
    queryFn: async () => api<AgentAuditChatListResponse>(apiPaths.agentChats(agentId)),
  });
}
