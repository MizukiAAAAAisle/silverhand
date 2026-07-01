/**
 * Read-cursor advancement decision for the channel mainline (#task:1255 P1c /
 * #task:1244 read-inert axis).
 *
 * ChannelView marks a channel read off the mainline CACHE, not off frame
 * arrival — read advancement is visibility/intent-driven, never
 * arrival-driven. This pure helper encodes exactly when the visible tail
 * warrants advancing the read cursor:
 *
 *   - only while the window is genuinely AT TAIL (`isAtTail && !hasNewerLiveGap`)
 *     — scrolled-into-history (`!isAtTail`) or a known live gap must NOT mark;
 *   - only when the newest mainline row actually ADVANCED past the last mark —
 *     a reply-only frame bumps a thread badge but never enters the mainline
 *     list, so `tailSeq` is unchanged and this returns null (no mark);
 *   - re-marks across a channel switch (the `channelId` differs).
 *
 * Returns the new mark to record + mutate, or `null` to skip.
 *
 * #task:1267 §3.5: `seq` here is a LOCAL MessageSeq gate — it decides WHETHER to
 * fire the mark, but the mark itself resolves to the server stream head (no
 * seq), so this is NOT a MessageSeq → ReadSeq conversion. Branding it MessageSeq
 * keeps the `prev.seq === tailSeq` compare a same-stream (same channel)
 * MessageSeq↔MessageSeq comparison; do NOT mint a ReadSeq here.
 */
import type { MessageSeq } from '@silverhand/shared';

export interface TailReadMark {
  channelId: string;
  seq: MessageSeq;
}

export function nextTailReadMark(
  prev: TailReadMark | null,
  channelId: string,
  tailSeq: MessageSeq | null,
  isAtTail: boolean,
  hasNewerLiveGap: boolean,
): TailReadMark | null {
  if (tailSeq === null || !isAtTail || hasNewerLiveGap) return null;
  if (prev && prev.channelId === channelId && prev.seq === tailSeq) return null;
  return { channelId, seq: tailSeq };
}
