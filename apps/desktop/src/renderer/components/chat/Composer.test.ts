import { describe, expect, it } from 'vitest';
import type { AgentDto, ChannelConversationDto } from '@silverhand/shared';
import {
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
    pinned_at: null,
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
    expect(formatPickInsertion({ kind: 'agent', agent: agent() })).toBe('@alice');
  });

  it('human → @<name> (same mention namespace as agents)', () => {
    expect(formatPickInsertion({ kind: 'human', human: human() })).toBe('@shiki');
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
  it('includes human conversation members in @ picker results', () => {
    const items = filterMentionPeople(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      [human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
      'shi',
    );

    expect(items).toEqual([
      { kind: 'human', human: human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' }) },
    ]);
  });

  it('shows humans before global agents for empty @ browse so they are not capped away', () => {
    const items = filterMentionPeople(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      [human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
      '',
    );

    expect(items[0]?.kind).toBe('human');
  });
});
