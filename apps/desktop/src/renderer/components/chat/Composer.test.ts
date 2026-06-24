import { describe, expect, it } from 'vitest';
import type { AgentDto, ChannelConversationDto } from '@silverhand/shared';
import {
  filterChannels,
  filterMentionPeople,
  formatPickInsertion,
  type HumanMentionCandidate,
} from './Composer';

/**
 * Locks the two branches `formatPickInsertion` can produce so the
 * mention picker never inserts a string that `Markdown.tsx`'s
 * `@<handle>` / `#conv:<id>` parsers can't resolve.
 *
 * History:
 * - Original implementation always inserted `#<title>` — broke on
 *   the common case of CJK / spaces / slashes / leading digits.
 *   (Cindy #task:502 review finding.)
 * - First fix added a handle-safe branch that kept `#<title>` for
 *   ASCII-only titles and fell back to `#conv:<id>` otherwise.
 * - shiki + Cindy then converged on the simpler invariant: the
 *   picker ALWAYS inserts `#conv:<id>`, because (a) it sidesteps
 *   the title-charset constraint entirely, (b) it sidesteps
 *   same-title ambiguity inside a workspace (ChannelRef returns the
 *   ambiguous sentinel and renders inert muted text), and (c) the
 *   picker already has the id in hand, so there is no win to
 *   recomputing it from a title.
 *
 * `#<name>` remains a valid hand-written short alias for unique
 * handle-safe titles, but the picker stops producing it.
 */

function agent(overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id: 'a-1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude',
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as AgentDto;
}

function channel(overrides: Partial<ChannelConversationDto> = {}): ChannelConversationDto {
  return {
    id: 'qdQwBXDqcq_GE63-',
    workspace_id: 'w-1',
    workspace_path: '/tmp/w',
    kind: 'channel',
    parent_conversation_id: null,
    title: 'general',
    status: 'open',
    spawned_by_agent_id: null,
    closed_at: null,
    close_summary: null,
    archived_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as ChannelConversationDto;
}

function human(
  overrides: Partial<HumanMentionCandidate> = {},
): HumanMentionCandidate {
  return {
    id: 'u-1',
    name: 'shiki',
    display_name: 'Shiki',
    avatar_url: null,
    ...overrides,
  };
}

describe('formatPickInsertion', () => {
  it('agent → @<name> (handle is always url-safe by schema)', () => {
    expect(
      formatPickInsertion({ kind: 'agent', agent: agent(), inConversation: true }),
    ).toBe('@alice');
  });

  it('human → @<name> (same mention namespace as agents)', () => {
    expect(
      formatPickInsertion({ kind: 'human', human: human(), inConversation: true }),
    ).toBe('@shiki');
  });

  it('channel with handle-safe title → still #conv:<id> (no title shortcut)', () => {
    // Picker no longer takes the `#<title>` shortcut even when the
    // title would parse. Avoids the cross-title-ambiguity case
    // entirely — two `#general` channels in a workspace would render
    // inert; `#conv:<id>` always wins.
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'qdQwBXDqcq_GE63-', title: 'general' }),
      }),
    ).toBe('#conv:qdQwBXDqcq_GE63-');
  });

  it('channel with title containing spaces → #conv:<id>', () => {
    // The placeholder in CreateChannelDialog is literally
    // `修复 login bug`, so this is the common case, not a corner.
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'abc1234567890def', title: 'agent panel ui polish' }),
      }),
    ).toBe('#conv:abc1234567890def');
  });

  it('channel with CJK title → #conv:<id>', () => {
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'cjkc000000000aaa', title: '修复 login bug' }),
      }),
    ).toBe('#conv:cjkc000000000aaa');
  });

  it('channel with title starting with a digit → #conv:<id>', () => {
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'roadmap0000000aa', title: '2026-roadmap' }),
      }),
    ).toBe('#conv:roadmap0000000aa');
  });

  it('channel with slash in title → #conv:<id>', () => {
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'feat0000000clidg', title: 'feature/cli design' }),
      }),
    ).toBe('#conv:feat0000000clidg');
  });
});

describe('filterMentionPeople', () => {
  it('tags conversation-member humans with inConversation:true', () => {
    const { items } = filterMentionPeople(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      [human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
      new Set(),
      new Set(['u-1']),
      'shi',
    );

    expect(items).toEqual([
      {
        kind: 'human',
        human: human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' }),
        inConversation: true,
      },
    ]);
  });

  it('tags non-member humans with inConversation:false', () => {
    const { items } = filterMentionPeople(
      [],
      [human({ id: 'u-2', name: 'muou', display_name: 'Muou' })],
      new Set(),
      new Set(),
      'mu',
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: 'human',
      human: human({ id: 'u-2', name: 'muou', display_name: 'Muou' }),
      inConversation: false,
    });
  });

  it('puts the IN section before the NOT IN section (humans-first within each)', () => {
    // Mixed cast: one in-member agent, one in-member human, one out
    // agent, one out human. Locks the section ordering: IN section
    // (humans then agents), then NOT IN section (humans then agents).
    const inAgent = agent({ id: 'a-in', name: 'inalice', display_name: 'InAlice' });
    const outAgent = agent({ id: 'a-out', name: 'outagent', display_name: 'OutAgent' });
    const inHuman = human({ id: 'u-in', name: 'inhuman', display_name: 'InHuman' });
    const outHuman = human({ id: 'u-out', name: 'outhuman', display_name: 'OutHuman' });
    const { items } = filterMentionPeople(
      [inAgent, outAgent],
      [inHuman, outHuman],
      new Set(['a-in']),
      new Set(['u-in']),
      '',
    );

    expect(items.map(item => ({
      kind: item.kind,
      id: item.kind === 'agent' ? item.agent.id : item.kind === 'human' ? item.human.id : 'n/a',
      inConversation: item.kind === 'channel' ? null : item.inConversation,
    }))).toEqual([
      { kind: 'human', id: 'u-in', inConversation: true },
      { kind: 'agent', id: 'a-in', inConversation: true },
      { kind: 'human', id: 'u-out', inConversation: false },
      { kind: 'agent', id: 'a-out', inConversation: false },
    ]);
  });

  it('caps each section independently at 5 entries (10 max combined)', () => {
    // Build 8 in-members + 8 out-members; verify the picker returns
    // 5 from each section in order, never spilling extras from one
    // section into the other.
    const mkAgent = (n: number) => agent({ id: `a-${n}`, name: `a${n}`, display_name: `A${n}` });
    const inAgents = Array.from({ length: 8 }, (_, i) => mkAgent(i));
    const outAgents = Array.from({ length: 8 }, (_, i) => mkAgent(100 + i));
    const { items, hiddenCount } = filterMentionPeople(
      [...inAgents, ...outAgents],
      [],
      new Set(inAgents.map(a => a.id)),
      new Set(),
      '',
    );
    expect(items).toHaveLength(10);
    expect(items.slice(0, 5).every(item => item.kind === 'agent' && item.inConversation)).toBe(true);
    expect(items.slice(5).every(item => item.kind === 'agent' && !item.inConversation)).toBe(true);
    // 16 matched (8 IN + 8 OUT), 10 shown → 6 dropped, surfaced as the
    // "+N more" footer count (#task:1206).
    expect(hiddenCount).toBe(6);
  });

  it('reports hiddenCount = 0 when nothing is truncated', () => {
    const { items, hiddenCount } = filterMentionPeople(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      [human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
      new Set(['a-1']),
      new Set(['u-1']),
      '',
    );
    expect(items).toHaveLength(2);
    expect(hiddenCount).toBe(0);
  });

  it('counts truncation per section, not just overall (IN under cap, OUT over)', () => {
    // 2 IN (under the 5 cap → 0 dropped there) + 9 OUT (over → 4 dropped).
    // hiddenCount must reflect only the OUT overflow, proving the count is
    // computed per-section then summed, not from a single global slice.
    const mkAgent = (n: number) => agent({ id: `a-${n}`, name: `a${n}`, display_name: `A${n}` });
    const inAgents = [mkAgent(1), mkAgent(2)];
    const outAgents = Array.from({ length: 9 }, (_, i) => mkAgent(100 + i));
    const { items, hiddenCount } = filterMentionPeople(
      [...inAgents, ...outAgents],
      [],
      new Set(inAgents.map(a => a.id)),
      new Set(),
      '',
    );
    expect(items).toHaveLength(7); // 2 IN + 5 OUT (OUT capped at 5)
    expect(hiddenCount).toBe(4); // 9 OUT − 5 shown
  });

  it('honors the search query across both IN and NOT IN sections', () => {
    const { items } = filterMentionPeople(
      [
        agent({ id: 'a-in-bob', name: 'bob', display_name: 'Bob' }),
        agent({ id: 'a-out-bobby', name: 'bobby', display_name: 'Bobby' }),
        agent({ id: 'a-out-other', name: 'carol', display_name: 'Carol' }),
      ],
      [],
      new Set(['a-in-bob']),
      new Set(),
      'bob',
    );

    expect(items.map(item => (item.kind === 'agent' ? item.agent.id : null))).toEqual([
      'a-in-bob',
      'a-out-bobby',
    ]);
  });
});

describe('filterChannels', () => {
  it('caps at 8 channels and reports the truncated remainder', () => {
    const channels = Array.from({ length: 11 }, (_, i) =>
      channel({ id: `c-${i}`, title: `chan-${i}` }),
    );
    const { items, hiddenCount } = filterChannels(channels, '');
    expect(items).toHaveLength(8);
    // 11 live matched − 8 shown → 3 surfaced as the "+N more" footer count.
    expect(hiddenCount).toBe(3);
    expect(items.every(item => item.kind === 'channel')).toBe(true);
  });
  it('excludes archived/closed channels from both the list AND the count', () => {
    // The hidden count must reflect only *offerable* candidates: an
    // archived/closed channel is never a mentionable row, so it must not
    // inflate "+N more" into promising candidates the user can't reach.
    const channels = [
      channel({ id: 'live', title: 'general' }),
      channel({ id: 'arch', title: 'archived-thing', archived_at: 1 }),
      channel({ id: 'closed', title: 'closed-thing', closed_at: 1 }),
    ];
    const { items, hiddenCount } = filterChannels(channels, '');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'live',
    ]);
    expect(hiddenCount).toBe(0);
  });
});
