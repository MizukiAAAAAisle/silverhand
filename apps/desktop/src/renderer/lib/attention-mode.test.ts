import { describe, expect, it } from 'vitest';
import {
  channelRowBadge,
  resolveEffectiveAttentionMode,
  resolveWorkspaceMuteToggle,
} from '@/lib/attention-mode';

// These are BEHAVIOR decisions (which volume, which number, or nothing), not
// paint — the badge's own visuals stay untested per the UI rule. The pinned
// property is Σ(loud row badges) = the workspace `badge_count`: since #task:1939
// the container paints no number, and that equality is what keeps the collapsed
// branch's wake gate and the rows it pokes out the same fact.

describe('resolveEffectiveAttentionMode', () => {
  it('lets the channel tier stand when the workspace is not muted', () => {
    expect(resolveEffectiveAttentionMode('all', false)).toBe('all');
    expect(resolveEffectiveAttentionMode('mentions', false)).toBe('mentions');
    expect(resolveEffectiveAttentionMode('mute', false)).toBe('mute');
  });

  it('collapses every channel tier to mute when the workspace is muted', () => {
    expect(resolveEffectiveAttentionMode('all', true)).toBe('mute');
    expect(resolveEffectiveAttentionMode('mentions', true)).toBe('mute');
    expect(resolveEffectiveAttentionMode('mute', true)).toBe('mute');
  });

  it('never rewrites the stored tier — un-muting restores it verbatim', () => {
    // The suppressor sits ABOVE the tier; resolving through it and back is the
    // identity. This is the A1 ruling's whole point (no backfill, no inherit).
    for (const mode of ['all', 'mentions', 'mute'] as const) {
      expect(resolveEffectiveAttentionMode(mode, true)).toBe('mute');
      expect(resolveEffectiveAttentionMode(mode, false)).toBe(mode);
    }
  });
});

describe('channelRowBadge', () => {
  it('all: positional unread is loud', () => {
    expect(
      channelRowBadge({ effectiveMode: 'all', positionalUnread: 5, directedUnread: 2 }),
    ).toEqual({ count: 5, tier: 'loud' });
  });

  it('all: counts positional ONCE — a contained @me is not added on top', () => {
    // §8's positional count already includes the directed claim, so summing them
    // would double-count exactly the message the badge is about.
    expect(
      channelRowBadge({ effectiveMode: 'all', positionalUnread: 1, directedUnread: 1 }),
    ).toEqual({ count: 1, tier: 'loud' });
  });

  it('mentions: ambient residue shows quiet', () => {
    expect(
      channelRowBadge({ effectiveMode: 'mentions', positionalUnread: 7, directedUnread: 0 }),
    ).toEqual({ count: 7, tier: 'quiet' });
  });

  it('mentions: a directed claim wins and goes loud, dropping the residue', () => {
    expect(
      channelRowBadge({ effectiveMode: 'mentions', positionalUnread: 7, directedUnread: 2 }),
    ).toEqual({ count: 2, tier: 'loud' });
  });

  it('mute: ambient residue is silent', () => {
    expect(
      channelRowBadge({ effectiveMode: 'mute', positionalUnread: 12, directedUnread: 0 }),
    ).toBeNull();
  });

  it('mute: a directed claim is STILL loud — mute never silences the person addressing you', () => {
    expect(
      channelRowBadge({ effectiveMode: 'mute', positionalUnread: 12, directedUnread: 3 }),
    ).toEqual({ count: 3, tier: 'loud' });
  });

  it('renders nothing when there is nothing unread, at every tier', () => {
    for (const effectiveMode of ['all', 'mentions', 'mute'] as const) {
      expect(
        channelRowBadge({ effectiveMode, positionalUnread: 0, directedUnread: 0 }),
      ).toBeNull();
    }
  });

  it('renders nothing for an unknown tier, even with unread', () => {
    // No default may be resolved for a row the batch has no entry for — not on
    // first paint, and not later either. The batch COALESCEs the default itself
    // and returns a row per live member channel, so a missing row never means
    // "this channel has no stored choice"; absence may be transient or
    // permanent, and neither licenses a tier (a non-member browsable channel is
    // the upstream `isMember` gate's business). A late-join seeded to `mentions`
    // would be painted loud by any such default.
    expect(
      channelRowBadge({
        effectiveMode: undefined,
        positionalUnread: 9,
        directedUnread: 3,
      }),
    ).toBeNull();
  });

  it('Σ(loud row badges) equals the workspace badge_count', () => {
    // The answerability invariant, over a workspace holding one row per tier.
    // badge_count = Σ(all-tier positional) + Σ(quiet/mute-tier directed)
    // — the same partition the backend `AttentionBadgeRepo` sums.
    const rows = [
      { effectiveMode: 'all' as const, positionalUnread: 4, directedUnread: 1 },
      { effectiveMode: 'mentions' as const, positionalUnread: 9, directedUnread: 2 },
      { effectiveMode: 'mentions' as const, positionalUnread: 3, directedUnread: 0 },
      { effectiveMode: 'mute' as const, positionalUnread: 6, directedUnread: 5 },
      { effectiveMode: 'mute' as const, positionalUnread: 8, directedUnread: 0 },
    ];
    const badgeCount = 4 + 2 + 0 + 5 + 0;
    const loudSum = rows
      .map(channelRowBadge)
      .filter(b => b?.tier === 'loud')
      .reduce((n, b) => n + (b?.count ?? 0), 0);
    expect(loudSum).toBe(badgeCount);
  });
});

describe('resolveWorkspaceMuteToggle', () => {
  it('offers the reverse of a known current value', () => {
    expect(resolveWorkspaceMuteToggle(false)).toEqual({
      label: 'Mute',
      next: true,
    });
    expect(resolveWorkspaceMuteToggle(true)).toEqual({
      label: 'Unmute',
      next: false,
    });
  });

  it('offers NO action while the current value is unknown', () => {
    // A muted workspace whose GET has not landed must not hand the user a
    // "Mute" click that writes `true` again — the write they read as Unmute
    // would be a no-op they cannot distinguish from a broken toggle.
    expect(resolveWorkspaceMuteToggle(undefined).next).toBeNull();
  });
});
