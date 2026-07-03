import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConversationById } from '@/features/conversations/useConversationById';
import type { MessageJumpTarget } from '@/features/channels/useMessageJumpController';
import {
  selectSecondaryDescriptor,
  selectSecondaryViewInputs,
  type SecondaryDescriptor,
} from '@/lib/secondary-pane';

// The Activity source pane target. Distinct from `MessageJumpTarget`: a source
// opened from a ROW carries a message anchor, but a `#conv` ref opened in-panel
// has NONE — so `messageId` is optional here (no `''` sentinel). The optionality
// is load-bearing: only an anchored source primes a jump / message-jumps on
// "Open in conversation" (Cindy review blocker 3).
export type ActivitySourceTarget = {
  workspaceId?: string;
  channelId: string;
  threadRootId?: string | null;
  messageId?: string | null;
};

/** Minimal shape of a mark-read mutation (`mutate(channelId)`). */
type MarkReadMutation = { mutate: (channelId: string) => void };

/**
 * Activity source pane state + derivations (#task:1227 point 2), lifted out of
 * `RegisteredAppShell`. Clicking an Activity row opens the row's REAL
 * conversation/thread source as a working side panel INSIDE the Activity view
 * ("side panel 是真实可以工作的地方，就跟 thread side panel 一样，并不是 previewer").
 * It reuses the live ChannelView / ThreadPanel, so reading happens through the
 * source's own path — the Attention layer writes NO clearing state of its own.
 * Resolved independently of the global `?side`/`?thread` nav so opening a source
 * here never perturbs the channel view's selection. Cross-workspace is
 * automatic: ChannelView is descriptor-driven and ThreadPanel takes explicit
 * props, and neither assumes the session-current workspace.
 *
 * The JSX for the pane itself stays in the shell (it wires many shell handlers);
 * this hook owns the state + resolution + read-cursor effect only.
 */
export function useActivitySource(params: {
  view: string;
  requestJump: (target: MessageJumpTarget) => void;
  isPrimePendingFor: (channelId: string, messageId: string) => boolean;
  markMessageChannelRead: MarkReadMutation;
  markConversationNotificationsRead: MarkReadMutation;
}) {
  const {
    view,
    requestJump,
    isPrimePendingFor,
    markMessageChannelRead,
    markConversationNotificationsRead,
  } = params;

  const [activitySource, setActivitySource] =
    useState<ActivitySourceTarget | null>(null);
  const openActivitySource = useCallback(
    (target: MessageJumpTarget) => {
      setActivitySource(target);
      // Row items always carry a message anchor — prime the around-window so the
      // source pane scroll-locates the triggering message.
      if (target.messageId) requestJump(target);
    },
    [requestJump],
  );
  const closeActivitySource = useCallback(() => setActivitySource(null), []);
  // Every fresh entry into Activity starts collapsed — opening the view must not
  // re-open a source pane docked in a prior visit. Clearing on LEAVE (view flips
  // away from 'activity') means the next entry always finds a null source, so
  // the side panel only opens on an explicit row click (#task:1269 item 5).
  useEffect(() => {
    if (view !== 'activity') setActivitySource(null);
  }, [view]);
  // A #conv ref clicked INSIDE the docked source swaps the right pane to that
  // conversation (the panel is a real working viewer), instead of writing a
  // hidden global `?side` the Activity branch never renders (Cindy review
  // blocker 2). No message anchor → no scroll-jump, no mark-read until resolved.
  const openActivitySourceConversation = useCallback((conversationId: string) => {
    setActivitySource({ channelId: conversationId });
  }, []);
  // A source's identity (workspace, kind, parent title, closed/archived) comes
  // from the same ref hook the secondary pane uses — for a thread item the id is
  // the PARENT channel, so this resolves the channel either way.
  const activitySourceRef = useConversationById(
    activitySource?.channelId ?? null,
  );
  const activitySourceDescriptor = useMemo<SecondaryDescriptor | null>(
    () =>
      activitySource
        ? selectSecondaryDescriptor(
            { sideConversationId: activitySource.channelId },
            activitySourceRef,
          )
        : null,
    [activitySource, activitySourceRef],
  );
  const activitySourceViewInputs = useMemo(
    () =>
      selectSecondaryViewInputs({
        secondary: activitySourceDescriptor,
        primaryChannelKind: null,
        primaryWorkspaceId: activitySource?.workspaceId ?? null,
      }),
    [activitySourceDescriptor, activitySource],
  );
  // Per-pane jump targets, mirroring the secondary/thread derivations.
  const activityChannelJumpTarget = useMemo(
    () =>
      activitySource && !activitySource.threadRootId && activitySource.messageId
        ? {
            channelId: activitySource.channelId,
            messageId: activitySource.messageId,
          }
        : null,
    [activitySource],
  );
  const activityChannelJumpPrimePending = useMemo(
    () =>
      activityChannelJumpTarget !== null &&
      isPrimePendingFor(
        activityChannelJumpTarget.channelId,
        activityChannelJumpTarget.messageId,
      ),
    [isPrimePendingFor, activityChannelJumpTarget],
  );
  const activityThreadJumpMessageId =
    activitySource?.threadRootId && activitySource.messageId
      ? activitySource.messageId
      : null;
  const activityThreadJumpPrimePending = useMemo(
    () =>
      activityThreadJumpMessageId !== null &&
      activitySource !== null &&
      isPrimePendingFor(activitySource.channelId, activityThreadJumpMessageId),
    [isPrimePendingFor, activityThreadJumpMessageId, activitySource],
  );
  // Opening a channel/DM source in the Activity side panel counts as reading
  // that stream ("打开 side panel 算已读"), exactly like a route pane becoming
  // visible. Route it through the SAME source cursor mutation — Activity owns no
  // read state of its own (Cindy review blocker 1). Keyed by a dedicated guard so
  // it never races the route panes' refs.
  //
  // Gate on a RESOLVED channel/DM (Cindy review blocker 3): `conversationDescriptor`
  // is non-null exactly for a resolved channel/dm, so a `#conv` pointing at a
  // legacy thread / not_found / unauthorized id never gets a cursor write before
  // we know it is a real mainline stream. Thread sources carry `threadRootId`
  // and are excluded — ThreadPanel advances its own snapshot-gated reply cursor.
  const activitySourceReadChannelId =
    activitySource &&
    !activitySource.threadRootId &&
    activitySourceViewInputs.conversationDescriptor
      ? activitySource.channelId
      : null;
  const lastActivitySourceReadKey = useRef<string | null>(null);
  useEffect(() => {
    if (!activitySourceReadChannelId) {
      lastActivitySourceReadKey.current = null;
      return;
    }
    if (lastActivitySourceReadKey.current === activitySourceReadChannelId) return;
    lastActivitySourceReadKey.current = activitySourceReadChannelId;
    markMessageChannelRead.mutate(activitySourceReadChannelId);
    // Opening an Activity item's source IS an active eliminate intent, and the
    // line above advances the cursor to stream head — so clearing this
    // conversation's notification badges here is self-consistent (read_at and
    // cursor move together, no divergence). This is the legitimate active
    // counterpart to the removed passive focus-drain: it also reaches anchorless
    // `agent_start_failed` that the cursor overlap can't. (`requestJump` no
    // longer clears badges — it pushes the cursor via stream observe instead.)
    markConversationNotificationsRead.mutate(activitySourceReadChannelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activitySourceReadChannelId]);

  return {
    activitySource,
    openActivitySource,
    closeActivitySource,
    openActivitySourceConversation,
    activitySourceRef,
    activitySourceDescriptor,
    activitySourceViewInputs,
    activityChannelJumpTarget,
    activityChannelJumpPrimePending,
    activityThreadJumpMessageId,
    activityThreadJumpPrimePending,
  };
}
