/**
 * Owner-audit read hooks for #task:2036 part ② — the Agent page's Chats section.
 *
 * These are PURE READS of the owner-audit faces (`GET /api/agents/:id/chats` and
 * `.../chats/:cid/messages`): the owner may read, read-only, every conversation
 * the agent is a party to, because they already bear its runtime (@shiki's
 * ruling). There is deliberately no mutation hook here and nothing that advances
 * a cursor — the audit read touches no per-viewer state, and the transcript DTO
 * carries none (no reactions, no stream-head snapshot). The section's read-only
 * property is structural: this module offers no other verb.
 *
 * Owner-only is enforced by the backend (404 then 403); {@link canAuditAgentChats}
 * only decides whether the renderer even mounts these. `enabled` keeps a
 * non-owner from firing a request that would just 403.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  AgentAuditChatListResponse,
  AgentAuditTranscriptResponse,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { transcriptPreviousBeforeSeq } from './audit-transcript-paging';

/** Query key for one agent's owner-audit chats list. Keyed by the AGENT (the
 *  subject), the only coordinate the list takes. */
export const agentAuditChatsKey = (agentId: string) =>
  ['agent-audit-chats', agentId] as const;

/** Query key for the read-only transcript of one of the agent's chats. */
export const agentAuditTranscriptKey = (agentId: string, conversationId: string) =>
  ['agent-audit-transcript', agentId, conversationId] as const;

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
    queryFn: async () =>
      api<AgentAuditChatListResponse>(apiPaths.agentChats(agentId)),
  });
}

/**
 * The read-only transcript of one audited chat (mainline + thread replies
 * interleaved), paged BACKWARD from the latest window so the owner can reach
 * the full history — the product ruling is "All Chats = 可读全文", not just the
 * newest window.
 *
 * `initialPageParam = null` reads the latest window; each older page is fetched
 * with `before_seq = <oldest loaded seq>` (the endpoint's window is `seq <
 * before_seq`, exclusive, so pages never overlap at the boundary). Older pages
 * are PREPENDED by react-query, so `pages[0]` is always the oldest loaded page
 * and drives the next backward step. There is deliberately no forward
 * (`after_seq`) paging: the view always anchors at the latest window and only
 * ever walks older.
 *
 * Still a pure read: none of these windowed reads advances any per-viewer
 * cursor (the audit face captures no stream-head snapshot and enriches no
 * reaction relation) — paging backward changes nothing on the endpoints.
 */
export function useAgentChatTranscript(
  agentId: string,
  conversationId: string | null,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: agentAuditTranscriptKey(agentId, conversationId ?? ''),
    enabled: enabled && conversationId !== null,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam }) => {
      const base = apiPaths.agentChatTranscript(
        agentId,
        conversationId as string,
      );
      const path =
        pageParam === null ? base : `${base}?before_seq=${pageParam}`;
      return api<AgentAuditTranscriptResponse>(path);
    },
    // The latest window is the anchor; we never page forward past it.
    getNextPageParam: () => undefined,
    // Walk older: the oldest loaded message's seq becomes the next
    // `before_seq`. `pages[0]` is the oldest page (older pages are prepended);
    // the cursor rule lives in the pure paging seam.
    getPreviousPageParam: transcriptPreviousBeforeSeq,
  });
}
