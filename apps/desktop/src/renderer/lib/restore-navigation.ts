/**
 * Route-restore precedence (#task:1300, extracted from App's auto-select
 * effect).
 *
 * When the chat route resolves to a workspace with NO channel selected
 * (bare `/chat/w/:id`, or after a clear), one of several signals decides
 * which channel to open. The precedence — locked across #task:1082 /
 * #task:1145 and mirrored from the original inline effect — is:
 *
 *   1. **honored jump** — a pending {@link MessageJumpTarget} names a channel
 *      that exists in this workspace: go there (Saved → jump must not snap
 *      back to the remembered/default channel).
 *   2. **remembered channel** — the per-workspace last-viewed channel, unless
 *      it's the just-archived primary (`excludeId`) or no longer exists. Its
 *      secondary-pane intent is resolved by {@link resolveChannelOpen}: a
 *      fresh unread thread (past the close-watermark) surfaces that thread,
 *      otherwise the remembered layout is restored.
 *   3. **default fallback** — the first active top-level channel, excluding a
 *      just-archived primary still lingering in the stale list.
 *   4. **none** — no workspace / a channel is already selected / no channels /
 *      no fallback: do nothing.
 *
 * This resolver is PURE: it reads no refs, no module singletons, and performs
 * no navigation. The caller reads the current ref / place-memory / unread
 * state, calls this, and executes the returned action. That keeps the
 * load-bearing precedence unit-testable independent of React/nav wiring,
 * while every side effect stays in the effect.
 */

import type { MessageUnreadPointerDto, MessageSeq } from '@silverhand/shared';
import type { ChannelLayout } from '@/router';
import { resolveChannelOpen } from '@/lib/channel-open';
import { pickDefaultChannel } from '@/lib/archive-fallback';

export interface RestoreNavigationInputs {
  /** Route workspace id (`null` when the route has no workspace). */
  workspaceId: string | null;
  /** Route channel id — restore only runs when this is `null`. */
  selectedChannelId: string | null;
  /** All channels in the workspace (existence checks for jump / remembered). */
  channels: readonly { id: string }[];
  /** Active top-level channels in sidebar order — the fallback source. */
  activeTopLevel: readonly { id: string }[];
  /** Channel a pending jump wants to land on, if any. */
  jumpTargetChannelId: string | null;
  /** Just-archived primary to exclude from remembered + fallback (#task:1145). */
  excludeId: string | null;
  /** Per-workspace last-viewed channel (`null` if none remembered). */
  rememberedChannelId: string | null;
  /** Unread pointer for the remembered channel (for {@link resolveChannelOpen}). */
  rememberedUnreadPointer: MessageUnreadPointerDto | undefined;
  /** Explicit-close watermark for the remembered channel. */
  rememberedCloseWatermark: MessageSeq | null;
  /** Remembered secondary-pane layout for the remembered channel. */
  rememberedLayout: ChannelLayout | null;
}

export type RestoreNavigation =
  | { kind: 'none' }
  /** Navigate to a bare channel URL. `reason` is for tests; the caller
   *  builds the same URL either way. */
  | { kind: 'open-channel'; channelId: string; reason: 'jump' | 'fallback' }
  /** Navigate to the remembered channel restoring its secondary-pane layout. */
  | { kind: 'open-remembered'; channelId: string; layout: ChannelLayout | null }
  /** Jump to a fresh unread thread in the remembered channel. */
  | { kind: 'jump-unread'; channelId: string; messageId: string; threadRootId: string };

export function resolveRestoreNavigation(
  inputs: RestoreNavigationInputs,
): RestoreNavigation {
  const {
    workspaceId,
    selectedChannelId,
    channels,
    activeTopLevel,
    jumpTargetChannelId,
    excludeId,
    rememberedChannelId,
    rememberedUnreadPointer,
    rememberedCloseWatermark,
    rememberedLayout,
  } = inputs;

  if (!workspaceId) return { kind: 'none' };
  if (selectedChannelId) return { kind: 'none' };
  if (channels.length === 0) return { kind: 'none' };

  // 1. A jump asked for a specific channel — honor it instead of the
  //    remembered/default so Saved → jump doesn't snap back.
  if (jumpTargetChannelId && channels.some(s => s.id === jumpTargetChannelId)) {
    return { kind: 'open-channel', channelId: jumpTargetChannelId, reason: 'jump' };
  }

  // 2. Remembered channel — unless it's the just-archived primary or gone.
  if (
    rememberedChannelId &&
    rememberedChannelId !== excludeId &&
    channels.some(s => s.id === rememberedChannelId)
  ) {
    const intent = resolveChannelOpen(
      rememberedUnreadPointer,
      rememberedCloseWatermark,
      rememberedLayout,
    );
    if (intent.kind === 'unread-thread') {
      return {
        kind: 'jump-unread',
        channelId: rememberedChannelId,
        messageId: intent.messageId,
        threadRootId: intent.threadRootId,
      };
    }
    return { kind: 'open-remembered', channelId: rememberedChannelId, layout: intent.layout };
  }

  // 3. Default: first active top-level, excluding a just-archived primary.
  const fallbackId = pickDefaultChannel(activeTopLevel, excludeId);
  if (!fallbackId) return { kind: 'none' };
  return { kind: 'open-channel', channelId: fallbackId, reason: 'fallback' };
}
