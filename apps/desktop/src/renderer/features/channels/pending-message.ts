// Renderer-only optimistic-message type (S2 #task:1267 slice B).
//
// The messages cache holds two genuinely different things and used to fake the
// distinction with an `id: 'pending-<uuid>'` convention + a `seq: Date.now()`
// stand-in. Once #task:1266 brands `MessageDto.seq` as `MessageSeq`, that fake
// stops compiling — and that is the point: a pending optimistic message has NO
// conversation MessageSeq (the server allocates it via `reserveNextSeq` only on
// commit), so it must not wear one. This module makes the distinction a type,
// not a naming convention.
//
// PendingMessage is RENDERER-ONLY: it never crosses the wire, so it lives here
// and NOT in `@silverhand/shared` (which owns wire DTOs). The contract's
// "carries tempId + createdAtLocal, NOT a seq" (brand-typed-seq-v1 §6 Q5) is
// realized as: `id` is the temp id (`pending-<uuid>`), `created_at` is the
// honest local send time (an epoch-ms wall-clock, not a seq), and the `pending`
// literal is the discriminant. No `PendingSeq` brand — modelling a quantity
// that must never be ordered against a real MessageSeq would invite the exact
// mix the split removes.

import type { MessageDto, MessageSeq } from '@silverhand/shared';

/**
 * An optimistic message shown immediately on send, before the server ack. Has
 * every {@link MessageDto} field EXCEPT `seq` (there is no server ordinal yet),
 * plus a `pending: true` discriminant. Ordered to the tail by insertion, never
 * by a seq compare.
 */
export type PendingMessage = Omit<MessageDto, 'seq'> & {
  readonly pending: true;
};

/** A message in the renderer cache: a committed server row, or an optimistic
 *  pending row awaiting its ack. Reading `.seq` requires narrowing to the
 *  committed side first — the whole reason for the split. */
export type CachedMessage = MessageDto | PendingMessage;

/** Narrow to the optimistic side (no server seq). */
export const isPendingMessage = (m: CachedMessage): m is PendingMessage =>
  'pending' in m && m.pending === true;

/** Narrow to the committed side (has a `MessageSeq`). */
export const isCommittedMessage = (m: CachedMessage): m is MessageDto =>
  !isPendingMessage(m);

/** The seq of the newest committed row, scanning from the tail; `null` if the
 *  window holds no committed message. Pending rows are skipped — they have no
 *  MessageSeq, and a mark-read / tail gate must fire off a real ordinal, never
 *  a would-be optimistic value (§3.3/§3.5). */
export const lastCommittedSeq = (
  messages: readonly CachedMessage[],
): MessageSeq | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isCommittedMessage(m)) return m.seq;
  }
  return null;
};
