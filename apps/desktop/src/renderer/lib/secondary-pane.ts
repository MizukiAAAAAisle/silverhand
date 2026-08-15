/**
 * Pure selectors for the right-hand secondary pane.
 *
 * PR-1 introduced the URL → descriptor → visible/focused matrix.
 * PR-2 extends the `side` source to support cross-workspace
 * conversation ids by routing through `useConversationById(id)` (which
 * hits `GET /api/conversations/:id/ref`). Same-workspace ids fall
 * through the same code path; the ref hook is React Query–cached so
 * the round-trip is one-shot per id.
 *
 * These functions are deliberately pure so that:
 *   1. App.tsx stays thin — just plumbing route state + channels +
 *      ref hook output into these helpers.
 *   2. Unit tests can exercise the URL → state matrix without
 *      mounting React or React Query.
 *
 * Vocabulary:
 *
 *   - `secondaryDescriptor` — what the right pane shows. The only source
 *     is `?side=<id>` (overlay; cross-workspace capable via the ref
 *     hook). The descriptor's status reflects the ref-hook lifecycle
 *     (loading/resolved/unauthorized/not_found).
 *   - `visibleConversations` — set of conversations whose pane is
 *     currently on screen. Drives message read-cursor advancement.
 *     Fullscreen collapses to just the displayed pane; non-resolved
 *     side (loading/unauthorized/not_found) contributes no read
 *     cursor — placeholder pane has no real conversation to mark
 *     read.
 *   - `focusedConversation` — the *one* conversation the user is
 *     considered to be focused on. Drives toast suppression and the IPC
 *     `setActiveConversation` payload (which only accepts a single id).
 *     Focus is a PASSIVE surface — it does NOT clear notification badges
 *     / write `read_at` (surfaced ≠ eliminated, #task:1244). Rule:
 *     resolved secondary > primary; non-resolved secondary doesn't take
 *     focus.
 */

import type { ConversationByIdResult } from '@/features/conversations/useConversationById';

export type SecondaryDescriptor =
  | {
      source: 'side';
      status: 'resolved';
      id: string;
      placementKind: 'workspace' | 'direct_pair' | 'agent_inbox';
      rosterPolicy: 'open' | 'fixed';
      title: string;
      workspaceId: string;
      workspaceKind: 'regular' | 'dm';
      closedAt: number | null;
      archivedAt: number | null;
    }
  | { source: 'side'; status: 'loading'; id: string }
  | { source: 'side'; status: 'unauthorized'; id: string }
  | { source: 'side'; status: 'not_found'; id: string };

export interface SecondaryRouteInputs {
  /** From `useRouteState().sideConversationId`. */
  sideConversationId: string | null;
}

/**
 * Decide what the right-hand pane should show given URL state and the
 * ref-hook result for the `?side` id (when set).
 *
 * The only secondary source is `?side=<id>`. The selector never produces
 * a descriptor that requires "loading + null id" — loading/unauthorized/
 * not_found descriptors always carry the id so the placeholder can render
 * `#conv:<id>` and offer a Close button.
 *
 * Cross-workspace `?side` ids resolve through the ref hook
 * (`useConversationById`); the resolved branch carries workspace
 * metadata (`workspaceId`, `workspaceKind`) so
 * ChannelView can switch its workspace-scoped hooks via the
 * `workspaceContext` prop without a second round-trip.
 *
 * `sideRef === null` is treated as "ref hook hasn't been read yet"
 * (i.e. the React component hasn't run yet); we surface this as
 * `loading` so the URL state and the descriptor never disagree
 * across renders.
 */
export function selectSecondaryDescriptor(
  route: SecondaryRouteInputs,
  sideRef: ConversationByIdResult | null,
): SecondaryDescriptor | null {
  if (route.sideConversationId) {
    const id = route.sideConversationId;
    const status = sideRef?.status ?? 'loading';
    if (status === 'loading') {
      return { source: 'side', status: 'loading', id };
    }
    if (status === 'unauthorized') {
      return { source: 'side', status: 'unauthorized', id };
    }
    if (status === 'not_found') {
      return { source: 'side', status: 'not_found', id };
    }
    // resolved — pull all routing metadata out of the ref payload so
    // the descriptor is the single source of truth for downstream
    // wiring (no second hop into channels list / workspace store).
    const ref = sideRef!.ref!;
    return {
      source: 'side',
      status: 'resolved',
      id: ref.id,
      placementKind: ref.placement_kind,
      rosterPolicy: ref.roster_policy,
      title: ref.title,
      workspaceId: ref.workspace_id,
      workspaceKind: ref.workspace_kind,
      closedAt: ref.closed_at,
      archivedAt: ref.archived_at,
    };
  }
  return null;
}

/** ChannelView-shaped descriptor for a conversation. Mirrors the
 *  internal shape App.tsx historically built from `ChannelListItem`;
 *  exposed here so the secondary-pane mapping can produce one without
 *  a same-workspace lookup. */
export interface SecondaryConversationDescriptor {
  id: string;
  title: string;
  placement_kind: 'workspace' | 'direct_pair' | 'agent_inbox';
  roster_policy: 'open' | 'fixed';
  closed_at: number | null;
  archived_at: number | null;
  workspace_id: string;
}

export interface SecondaryViewInputs {
  /** ChannelView `conversation` prop value. Null when the secondary
   *  pane should not render a real ChannelView (no secondary, or a
   *  non-resolved `?side`). */
  conversationDescriptor: SecondaryConversationDescriptor | null;
  /** ChannelView `channelKind` prop value. For cross-workspace `?side`
   *  this comes from the ref's `workspace_kind`; otherwise falls
   *  through to the primary's kind. */
  channelKind: 'regular' | 'dm' | null;
  /** Workspace id to bake into the secondary archive mutation
   *  invalidation. Cross-workspace secondary needs the foreign
   *  workspace id so the `['workspaces', wid, 'channels']` cache
   *  invalidation hits the right entry. Falls back to the primary
   *  workspace id for non-resolved cases. */
  archiveWorkspaceId: string | null;
}

export interface SecondaryViewMappingInputs {
  secondary: SecondaryDescriptor | null;
  /** Primary workspace's kind, used as fallback channel kind for
   *  non-resolved `?side` (same-workspace `?side` carries its own
   *  `workspaceKind` so this is rarely consulted in practice). */
  primaryChannelKind: 'regular' | 'dm' | null;
  /** Primary workspace id, used as archive-invalidation target when
   *  there is no resolved secondary. */
  primaryWorkspaceId: string | null;
}

/**
 * Pure mapping from a SecondaryDescriptor to the props ChannelView
 * consumes for the secondary pane. Extracted so the cross-workspace
 * wiring is unit-testable end-to-end without a renderHook setup.
 *
 * Cindy review of PR-2: "测试里加一个跨 workspace side 的集成点：
 * `?side=<other workspace channel>` resolved 后，ChannelView 收到
 * other workspace id/kind/path，focused IPC 也用 other workspace
 * id。这个比只测 hook 更能防回归。" — that's this helper.
 */
export function selectSecondaryViewInputs(
  inputs: SecondaryViewMappingInputs,
): SecondaryViewInputs {
  const { secondary, primaryChannelKind, primaryWorkspaceId } = inputs;

  if (!secondary) {
    return {
      conversationDescriptor: null,
      channelKind: primaryChannelKind,
      archiveWorkspaceId: primaryWorkspaceId,
    };
  }

  // `?side` resolved: build the descriptor entirely from the ref
  // payload so cross-workspace secondaries don't need a lookup hit.
  if (secondary.source === 'side' && secondary.status === 'resolved') {
    return {
      conversationDescriptor: {
        id: secondary.id,
        title: secondary.title,
        placement_kind: secondary.placementKind,
        roster_policy: secondary.rosterPolicy,
        closed_at: secondary.closedAt,
        archived_at: secondary.archivedAt,
        workspace_id: secondary.workspaceId,
      },
      channelKind: secondary.workspaceKind,
      archiveWorkspaceId: secondary.workspaceId,
    };
  }

  // Non-resolved `?side` — placeholder pane is rendered separately;
  // no ChannelView descriptor.
  return {
    conversationDescriptor: null,
    channelKind: primaryChannelKind,
    archiveWorkspaceId: primaryWorkspaceId,
  };
}

/** Conversation pointer used by the read-cursor / focus selectors. */
export interface ConversationPointer {
  id: string;
  rosterPolicy: 'open' | 'fixed';
}

export interface VisibleConversations {
  /** The base channel pane. Hidden only when a secondary takes over the
   *  full viewport (fullscreen=1 + resolved secondary). */
  primary: ConversationPointer | null;
  /** The secondary pane. Null when there is no secondary or when the
   *  secondary is non-resolved (loading / unauthorized / not_found —
   *  placeholder pane has no real conversation to mark read). */
  secondary: ConversationPointer | null;
}

export interface VisibleSelectionInputs {
  primary: ConversationPointer | null;
  secondary: SecondaryDescriptor | null;
  fullscreen: boolean;
}

/**
 * Compute which conversations are currently *visible* to the user.
 * Drives `markMessageChannelRead` — a conversation must be on screen
 * for its read cursor to advance.
 *
 * Rules:
 *   - No secondary             → only primary visible.
 *   - Resolved secondary       → both visible (split) unless fullscreen,
 *                                in which case only the secondary.
 *   - Non-resolved secondary   → only primary visible (placeholder pane
 *     (loading/unauthorized/      has no conversation to mark read).
 *      not_found)
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
    // Placeholder occupies the slot visually but has no conversation
    // id to mark read. Primary is still visible behind it.
    return { primary, secondary: null };
  }
  const secondaryPointer: ConversationPointer = {
    id: secondary.id,
    rosterPolicy: secondary.rosterPolicy,
  };
  if (fullscreen) {
    return { primary: null, secondary: secondaryPointer };
  }
  return { primary, secondary: secondaryPointer };
}

export interface FocusedConversation {
  id: string;
  rosterPolicy: 'open' | 'fixed';
  /** Workspace id for the focused conversation. PR-2: pulled from
   *  the resolved secondary's `workspaceId` (cross-workspace capable)
   *  or from the caller's `primaryWorkspaceId` for the primary case. */
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
 *
 * Focus drives the above ONLY; it does NOT clear notification badges /
 * write `read_at` — focus is a passive surface (surfaced ≠ eliminated,
 * #task:1244). Directed claims clear only via active eliminate intent.
 *
 * Rule (preserves the legacy `openThreadId ?? selectedChannelId` semantic):
 *   - Resolved secondary (split or fullscreen) wins.
 *   - Non-resolved secondary doesn't take focus — primary keeps it.
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
      rosterPolicy: secondary.rosterPolicy,
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
      rosterPolicy: primary.rosterPolicy,
      workspaceId: primaryWorkspaceId,
    };
  }
  return null;
}

/**
 * Should the right pane fully cover the viewport (hiding primary)?
 *
 * Only `?fullscreen=1` *with a resolved secondary* collapses to a
 * single-pane render. Non-resolved side + fullscreen falls back to the
 * split view (primary + placeholder) so what's on screen matches the
 * `visibleConversations` / `focusedConversation` selectors above —
 * those keep primary in the visible/focused set whenever secondary is
 * non-resolved (a placeholder has no conversation to mark read or
 * silence toasts for). Without this gate, fullscreen + non-resolved
 * would hide primary in the DOM while still advancing primary's read
 * cursor — Cindy review of commit `e9278a7` flagged this as a
 * state/render fork. (Focus no longer touches notification badges at
 * all — #task:1244 — so only the read-cursor fork remains.)
 *
 * Pure helper so the render-time decision can be unit-tested without
 * mounting React.
 */
export function shouldSecondaryFullscreen(
  secondary: SecondaryDescriptor | null,
  fullscreen: boolean,
): boolean {
  return fullscreen && secondary?.status === 'resolved';
}
