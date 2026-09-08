import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  apiPaths,
  type AddConversationMemberInput,
  type ConversationMembersResponse,
} from "@silverhand/shared";
import { api } from "@/lib/api";

/**
 * Add a member (agent or human) to an open-roster conversation.
 *
 * Backed by `POST /api/conversations/:cid/members`. Accepts the
 * tagged-union id form (`{kind:'agent', agent_id}` |
 * `{kind:'human', user_id}`) — the renderer always has the resolved
 * DTO, so it sends id directly. Server-side handle resolution
 * (`{handle}`) is reserved for the agent CLI surface
 * (`silverhand member add`), where the agent has no listing
 * capability.
 *
 * Membership rules enforced by the route (so the renderer doesn't
 * need to re-check):
 *   - A candidate that is not in this conversation's workspace yet is
 *     provisioned as part of the same permission-protected add — one
 *     action, never "enroll it first" (load-bearing product design,
 *     shiki; reaffirmed 2026-07-28). Who may trigger that provisioning
 *     follows the candidate: an agent's is its creator's call, so any
 *     member of this conversation may bring their OWN agents in
 *     (#task:1683), while a human's is workspace `admin` governance.
 *     A candidate nobody present may provision is refused BEFORE any
 *     row is written — 403 `agent_not_owned` for someone else's agent,
 *     `workspace_membership_required` 422 for a caller with no
 *     provisioning authority at all (an agent principal).
 *   - Conversation must use an open roster and not
 *     closed (`conversation_member_add_unsupported` 422 /
 *     `conversation_closed` 409). The trigger button hides on DM
 *     channels + closed conversations, so these are also defense-in-
 *     depth.
 *   - Duplicate adds are 200 no-op and return the current members
 *     list — the mutation never throws on idempotent retries.
 *
 * On success we invalidate the conversation members cache so the
 * conversation header member strip + any open `useConversationMembers`
 * subscriber refresh. If a workspace id is available, also invalidate
 * workspace members, because the add may have provisioned workspace
 * membership under the hood — that is what keeps the auto-enrolled
 * agent visible in the workspace roster without a reload.
 */
export function useAddConversationMember(conversationId: string | null, workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddConversationMemberInput) => {
      if (!conversationId) {
        throw new Error("no conversation selected");
      }
      return api<ConversationMembersResponse>(apiPaths.conversationMembers(conversationId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      if (conversationId) {
        qc.invalidateQueries({
          queryKey: ["conversation-members", conversationId],
        });
      }
      if (workspaceId) {
        qc.invalidateQueries({
          queryKey: ["workspaces", workspaceId, "members"],
        });
      }
    },
  });
}
