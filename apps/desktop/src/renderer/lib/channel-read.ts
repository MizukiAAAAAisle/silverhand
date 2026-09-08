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
 * Returns the new snapshot to observe, or `null` to skip. Record it only on success.
 *
 * Keep the visible ordinal as MessageSeq throughout recovery. The existing
 * streamSourceAtSeq builder is the sole MessageSeq → ReadSeq bridge; retries
 * must not resolve a newer, unseen server head.
 */
import type { MessageSeq } from "@silverhand/shared";
import { ApiError } from "./api";

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

/** One visible-tail observation, with bounded recovery for the SAME snapshot.
 * The effect owner cancels this on loss of visibility/membership or tail change.
 * Completion is recorded only after the server acknowledges the write. */
export function observeVisibleTail(
  mark: TailReadMark,
  observe: (mark: TailReadMark) => Promise<unknown>,
  acknowledged: (mark: TailReadMark) => void,
): () => void {
  const delays = [250, 750, 1_500];
  let cancelled = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async (): Promise<void> => {
    try {
      await observe(mark);
      if (!cancelled) acknowledged(mark);
    } catch (error) {
      const transient =
        error instanceof ApiError
          ? error.status === 0 || error.status === 429 || error.status >= 500
          : error instanceof TypeError; // fetch/network failure
      if (cancelled || !transient || attempts >= delays.length) return;
      timer = setTimeout(() => {
        void attempt();
      }, delays[attempts++]);
    }
  };
  void attempt();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
