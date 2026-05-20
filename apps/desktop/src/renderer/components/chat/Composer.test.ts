import { describe, expect, it } from 'vitest';
import type { AgentDto, ChannelConversationDto } from '@silverhand/shared';
import { formatPickInsertion } from './Composer';

/**
 * Locks the three branches `formatPickInsertion` can produce so the
 * mention picker never inserts a string that `Markdown.tsx`'s
 * `#<name>` / `#conv:<id>` parsers can't resolve.
 *
 * Cindy #task:502 review finding: the original implementation always
 * inserted `#${title}`, which silently broke for the common case of
 * channel titles with spaces / CJK / slashes (see
 * `CreateChannelDialog.tsx` placeholder `修复 login bug`). The
 * regression here pins each branch by example so a future refactor
 * can't silently regress one of them.
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

describe('formatPickInsertion', () => {
  it('agent → @<name> (handle is always url-safe by schema)', () => {
    expect(formatPickInsertion({ kind: 'agent', agent: agent() })).toBe('@alice');
  });

  it('channel with handle-safe title → #<title> (cheap, human-readable)', () => {
    expect(
      formatPickInsertion({ kind: 'channel', channel: channel({ title: 'general' }) }),
    ).toBe('#general');
    expect(
      formatPickInsertion({ kind: 'channel', channel: channel({ title: 'agent-panel_ui-1' }) }),
    ).toBe('#agent-panel_ui-1');
  });

  it('channel with title containing spaces → #conv:<id> fallback', () => {
    // Common case — channel creator UI placeholder literally suggests
    // `修复 login bug`. Inserting `#agent panel ui polish` would have
    // the Markdown parser eat only `#agent` and drop the rest as plain
    // text, producing an unintended partial ref.
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'qdQwBXDqcq_GE63-', title: 'agent panel ui polish' }),
      }),
    ).toBe('#conv:qdQwBXDqcq_GE63-');
  });

  it('channel with CJK title → #conv:<id> fallback', () => {
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'abc1234567890def', title: '修复 login bug' }),
      }),
    ).toBe('#conv:abc1234567890def');
  });

  it('channel with title starting with a digit → #conv:<id> fallback', () => {
    // Markdown's regex anchors the leading char to `[a-zA-Z]`, so
    // `#2026-roadmap` would never parse as a channel ref. Fall back to
    // the id form so the receiver still resolves it.
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'roadmap0000000aa', title: '2026-roadmap' }),
      }),
    ).toBe('#conv:roadmap0000000aa');
  });

  it('channel with slash in title → #conv:<id> fallback', () => {
    expect(
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'feat0000000clidg', title: 'feature/cli design' }),
      }),
    ).toBe('#conv:feat0000000clidg');
  });
});
