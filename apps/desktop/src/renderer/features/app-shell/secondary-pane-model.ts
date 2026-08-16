import { useMemo } from 'react';
import { useConversationById } from '@/features/conversations/useConversationById';
import {
  selectFocusedConversation,
  selectSecondaryDescriptor,
  selectVisibleConversations,
  type ConversationPointer,
  type SecondaryDescriptor,
} from '@/lib/secondary-pane';

/**
 * Secondary-pane view model, lifted out of `RegisteredAppShell`.
 *
 * The right-hand pane is driven by `?side=<id>` (overlay). The selectors in
 * `lib/secondary-pane` resolve it into:
 *   - `secondaryDescriptor`  what the right pane renders (resolved channel, an
 *     unresolved placeholder, or null).
 *   - `visibleConversations` { primary, secondary } — drives message read-cursor
 *     advancement.
 *   - `focusedConversation`  single id for toast suppression / IPC
 *     setActiveConversation / notification badge clearing. A resolved secondary
 *     wins over primary for focus.
 *
 * `primaryPointer` and `sideRef` are internal — no consumer outside this cluster
 * reads them, so they aren't returned.
 *
 * The PRIMARY pointer arrives already resolved (#task:2035). This model used to
 * look the selection up in the workspace channel list itself, which silently
 * excluded the one placement that is not in any such list — a `direct_pair`, whose
 * pane then advanced no read cursor and never took focus. Resolving the carrier is
 * the shell's job because only the shell knows which carrier the route named; this
 * cluster's job is `?side`.
 */
export function useSecondaryPaneModel(params: {
  primary: ConversationPointer | null;
  sideConversationId: string | null;
  selectedWorkspaceId: string | null;
  routeFullscreen: boolean;
}): {
  secondaryDescriptor: SecondaryDescriptor | null;
  visibleConversations: ReturnType<typeof selectVisibleConversations>;
  focusedConversation: ReturnType<typeof selectFocusedConversation>;
} {
  const {
    primary: primaryPointer,
    sideConversationId,
    selectedWorkspaceId,
    routeFullscreen,
  } = params;


  // PR-2: cross-workspace `?side=<id>` resolution. The ref hook is the single
  // source of truth for the right pane's identity & workspace — same-workspace
  // and cross-workspace ids both flow through it. The fetch is React-Query–
  // cached (30s stale, 5min gc) so navigating back to a recently-opened side
  // hits the cache without a round-trip.
  const sideRef = useConversationById(sideConversationId);
  const secondaryDescriptor = useMemo<SecondaryDescriptor | null>(
    () => selectSecondaryDescriptor({ sideConversationId }, sideRef),
    [sideConversationId, sideRef],
  );
  // Workspace metadata for a `?side` resolved descriptor flows through
  // `secondaryViewInputs` (built in the shell) — no separate memo needed.
  const visibleConversations = useMemo(
    () =>
      selectVisibleConversations({
        primary: primaryPointer,
        secondary: secondaryDescriptor,
        fullscreen: routeFullscreen,
      }),
    [primaryPointer, secondaryDescriptor, routeFullscreen],
  );
  const focusedConversation = useMemo(
    () =>
      selectFocusedConversation({
        primary: primaryPointer,
        primaryWorkspaceId: selectedWorkspaceId,
        secondary: secondaryDescriptor,
        fullscreen: routeFullscreen,
      }),
    [primaryPointer, selectedWorkspaceId, secondaryDescriptor, routeFullscreen],
  );

  return { secondaryDescriptor, visibleConversations, focusedConversation };
}
