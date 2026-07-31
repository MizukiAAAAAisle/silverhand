// The renderer's reaction bounded context: the two committed-reaction
// convergence seams (the ordered WS plane's absolute patch and the write ACK's
// authoritative re-read), the viewer's toggle mutation, and the lazy
// reactor-detail read (docs/reactions-design.md §5.3 / §3.5). The WS ingestor is
// a CALLER of the seam here, not a second implementation of it.
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  MessageReactionDetailDto,
  ReactionMutationAck,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import {
  type CommittedReaction,
  applyReactionToMessage,
  invalidateMessageRowInActiveProjections,
  patchMessageInActiveProjections,
} from '@/features/channels/projection-cache';
import { api } from '@/lib/api';

/** Cache key for one message's lazy reactor detail (hover "who reacted").
 *  Refreshed by both convergence seams below when a reaction lands — otherwise a
 *  hovered list stays stale for `staleTime` even though the chip count already
 *  moved (#task:1122 review, P1.2). */
export const messageReactorsKey = (messageId: string) =>
  ['message-reactions', messageId] as const;

/** Prefix of every message's reactor-detail key. Exported for the one thing a
 *  per-message key can't express: a profile write changes the denormalized
 *  `ReactionReactorDto.display_name` in EVERY cached reactor list, and the
 *  identity-carrier registry has no message id in hand
 *  (`features/identity/identity-carrier-caches.ts`). */
export const messageReactorsKeyPrefix = ['message-reactions'] as const;

/**
 * Converge a committed reaction carried by the ORDERED plane — the
 * `message_reaction_changed` WS event (#task:1753).
 *
 * This is the fast path: one ordered stream per scope, with replay and a
 * `snapshot_required` gap fence, so the frame's absolute aggregate can be
 * ASSIGNED (`docs/reactions-design.md` §5.3). It fans that merge out to every
 * displayed projection and refreshes the reactor detail. Replay-idempotent, and
 * free when the value already matches (the merge returns its input, so the cache
 * reference doesn't churn).
 *
 * The viewer's own write does NOT come through here — see
 * {@link recoverCommittedReactionsAfterWrite}.
 *
 * Deliberately NOT here:
 *  - transport floor / satisfaction — the WS wrapper alone owns that
 *    (`ingestReaction`), so no other caller can advance a resume water-mark;
 *  - warm-inactive caches — reaction's active-only scope is unchanged; a closed
 *    window re-reads authoritatively on open.
 *
 * Returns `applied` = at least one displayed projection held the row (the
 * synchronous content-apply signal the WS wrapper reports to the floor). An
 * equal-value merge still counts: the row is present and converged.
 */
export function applyCommittedReactionFromEvent(
  qc: QueryClient,
  delta: CommittedReaction,
): boolean {
  const applied = patchMessageInActiveProjections(qc, delta.target, message =>
    applyReactionToMessage(message, delta),
  );
  // FIRE-AND-FORGET, authoritative-on-open: refresh the open "who reacted"
  // popover. Fired regardless of row writes and never counted in `applied` — it
  // self-heals on next open, so it stays off the resume floor.
  void qc.invalidateQueries({
    queryKey: messageReactorsKey(delta.target.messageId),
  });
  return applied;
}

/** The row a reaction chip belongs to, plus the intent — the mutation's input.
 *  `target` is read off the rendered row (its `conversation_id` /
 *  `thread_root_id` / `id`), never re-derived from view state. */
export type ToggleReactionInput = {
  target: CommittedReaction['target'];
  emoji: string;
  remove: boolean;
};

/**
 * Converge the viewer's OWN committed write — the ACK plane (#task:1753 review).
 *
 * The ACK reports the server's post-change aggregate, but the renderer must not
 * assign it: an ACK shares no ordering axis with the WS stream, nor with a second
 * local toggle's ACK, so a late-arriving OLDER absolute value would overwrite a
 * newer committed one and STICK there until the next reaction. So the ACK is a
 * FRESHNESS TRIGGER: invalidate the row in every displayed projection plus the
 * reactor detail, and let one bounded authoritative round decide the value —
 * ordering stops mattering, because whichever ACK lands last re-reads the same
 * server state. `docs/reactions-design.md` §5.3 carries the full contract,
 * including why the ordered plane may assign and why a domain revision (not a
 * borrowed transport seq) is the only way to make this plane assign too.
 *
 * `changed:false` triggers it exactly like a real change: the ACK's diagnostic
 * bit says the stored state already matched the request (§3.3), which is not a
 * statement about what this cache holds — hence no ACK payload in the signature.
 */
export function recoverCommittedReactionsAfterWrite(
  qc: QueryClient,
  target: CommittedReaction['target'],
): Promise<void> {
  return Promise.all([
    invalidateMessageRowInActiveProjections(qc, target),
    qc.invalidateQueries({ queryKey: messageReactorsKey(target.messageId) }),
  ]).then(() => undefined);
}

/**
 * Add / remove the viewer's reaction on a message (S4, #task:1122).
 *
 * A committed write converges through {@link recoverCommittedReactionsAfterWrite}
 * — an authoritative re-read, not a patch (#task:1753 review), and not an
 * optimistic pre-ACK write either: under an absolute-count model a local +/- is
 * exactly the drift §5.2 forbids, and since nothing is written before the server
 * commits, a failed write needs no rollback. The WS echo remains free to arrive
 * and converge the same row on the fast path.
 */
export function useToggleReaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ToggleReactionInput) => {
      return await api<ReactionMutationAck>(
        apiPaths.messageReactions(input.target.messageId),
        {
          method: input.remove ? 'DELETE' : 'POST',
          body: JSON.stringify({ emoji: input.emoji }),
        },
      );
    },
    onSuccess: (_ack, input) => {
      // RETURNED, not fire-and-forget: the mutation stays pending until the
      // authoritative round lands, so `isPending` spans the whole convergence
      // rather than reporting success while the cache still shows the old value.
      return recoverCommittedReactionsAfterWrite(qc, input.target);
    },
  });
}

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
