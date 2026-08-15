/**
 * Unit tests for the pure channel-membership derivation + gate.
 *
 * These lock the THREE-state contract (member / nonmember / unknown) and its
 * fail-closed posture: only an authoritative `is_member === true` unlocks member
 * behavior; a missing field is `unknown` and gates exactly like a nonmember for
 * every member effect/mutation. Membership is read from the carrier's own
 * boolean ONLY — no `kind` / list-position inference.
 */
import { describe, expect, it } from 'vitest';
import {
  channelGateFor,
  deriveChannelMembership,
  isMemberChannel,
  mountsMemberOnlyPanel,
  type MembershipState,
} from './membership';

describe('deriveChannelMembership', () => {
  it('authoritative is_member=true on the carrier → member', () => {
    expect(deriveChannelMembership({ is_member: true })).toBe('member');
  });

  it('authoritative is_member=false → nonmember', () => {
    expect(deriveChannelMembership({ is_member: false })).toBe('nonmember');
  });

  it('missing field → unknown (no kind/list inference, fail-closed)', () => {
    expect(deriveChannelMembership({})).toBe('unknown');
  });

  it('does NOT infer member from dm_channel kind — a DM without the field is unknown', () => {
    // The `dm_channel ⇒ member` shortcut was removed: DM items must carry the
    // authoritative field like any other carrier. Absent → unknown.
    expect(deriveChannelMembership({})).toBe('unknown');
    expect(deriveChannelMembership({ is_member: true })).toBe('member');
  });

  it('falls back to resolved detail is_member only when the carrier lacks the field', () => {
    // Carrier field wins over the resolved fallback.
    expect(deriveChannelMembership({ is_member: false }, true)).toBe(
      'nonmember',
    );
    // Carrier lacks it → use the detail-resolved value.
    expect(deriveChannelMembership({}, true)).toBe('member');
    expect(deriveChannelMembership({}, false)).toBe('nonmember');
  });

  it('null/undefined carrier → unknown', () => {
    expect(deriveChannelMembership(null)).toBe('unknown');
    expect(deriveChannelMembership(undefined)).toBe('unknown');
  });
});

describe('channelGateFor', () => {
  it('member unlocks everything, no Join', () => {
    expect(channelGateFor('member')).toEqual({
      allowMutations: true,
      allowMemberEffects: true,
      showComposer: true,
      showJoin: false,
    });
  });

  it('nonmember: no member behavior, shows Join', () => {
    expect(channelGateFor('nonmember')).toEqual({
      allowMutations: false,
      allowMemberEffects: false,
      showComposer: false,
      showJoin: true,
    });
  });

  it('unknown fails closed exactly like nonmember, but shows NEITHER composer nor Join', () => {
    expect(channelGateFor('unknown')).toEqual({
      allowMutations: false,
      allowMemberEffects: false,
      showComposer: false,
      showJoin: false,
    });
  });

  it('unknown and nonmember never allow member effects/mutations', () => {
    for (const state of ['unknown', 'nonmember'] as MembershipState[]) {
      const gate = channelGateFor(state);
      expect(gate.allowMemberEffects).toBe(false);
      expect(gate.allowMutations).toBe(false);
      expect(gate.showComposer).toBe(false);
    }
  });
});

describe('isMemberChannel (member-scoped inclusion)', () => {
  it('admits ONLY authoritative is_member=true', () => {
    expect(isMemberChannel({ is_member: true })).toBe(true);
  });

  it('excludes nonmember AND unknown (no fail-open on a missing field)', () => {
    expect(isMemberChannel({ is_member: false })).toBe(false);
    expect(isMemberChannel({})).toBe(false);
    expect(isMemberChannel({})).toBe(false);
  });

  it('filters a union list down to authoritative members only', () => {
    const union = [
      { id: 'a', is_member: true },
      { id: 'b', is_member: false }, // unjoined public
      { id: 'c' }, // unknown / older payload
      { id: 'd', is_member: true },
    ];
    expect(union.filter(isMemberChannel).map(c => c.id)).toEqual(['a', 'd']);
  });
});

describe('mountsMemberOnlyPanel (direct-route mount gate)', () => {
  it('mounts a member-only aggregate panel only for a resolved member with the flag set', () => {
    expect(mountsMemberOnlyPanel(true, 'member')).toBe(true);
  });

  it('a member with the flag CLEARED does not mount it', () => {
    expect(mountsMemberOnlyPanel(false, 'member')).toBe(false);
  });

  it('nonmember/unknown NEVER mount it even when the flag is set', () => {
    // The route flag alone is not a mount guard: a hand-written / restored
    // `?files=1`/`?threads=1`, or a membership revoked while the pane is open
    // (state flips to nonmember/unknown, flag still true), must not mount the
    // pane that fires member-only readers.
    for (const state of ['nonmember', 'unknown'] as MembershipState[]) {
      expect(mountsMemberOnlyPanel(true, state)).toBe(false);
    }
  });
});
