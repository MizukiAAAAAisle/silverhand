import { useMemo } from "react";
import { useConversationIdentity } from "@/features/conversations/conversation-identity";
import {
  selectFocusedConversation,
  selectSecondaryDescriptor,
  selectVisibleConversations,
  type ConversationPointer,
  type SecondaryDescriptor,
} from "@/lib/secondary-pane";

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
 * `primaryPointer` and `sideIdentity` are internal — no consumer outside this
 * cluster reads them, so they aren't returned.
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

  // `?side=<id>` resolution (#task:2038). `useConversationIdentity` is the single
  // source of truth for the right pane's identity: the workspace face for a
  // channel in ANY workspace, plus the viewer's own direct-pair list — the only
  // face that can name a private line, whose 404 from `/ref` is the correct
  // answer rather than a gap. Both faces are React-Query–cached, and an id the
  // pair list already names costs no request at all.
  const sideIdentity = useConversationIdentity(sideConversationId);
  const secondaryDescriptor = useMemo<SecondaryDescriptor | null>(
    () => selectSecondaryDescriptor({ sideConversationId }, sideIdentity),
    [sideConversationId, sideIdentity],
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
