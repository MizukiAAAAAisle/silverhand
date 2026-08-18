/**
 * The chat pane's MODE, projected once from the conversation's placement
 * (#task:2039).
 *
 * shiki: «channel view 我觉得现在出现了不同的模式：分为 DM 和 channel 那种，相关的
 * 能力应该按照这个来收敛». Two long-term shapes fill the same pane —
 *
 *  - `workspace_channel` — a workspace container: roster, member management,
 *    channel identity (`#`), workspace-scoped refs and candidate searches;
 *  - `direct_message` — a `direct_pair`: two endpoints, no roster and no
 *    container, the counterpart IS the identity. Presence is NOT placement-keyed:
 *    both shapes read a member's Online/Offline from the agent's Availability
 *    (#task:2043) — a channel's only presence-specific power is the `Not here`
 *    membership answer a roster gives, which is {@link ConversationPaneCapabilities.hasRoster}.
 *
 * — and the four dogfood findings behind this ticket were four different
 * components each guessing which one they were in (`workspaceId === null`, the
 * route, a local `isDirectPair` boolean). The projection happens HERE, once, and
 * every affordance reads {@link paneCapabilities} instead of re-deriving it.
 *
 * IT DECIDES UI CAPABILITY ONLY (@Cindy, #task:2039). Whether a read or write is
 * allowed stays the backend's answer; this module says which affordances a
 * placement can even show, so it must never be promoted into a front-end
 * permission truth.
 *
 * TOTAL OVER THE PLACEMENT UNION. `agent_inbox` is a real stored placement with
 * no user-facing pane today, and a fifth could be added tomorrow: anything that
 * is not one of the two known shapes projects to `unsupported`, which withholds
 * every placement-specific affordance. The default arm is the point — a new
 * placement kind cannot silently inherit channel chrome by falling through.
 */
import type {
  ConversationPlacementKind,
  DirectPairCounterpart,
} from '@silverhand/shared';
import type { ConversationPaneDescriptor } from './pane-descriptor';

export type ConversationPaneMode =
  /** A conversation inside a workspace container. `workspaceId` stays nullable
   *  because the descriptor's is: the pane paints what it was handed rather than
   *  asserting a coordinate, and the workspace-scoped affordances are gated on
   *  {@link ConversationPaneCapabilities.workspaceScope} being non-null. */
  | { kind: 'workspace_channel'; workspaceId: string | null }
  /** A `direct_pair`. `counterpart` is absent on carriers that don't resolve one
   *  (a deep link that only knows the conversation id), which the header answers
   *  with the title alone rather than with channel chrome. */
  | { kind: 'direct_message'; counterpart: DirectPairCounterpart | null }
  /** A placement this pane has no mode for. Carries the placement so a future
   *  arm is named by whoever adds it, not silently absorbed. */
  | { kind: 'unsupported'; placement: ConversationPlacementKind };

/** Project the pane's conversation onto its mode. The ONE place placement is
 *  read for UI shape. */
export function projectConversationPaneMode(
  conversation: ConversationPaneDescriptor,
): ConversationPaneMode {
  switch (conversation.placement_kind) {
    case 'workspace':
      return { kind: 'workspace_channel', workspaceId: conversation.workspace_id };
    case 'direct_pair':
      return {
        kind: 'direct_message',
        counterpart: conversation.counterpart ?? null,
      };
    default:
      return { kind: 'unsupported', placement: conversation.placement_kind };
  }
}

/** The placement a mode stands for — the inverse of the projection, so the two
 *  directions can be checked against each other and a mode can look up any
 *  placement-keyed rule without a second copy of the mapping. */
export function placementOfPaneMode(
  mode: ConversationPaneMode,
): ConversationPlacementKind {
  switch (mode.kind) {
    case 'workspace_channel':
      return 'workspace';
    case 'direct_message':
      return 'direct_pair';
    case 'unsupported':
      return mode.placement;
  }
}

/**
 * What the pane may show, and what it may READ. Every field is a UI capability,
 * never a permission.
 *
 * Presence is deliberately NOT a field here. Both placements now read a member's
 * presence from the SAME authority — the agent's Availability
 * (`agent_availability_changed`, #task:2043), projected to Online/Away by
 * `projectGlobalPresence` from `(availability, away_at)` alone (#task:2049
 * dropped liveness as an input) — so "which authority answers presence" is no
 * longer a placement-specific capability. The one
 * remaining placement difference is MEMBERSHIP: a roster-bearing placement can say
 * `Not here` for a non-member, which is exactly {@link hasRoster}. A runtime state
 * (`starting` / `crashed`) is orthogonal and never decides presence.
 */
export interface ConversationPaneCapabilities {
  /** The identity primitive the header wears: the channel `#`, the counterpart's
   *  face, or the title alone when the placement has neither. */
  headerIdentity: 'channel_hash' | 'counterpart' | 'title_only';
  /** Whether this placement HAS a roster — the member strip, the members button
   *  and its dialog, the add-member picker, the per-conversation agent
   *  management controls, AND the `conversation_agents` / runtime reads that feed
   *  them. A pair's two endpoints are not a roster, so it has none of it (shiki,
   *  #task:2039).
   *
   *  It also gates the presence line's MEMBERSHIP question: a roster-bearing
   *  placement answers `Not here` for an agent not on it, a pair never does.
   *
   *  It gates the READS, not just the painting (@Cindy, #task:2039 review): a
   *  surface that starts the query and then renders nothing because the response
   *  happens to be empty has moved its capability into the data, where the next
   *  placement with a non-empty roster silently inherits it. See
   *  {@link rosterQueryTarget}. */
  hasRoster: boolean;
  /** The workspace that workspace-scoped affordances resolve in — `#channel`
   *  refs, `#task:<n>` refs, in-workspace jumps — or `null` when there is none. */
  workspaceScope: string | null;
}

export function paneCapabilities(
  mode: ConversationPaneMode,
): ConversationPaneCapabilities {
  switch (mode.kind) {
    case 'workspace_channel':
      return {
        headerIdentity: 'channel_hash',
        hasRoster: true,
        workspaceScope: mode.workspaceId,
      };
    case 'direct_message':
      return {
        headerIdentity: 'counterpart',
        hasRoster: false,
        workspaceScope: null,
      };
    case 'unsupported':
      return {
        headerIdentity: 'title_only',
        hasRoster: false,
        workspaceScope: null,
      };
  }
}

/**
 * What a surface with no pane around it may assume — the workspace-channel
 * capabilities, i.e. exactly what every one of them did before this ticket. It is
 * the context default, so adding the projection changed no existing behavior; a
 * placement-specific pane overrides it with its own projection.
 *
 * `workspaceScope` is null because a coordinate must be carried, never assumed.
 */
export const DEFAULT_PANE_CAPABILITIES: ConversationPaneCapabilities =
  paneCapabilities({ kind: 'workspace_channel', workspaceId: null });

/**
 * The conversation a roster read should target, or `null` for "do not read".
 *
 * Two independent facts disable a roster read and they compose here rather than
 * at each call site: the placement having no roster at all (capability), and the
 * viewer not being a member of one that exists (`gate.allowMemberEffects` — a
 * non-member browsing a public channel must not read its roster). Both hooks that
 * feed the roster surfaces take a nullable id and disable their query AND their
 * WS interest when handed `null`, so this is the off switch, not a filter applied
 * to a response that was already fetched.
 */
export function rosterQueryTarget(
  capabilities: ConversationPaneCapabilities,
  conversationId: string,
  allowMemberEffects: boolean,
): string | null {
  return capabilities.hasRoster && allowMemberEffects ? conversationId : null;
}
