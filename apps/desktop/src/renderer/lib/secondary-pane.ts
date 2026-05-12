/**
 * Pure selectors for the right-hand secondary pane introduced in PR-1.
 *
 * These functions encode the URL → "what's on the right side" decision
 * tree (and the read-cursor / focus split that drives it). They're
 * deliberately pure so that:
 *
 *   1. App.tsx stays thin — just plumbing route state + the resolved
 *      channels list into these helpers.
 *   2. Unit tests can exercise the URL → state matrix without
 *      mounting React.
 *
 * Vocabulary (Cindy review of PR-1, msg 1dCUdyZ-H7k30mcJ):
 *
 *   - `secondaryDescriptor` — what the right pane shows. Source can be
 *     `?side=<id>` (overlay) or `/t/<tid>` (legacy thread fallback);
 *     `side` always wins when both are present. May be `unresolved`
 *     when a `?side` id isn't in the current-workspace lookup; the UI
 *     renders a placeholder rather than silently dropping the URL.
 *   - `visibleConversations` — set of conversations whose pane is
 *     currently on screen. Drives message read-cursor advancement.
 *     Fullscreen collapses to just the displayed pane; unresolved side
 *     contributes no read cursor (nothing real to mark read).
 *   - `focusedConversation` — the *one* conversation the user is
 *     considered to be focused on. Drives toast suppression, notification
 *     badge clearing, and the IPC `setActiveConversation` payload (which
 *     only accepts a single id). Rule: secondary > primary; in
 *     fullscreen, the visible pane wins.
 */

/** Minimal shape needed to look up whether a `?side=<id>` exists in the
 *  current workspace. Anything matching ChannelListItem from
 *  workspaces/hooks satisfies this. */
export interface SecondaryLookupChannel {
  id: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  parent_conversation_id: string | null;
  workspace_id: string;
}

export type SecondaryDescriptor =
  | {
      source: 'side';
      status: 'resolved';
      id: string;
      kind: 'channel' | 'dm_channel' | 'thread';
      parentChannelId: string | null;
      workspaceId: string;
    }
  | {
      source: 'side';
      status: 'unresolved';
      id: string;
    }
  | {
      source: 'thread-path';
      status: 'resolved';
      id: string;
      kind: 'thread';
      parentChannelId: string;
      workspaceId: string;
    };

export interface SecondaryRouteInputs {
  /** From `useRouteState().sideConversationId`. */
  sideConversationId: string | null;
  /** From `useRouteState().threadId` — legacy `/t/<tid>` path segment. */
  threadId: string | null;
}

/**
 * Decide what the right-hand pane should show given URL state and the
 * current workspace's channels lookup.
 *
 * Priority: `?side=<id>` wins over `/t/<tid>` whenever it's present. A
 * side id that doesn't resolve to any channel in the lookup returns an
 * `unresolved` placeholder — Cindy review point 6 explicitly forbids
 * silently stripping the URL, so the UI must show a "this reference
 * isn't accessible" pane the user can dismiss.
 *
 * Cross-workspace `?side` resolution is deferred to PR-2 (`useConversationById`
 * + ref endpoint). PR-1 only resolves ids inside the current workspace's
 * channels union.
 */
export function selectSecondaryDescriptor(
  route: SecondaryRouteInputs,
  channels: readonly SecondaryLookupChannel[],
): SecondaryDescriptor | null {
  if (route.sideConversationId) {
    const hit = channels.find(c => c.id === route.sideConversationId);
    if (hit) {
      return {
        source: 'side',
        status: 'resolved',
        id: hit.id,
        kind: hit.kind,
        parentChannelId:
          hit.kind === 'thread' ? hit.parent_conversation_id : null,
        workspaceId: hit.workspace_id,
      };
    }
    return {
      source: 'side',
      status: 'unresolved',
      id: route.sideConversationId,
    };
  }
  if (route.threadId) {
    const hit = channels.find(c => c.id === route.threadId);
    if (hit && hit.kind === 'thread' && hit.parent_conversation_id) {
      return {
        source: 'thread-path',
        status: 'resolved',
        id: hit.id,
        kind: 'thread',
        parentChannelId: hit.parent_conversation_id,
        workspaceId: hit.workspace_id,
      };
    }
    // Thread id in URL but not (yet) in lookup: don't synthesize a
    // descriptor. App.tsx applies its existing ephemeral-thread fallback
    // and the parent-mismatch effect for these transient cases.
    return null;
  }
  return null;
}

/** Conversation pointer used by the read-cursor / focus selectors. */
export interface ConversationPointer {
  id: string;
  kind: 'channel' | 'dm_channel' | 'thread';
}

export interface VisibleConversations {
  /** The base channel pane. Hidden only when a secondary takes over the
   *  full viewport (fullscreen=1 + resolved secondary). */
  primary: ConversationPointer | null;
  /** The secondary pane. Null when there is no secondary or when the
   *  secondary is an unresolved placeholder (no real conversation to
   *  mark read). */
  secondary: ConversationPointer | null;
}

export interface VisibleSelectionInputs {
  primary: ConversationPointer | null;
  secondary: SecondaryDescriptor | null;
  fullscreen: boolean;
}

/**
 * Compute which conversations are currently *visible* to the user. This
 * drives `markMessageChannelRead` — a conversation must be on screen for
 * its read cursor to advance.
 *
 * Rules:
 *   - No secondary             → only primary visible.
 *   - Resolved secondary       → both visible (split) unless fullscreen,
 *                                in which case only the secondary.
 *   - Unresolved secondary     → only primary visible (placeholder pane
 *                                has no conversation to mark read).
 *   - Fullscreen + no secondary → only primary visible (fullscreen is a
 *                                no-op without a secondary).
 */
export function selectVisibleConversations(
  inputs: VisibleSelectionInputs,
): VisibleConversations {
  const { primary, secondary, fullscreen } = inputs;
  if (!secondary) {
    return { primary, secondary: null };
  }
  if (secondary.status !== 'resolved') {
    // Unresolved placeholder occupies the slot visually but has no
    // conversation id to mark read. Primary is still visible behind it.
    return { primary, secondary: null };
  }
  const secondaryPointer: ConversationPointer = {
    id: secondary.id,
    kind: secondary.kind,
  };
  if (fullscreen) {
    return { primary: null, secondary: secondaryPointer };
  }
  return { primary, secondary: secondaryPointer };
}

export interface FocusedConversation {
  id: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  /** Workspace id for the focused conversation. PR-1: same-workspace
   *  only, so callers pass the current workspace id. PR-2 will replace
   *  this with `useConversationById(id).workspace_id`. */
  workspaceId: string | null;
}

export interface FocusSelectionInputs {
  primary: ConversationPointer | null;
  primaryWorkspaceId: string | null;
  secondary: SecondaryDescriptor | null;
  fullscreen: boolean;
}

/**
 * Compute the *single* "focused" conversation. Drives:
 *   - `useNotificationToasts(focused.id)` — suppress in-app toasts for
 *     it (user can already see them).
 *   - `markChannelRead.mutate(focused.id)` — clear notification badges.
 *   - `window.agentHub.setActiveConversation({workspaceId, conversationId})`
 *     — IPC contract is single-id; main process uses it for tray /
 *     dock badging and the events window.
 *
 * Rule (preserves the legacy `openThreadId ?? selectedChannelId` semantic):
 *   - Resolved secondary (split or fullscreen) wins.
 *   - Unresolved secondary doesn't take focus — primary keeps it.
 *   - No secondary → primary.
 *   - Nothing visible → null.
 */
export function selectFocusedConversation(
  inputs: FocusSelectionInputs,
): FocusedConversation | null {
  const { primary, primaryWorkspaceId, secondary, fullscreen } = inputs;
  if (secondary && secondary.status === 'resolved') {
    return {
      id: secondary.id,
      kind: secondary.kind,
      workspaceId: secondary.workspaceId,
    };
  }
  // Fullscreen with no resolved secondary collapses to primary; same as
  // no-secondary case. (Fullscreen is meaningless without something to
  // fullscreen onto, so we treat it as a no-op rather than hiding
  // primary too.)
  void fullscreen;
  if (primary) {
    return {
      id: primary.id,
      kind: primary.kind,
      workspaceId: primaryWorkspaceId,
    };
  }
  return null;
}
