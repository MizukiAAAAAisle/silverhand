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
 *   - Candidate must already be a member of this conversation's
 *     workspace (`workspace_membership_required` 422). The picker
 *     hides non-workspace candidates so this branch is rarely hit,
 *     but races (member removed mid-pick) still surface as the
 *     locked error code.
 *   - Conversation must be `kind === 'channel' || 'thread'` and not
 *     closed (`conversation_member_add_unsupported` 422 /
 *     `conversation_closed` 409). The trigger button hides on DM
 *     channels + closed conversations, so these are also defense-in-
 *     depth.
 *   - Duplicate adds are 200 no-op and return the current members
 *     list — the mutation never throws on idempotent retries.
 *
 * On success we invalidate the conversation members cache so the
 * conversation header member strip + any open `useConversationMembers`
 * subscriber refresh. We do NOT invalidate workspace members because
 * the candidate was already a workspace member by precondition.
 */
export function useAddConversationMember(conversationId: string | null) {
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
    },
  });
}
