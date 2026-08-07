// Attention TIER composition + presentation rules (#task:1870), renderer side.
//
// Two stored aggregates compose into one answer — the channel's own tier and the
// workspace mute SUPPRESSOR — and the backend expresses that same composition in
// SQL (`repos/attention-tier-predicates.ts`: `effectiveChannelModeExpr`). The two
// are twins that must agree by construction, so the rule is named on both sides
// rather than inlined: an inlined `muted ? 'mute' : mode` is invisible to a grep
// for the SQL fragment's partner, and the first divergence would show up as the
// sidebar and the badge disagreeing about the same channel.
//
// Everything here is pure. It is deliberately NOT a second authority on the
// resolved tier: `GET /api/attention/modes` already carries `effective_mode`, and
// the renderer renders that. `resolveEffectiveAttentionMode` exists for the
// OPTIMISTIC path only — flipping the workspace suppressor re-resolves every
// channel row in the workspace, and waiting a round-trip to re-silence N rows
// after a direct manipulation reads as lag.
import type { ChannelAttentionMode } from '@silverhand/shared';
import type { UnreadBadgeTier } from '@/components/layout/sidebar-shared';

/**
 * The EFFECTIVE tier for one channel: the workspace mute suppressor collapses any
 * channel tier to `'mute'`, otherwise the channel's own stored tier stands.
 *
 * "Muted wins, else the stored tier" — it never invents a fourth value and never
 * REWRITES the channel's own choice, which is why un-muting the workspace
 * restores each channel's tier exactly as it was (no backfill, no inherit axis;
 * the A1 ruling). SQL twin: `effectiveChannelModeExpr`.
 */
export function resolveEffectiveAttentionMode(
  channelMode: ChannelAttentionMode,
  workspaceMuted: boolean,
): ChannelAttentionMode {
  return workspaceMuted ? 'mute' : channelMode;
}

/**
 * The workspace mute item's label and the value a click writes.
 *
 * Mute is a RELATIVE toggle, unlike the channel tiers: those are three absolute
 * assignments, so an unknown current value still lets every option write the
 * right thing, whereas a toggle cannot compute its own reverse without knowing
 * where it starts. Defaulting the unknown to `false` is therefore not a harmless
 * placeholder — it offers "Mute" on an already-muted workspace, and the
 * click the user reads as Unmute writes `true` a second time (#task:1870, Cindy
 * review). `next: null` is the honest third state: the caller disables the item,
 * so no write can be built from a fabricated current.
 *
 * The labels carry no "workspace" suffix (shiki 2026-08-07): the item sits in the
 * workspace's own context menu beside Star/Unstar, so the object is already named
 * by where the menu was opened — repeating it only lengthens the row.
 */
export function resolveWorkspaceMuteToggle(muted: boolean | undefined): {
  label: string;
  /** The value a click writes; `null` = current unknown, offer no action. */
  next: boolean | null;
} {
  if (muted === undefined) return { label: 'Mute', next: null };
  return muted
    ? { label: 'Unmute', next: false }
    : { label: 'Mute', next: true };
}

/** What a sidebar row should show in its status slot: a count at one of the
 *  badge's volumes, or nothing at all. */
export interface RowBadge {
  count: number;
  tier: UnreadBadgeTier;
}

/**
 * The channel row's unread badge — ONE badge per row, resolved from the row's
 * effective tier plus its two counts.
 *
 * The load-bearing invariant: **a `loud` row badge is exactly what that row
 * contributes to its workspace's badge**, so Σ(loud row badges) = the rail's
 * `badge_count` by construction. That is what makes a lit workspace badge
 * ANSWERABLE — the user can always find the row that lit it. A quiet badge
 * contributes nothing; it is the residue the viewer asked to keep quiet.
 *
 * Per tier:
 *   - `all`      → positional unread, LOUD. (§8's positional count already
 *                  includes any @me, so this is one number, not a sum.)
 *   - `mentions` → a directed claim WINS and is loud: someone naming you is the
 *                  beacon, and it is also the only thing this row contributes to
 *                  the badge, so row and badge agree. With no directed claim the
 *                  ambient residue shows QUIET — the in-place hint.
 *   - `mute`     → a directed claim is STILL loud. Mute silences the ambient
 *                  channel, never the person addressing you; a silent row beside
 *                  a lit workspace badge is precisely the unexplainable state.
 *                  Ambient residue is suppressed entirely (silent = no badge).
 *
 * A `mentions` row with a directed claim deliberately DROPS its ambient residue
 * rather than showing two numbers: the viewer opted out of ambient, so the
 * mention count is strictly the more useful of the two, and one row keeps one
 * number.
 *
 * Callers pass `'all'` for a `dm_channel` row: a DM is directed-grade and has no
 * ambient tier to opt down (the backend 404s its preference, and the DB trigger
 * forbids a suppressor row on its agent_home workspace), so its positional
 * unread is always loud — which is also how the badge projection counts it.
 *
 * An UNDEFINED tier renders nothing. The row's own `effective_mode` from the tier
 * batch is the ONLY authority for a regular channel: the batch COALESCEs the
 * default in SQL and returns a row for every live member channel, so a missing row
 * never means "this channel has no stored choice". Absence may be transient or
 * permanent, and neither case licenses a tier, so no cause is distinguished here —
 * a non-member browsable channel is the upstream `isMember` gate's business.
 * Resolving a default instead would fabricate a tier, and for a late-join
 * seeded to `mentions` it would fabricate the LOUDEST one (#task:1870, Cindy
 * review). Nothing is the only honest answer: the volume is a claim about the
 * viewer's own decision, and painting the positional count loud would flash the
 * beacon on a channel they silenced.
 */
export function channelRowBadge(input: {
  effectiveMode: ChannelAttentionMode | undefined;
  positionalUnread: number;
  directedUnread: number;
}): RowBadge | null {
  const { effectiveMode, positionalUnread, directedUnread } = input;
  if (effectiveMode === undefined) return null;
  if (effectiveMode === 'all') {
    return positionalUnread > 0 ? { count: positionalUnread, tier: 'loud' } : null;
  }
  if (directedUnread > 0) return { count: directedUnread, tier: 'loud' };
  if (effectiveMode === 'mentions' && positionalUnread > 0) {
    return { count: positionalUnread, tier: 'quiet' };
  }
  return null;
}
