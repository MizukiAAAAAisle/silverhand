import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiPaths,
  type AddConversationMemberInput,
  type ConversationMembersResponse,
} from '@silverhand/shared';
import { api } from '@/lib/api';

/**
 * Add a member (agent or human) to a channel- or thread-kind
 * conversation.
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
 *   - Agent candidates must already be members of this conversation's
 *     workspace (`workspace_membership_required` 422). Human candidates
 *     may be outside the workspace for admin/owner callers; the server
 *     provisions workspace membership as part of the same
 *     permission-protected add action.
 *   - Conversation must be `kind === 'channel'` and not
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
 * workspace members because a human add may have provisioned workspace
 * membership under the hood.
 */
export function useAddConversationMember(
  conversationId: string | null,
  workspaceId?: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddConversationMemberInput) => {
      if (!conversationId) {
        throw new Error('no conversation selected');
      }
      return api<ConversationMembersResponse>(
        apiPaths.conversationMembers(conversationId),
        { method: 'POST', body: JSON.stringify(input) },
      );
    },
    onSuccess: () => {
      if (conversationId) {
        qc.invalidateQueries({
          queryKey: ['conversation-members', conversationId],
        });
      }
      if (workspaceId) {
        qc.invalidateQueries({
          queryKey: ['workspaces', workspaceId, 'members'],
        });
      }
    },
  });
}
