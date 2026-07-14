/**
 * Per-viewer channel membership: the single source deciding what a viewer may
 * do in a channel. A public channel is readable by a workspace user who is NOT
 * a member of it (browse-and-Join), so membership is a THREE-state axis, never
 * a boolean:
 *
 *   - `member`    — the viewer belongs; full member behavior.
 *   - `nonmember` — a public channel the viewer can browse but hasn't joined;
 *                   read-only allowlist + a Join affordance.
 *   - `unknown`   — the authoritative signal hasn't resolved yet (a deep-link /
 *                   detail path whose carrier lacks `is_member`).
 *
 * The gate is FAIL-CLOSED: `unknown` is treated like `nonmember` for every
 * member effect / mutation / write affordance. Defaulting to member would leak
 * an auto mark-read/observe or expose a write control in the window before the
 * authoritative state lands. Only a resolved `member` unlocks member behavior.
 *
 * Authority rule (locked): membership is read ONLY from
 * the `is_member` boolean the carrier itself provides (a discovery-union list
 * item, or a channel-detail response). It is NEVER inferred from anything
 * outside the field — not the channel's `kind`, not its presence in a list —
 * because any such second predicate re-introduces a fail-open path the moment a
 * payload lacks the field. The discovery union also mixes joined and unjoined
 * public channels in one list, so list position proves nothing. A carrier that
 * lacks the field is `unknown` → fetch detail. (DM items therefore rely on the
 * backend stamping `is_member: true`; there is no `dm_channel ⇒ member`
 * shortcut here.)
 */

export type MembershipState = 'member' | 'nonmember' | 'unknown';

/** The minimal carrier shape the derivation reads. Both the discovery-union
 *  list item and the channel-detail `channel` satisfy it. */
export interface MembershipCarrier {
  kind: 'channel' | 'dm_channel';
  /** Route-computed, per-viewer. Absent on an older/unaware payload or a
   *  carrier that never carries it (then membership is `unknown`). */
  is_member?: boolean;
}

/**
 * Resolve the three-state membership for a channel from the authoritative
 * `is_member` boolean alone.
 *
 * `resolvedIsMember` is the fallback authoritative signal from a detail fetch,
 * consulted only when the carrier itself lacks `is_member` (the deep-link /
 * unknown path). The carrier's own field always wins. No `kind` / list-position
 * inference — a missing field is `unknown`, full stop.
 */
export function deriveChannelMembership(
  carrier: MembershipCarrier | null | undefined,
  resolvedIsMember?: boolean,
): MembershipState {
  if (!carrier) return 'unknown';
  const authoritative =
    typeof carrier.is_member === 'boolean' ? carrier.is_member : resolvedIsMember;
  if (typeof authoritative !== 'boolean') return 'unknown';
  return authoritative ? 'member' : 'nonmember';
}

/** The affordance/effect gate for a membership state. `unknown` and `nonmember`
 *  both fail closed for member behavior; only `nonmember` shows Join (an
 *  `unknown` viewer shows neither composer nor Join — a neutral resolving
 *  state — because we don't yet know whether they can post). */
export interface ChannelGate {
  /** Member write/mutation affordances: reactions, save/unsave, thread
   *  follow/reply, member management, attachment upload, the Attachments panel
   *  entry. */
  allowMutations: boolean;
  /** Auto-firing member effects on mount/visibility: mark-read, observe,
   *  follow, read-state writes. */
  allowMemberEffects: boolean;
  /** Show the real message composer (member only). */
  showComposer: boolean;
  /** Show the "Join the channel" affordance (resolved nonmember only). */
  showJoin: boolean;
}

export function channelGateFor(state: MembershipState): ChannelGate {
  const member = state === 'member';
  return {
    allowMutations: member,
    allowMemberEffects: member,
    showComposer: member,
    showJoin: state === 'nonmember',
  };
}

/**
 * The member-scoped inclusion predicate: `true` ONLY for an authoritative
 * member. Member-scoped consumers (auto-select / remembered / default /
 * fallback / persistence, member-scoped aggregates like the Tasks filter,
 * sidebar unread/badge) must `.filter(isMemberChannel)`.
 *
 * This deliberately admits ONLY `is_member === true` — `unknown` (absent field)
 * and `nonmember` are both excluded. `unknown` is NOT a member; letting an
 * absent-field payload through would be a fail-open path that contradicts the
 * three-state contract. Discovery-rendering surfaces (the sidebar list, `#`
 * ref resolution) carry the full union and resolve `unknown` via detail; only
 * member PROJECTIONS demand the authoritative `true`.
 */
export function isMemberChannel(carrier: MembershipCarrier): boolean {
  return carrier.is_member === true;
}

/**
 * Whether a member-only aggregate side panel (channel Attachments `?files=1`,
 * Threads-list `?threads=1`) may MOUNT for a viewer with this membership. The
 * route flag alone is not a mount guard: a non-member can hand-write / restore
 * the query flag, or a member's status can be revoked while the pane is open.
 * The pane fires member-only readers, so it mounts ONLY for a resolved
 * `member` — `nonmember` and `unknown` both fail closed even when the flag is
 * set. (The single `?thread=` pane and inline attachment preview are NOT gated
 * this way — reading an existing thread is allowed for a non-member.) Pure so
 * the secondary-view owner's gate is unit-testable without rendering App.
 */
export function mountsMemberOnlyPanel(
  flagOpen: boolean,
  state: MembershipState,
): boolean {
  return flagOpen && state === 'member';
}
