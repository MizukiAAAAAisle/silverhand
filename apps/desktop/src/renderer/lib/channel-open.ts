/**
 * Channel-open precedence (#task:1082).
 *
 * When the user switches into a channel, three signals compete for the
 * secondary pane. The precedence was locked with @Cindy:
 *
 *   1. **unread-target** — a fresh reply landed in one of the channel's
 *      threads (the unread pointer carries a `thread_root_id`) and it
 *      post-dates the explicit-close watermark (`seq > watermark`).
 *      Surface that thread and locate the message.
 *   2. **layout-memory** — otherwise restore the channel's remembered
 *      secondary-pane layout ({@link ChannelLayout}).
 *   3. **main stream** — a `layout` of `none`/`null` collapses to the
 *      bare channel at the URL builder.
 *
 * The close-watermark makes an explicit close the stronger intent: the
 * unread batch you just dismissed is NOT yanked back on re-entry, but a
 * genuinely newer reply (higher `seq`) still re-surfaces. The resolver is
 * pure so the precedence is unit-tested independent of React/nav wiring.
 */

import type { MessageUnreadPointerDto } from '@silverhand/shared';
import type { ChannelLayout } from '@/router';

export type ChannelOpenIntent =
  | { kind: 'unread-thread'; threadRootId: string; messageId: string }
  | { kind: 'layout'; layout: ChannelLayout | null };

export function resolveChannelOpen(
  pointer: MessageUnreadPointerDto | undefined,
  closeWatermark: number | null,
  layout: ChannelLayout | null,
): ChannelOpenIntent {
  if (pointer?.thread_root_id && pointer.seq > (closeWatermark ?? -1)) {
    return {
      kind: 'unread-thread',
      threadRootId: pointer.thread_root_id,
      messageId: pointer.message_id,
    };
  }
  return { kind: 'layout', layout };
}
