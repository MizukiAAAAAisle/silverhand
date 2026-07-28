import { useMutation, useQuery } from '@tanstack/react-query';
import type { MessageReactionDetailDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

/**
 * Add / remove the viewer's reaction on a message (S4, #task:1122).
 *
 * The backend broadcasts `message_reaction_changed` (post-commit) to the
 * `conversation:<cid>` scope, and `useChannelMessages` patches the message
 * cache from that event with the server's authoritative `count` — so this
 * mutation does NO cache work itself. Count stays single-sourced from the
 * server (docs/reactions-design.md §5.2: count is absolute-assigned, never
 * op-derived on the client), which keeps the viewer's own toggle and other
 * reactors' changes drift-free under WS replay / reorder.
 */
export function useToggleReaction() {
  return useMutation({
    mutationFn: async (input: {
      messageId: string;
      emoji: string;
      remove: boolean;
    }) => {
      await api<unknown>(apiPaths.messageReactions(input.messageId), {
        method: input.remove ? 'DELETE' : 'POST',
        body: JSON.stringify({ emoji: input.emoji }),
      });
    },
  });
}

/** Cache key for one message's lazy reactor detail (hover "who reacted").
 *  Exported so the WS `message_reaction_changed` handler can invalidate it
 *  when a reaction lands — otherwise a hovered list stays stale for
 *  `staleTime` even though the chip count already moved (#task:1122 review,
 *  P1.2). */
export const messageReactorsKey = (messageId: string) =>
  ['message-reactions', messageId] as const;

/** Prefix of every message's reactor-detail key. Exported for the one thing a
 *  per-message key can't express: a profile write changes the denormalized
 *  `ReactionReactorDto.display_name` in EVERY cached reactor list, and the
 *  identity-carrier registry has no message id in hand
 *  (`features/identity/identity-carrier-caches.ts`). */
export const messageReactorsKeyPrefix = ['message-reactions'] as const;

/**
 * Lazy reactor detail for the hover tooltip ("who reacted"). Fetched only
 * while a chip is hovered (`enabled`) and kept OFF the message-window DTO
 * (docs/reactions-design.md §6 perf) — the window carries only the lean
 * `{emoji,count,viewer_reacted}` aggregate. Returns one entry per emoji
 * with the reactors' display names.
 */
export function useMessageReactors(messageId: string, enabled: boolean) {
  return useQuery({
    queryKey: messageReactorsKey(messageId),
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      const res = await api<{ reactions: MessageReactionDetailDto[] }>(
        apiPaths.messageReactions(messageId),
      );
      return res.reactions;
    },
  });
}
