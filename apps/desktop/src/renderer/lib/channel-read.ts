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
 */
export interface TailReadMark {
  channelId: string;
  seq: number;
}

export function nextTailReadMark(
  prev: TailReadMark | null,
  channelId: string,
  tailSeq: number | null,
  isAtTail: boolean,
  hasNewerLiveGap: boolean,
): TailReadMark | null {
  if (tailSeq === null || !isAtTail || hasNewerLiveGap) return null;
  if (prev && prev.channelId === channelId && prev.seq === tailSeq) return null;
  return { channelId, seq: tailSeq };
}
