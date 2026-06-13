import { describe, expect, it } from 'vitest';
import type { AgentDto, MessageDto, UserDto } from '@silverhand/shared';
import {
  buildMarkdownTranscript,
  formatSenderLabel,
  suggestImageFilename,
} from './markdownTranscript';

// Transcript format is the contract that distinguishes single-message
// `Copy markdown` (pure content) from multi-message `Copy markdown`
// (sender + time header per row, sorted by seq, two-blank-line gaps).
// shiki `vBRFDuOuOqhsYzow` flipped multi-select share from Save → Copy
// (clipboard); transcript shape is unchanged.

function agent(id: string, overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id,
    name: id,
    display_name: null,
    runtime: 'claude',
    home_dir: `/home/${id}`,
    role_summary: null,
    avatar_attachment_id: null,
    avatar_filename: null,
    avatar_size: null,
    avatar_content_type: null,
    avatar_blob_url_token: null,
    is_dm_agent: false,
    permissions: null,
    onboarded_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as AgentDto;
}

function user(id: string, overrides: Partial<UserDto> = {}): UserDto {
  return {
    id,
    name: id,
    display_name: null,
    avatar_attachment_id: null,
    avatar_filename: null,
    avatar_size: null,
    avatar_content_type: null,
    avatar_blob_url_token: null,
    profile_quote: null,
    onboarded_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as UserDto;
}

function msg(
  id: string,
  seq: number,
  partial: {
    content?: string;
    from_kind?: 'user' | 'agent' | 'system';
    from_agent_id?: string | null;
    from_user_id?: string | null;
    created_at?: number;
  } = {},
): MessageDto {
  return {
    id,
    conversation_id: 'c1',
    from_kind: partial.from_kind ?? 'user',
    from_agent_id: partial.from_agent_id ?? null,
    from_user_id: partial.from_user_id ?? null,
    content: partial.content ?? `body-${id}`,
    metadata: null,
    attachments: null,
    seq,
    created_at: partial.created_at ?? 1_700_000_000_000 + seq * 1000,
    thread_root_id: null,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
  };
}

describe('formatSenderLabel', () => {
  it('agent → "@<display_name>" when display set', () => {
    const m = msg('m1', 1, { from_kind: 'agent', from_agent_id: 'a1' });
    const ctx = {
      agentsById: new Map([['a1', agent('a1', { display_name: 'Alice' })]]),
    };
    expect(formatSenderLabel(m, ctx)).toBe('@Alice');
  });

  it('agent → "@<name>" when display_name is empty', () => {
    const m = msg('m1', 1, { from_kind: 'agent', from_agent_id: 'a1' });
    const ctx = {
      agentsById: new Map([['a1', agent('a1', { name: 'alice' })]]),
    };
    expect(formatSenderLabel(m, ctx)).toBe('@alice');
  });

  it('agent → "@<id>" when agent not in map', () => {
    const m = msg('m1', 1, { from_kind: 'agent', from_agent_id: 'unknown' });
    expect(formatSenderLabel(m, { agentsById: new Map() })).toBe('@unknown');
  });

  it('user (viewer) → display_name without leading @', () => {
    const v = user('u1', { display_name: 'Shiki' });
    const m = msg('m1', 1, { from_kind: 'user', from_user_id: 'u1' });
    expect(formatSenderLabel(m, { agentsById: new Map(), viewer: v })).toBe(
      'Shiki',
    );
  });

  it('user (viewer) → name fallback when display_name empty', () => {
    const v = user('u1', { name: 'shiki' });
    const m = msg('m1', 1, { from_kind: 'user', from_user_id: 'u1' });
    expect(formatSenderLabel(m, { agentsById: new Map(), viewer: v })).toBe(
      'shiki',
    );
  });

  it('user (non-viewer) → falls back to from_user_id', () => {
    const v = user('u1', { name: 'shiki' });
    const m = msg('m1', 1, { from_kind: 'user', from_user_id: 'u2' });
    expect(formatSenderLabel(m, { agentsById: new Map(), viewer: v })).toBe(
      'u2',
    );
  });
});

describe('buildMarkdownTranscript', () => {
  const fixedTime = (epoch: number) => `T${epoch}`;
  const ctx = (overrides: Partial<Parameters<typeof buildMarkdownTranscript>[1]> = {}) => ({
    agentsById: new Map([
      ['a1', agent('a1', { display_name: 'Alice' })],
      ['a2', agent('a2', { display_name: 'Cindy' })],
    ]),
    viewer: user('u1', { display_name: 'Shiki' }),
    formatTime: fixedTime,
    ...overrides,
  });

  it('produces header + blank line + content for a single message', () => {
    const m1 = msg('m1', 1, {
      from_kind: 'agent',
      from_agent_id: 'a1',
      content: 'hello',
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1], ctx());
    // Trailing newline is intentional — POSIX-friendly file ending.
    expect(out).toBe('## @Alice · T1000\n\nhello\n');
  });

  it('always includes the sender header even for a single-message transcript', () => {
    // This is the key boundary: single-message export still uses the
    // transcript shape (header included). Single-message Copy markdown
    // is the pure-content path, NOT this one.
    const m1 = msg('m1', 1, {
      from_kind: 'user',
      from_user_id: 'u1',
      content: 'shiki says hi',
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1], ctx());
    expect(out).toContain('## Shiki · T1000');
    expect(out).toContain('shiki says hi');
  });

  it('separates consecutive messages with two blank lines', () => {
    const m1 = msg('m1', 1, {
      from_kind: 'agent',
      from_agent_id: 'a1',
      content: 'first',
      created_at: 1000,
    });
    const m2 = msg('m2', 2, {
      from_kind: 'user',
      from_user_id: 'u1',
      content: 'second',
      created_at: 2000,
    });
    const out = buildMarkdownTranscript([m1, m2], ctx());
    expect(out).toBe(
      '## @Alice · T1000\n\nfirst\n\n\n## Shiki · T2000\n\nsecond\n',
    );
  });

  it('preserves the order in which messages are passed in', () => {
    // The function does NOT re-sort — production callers run it on
    // selectionSorted() which is already canonical. This test pins
    // that contract (no hidden re-sort).
    const m1 = msg('m1', 5, {
      from_kind: 'agent',
      from_agent_id: 'a2',
      content: 'fifth',
      created_at: 5000,
    });
    const m2 = msg('m2', 1, {
      from_kind: 'agent',
      from_agent_id: 'a1',
      content: 'first',
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1, m2], ctx());
    // Cindy first, then Alice — matches input order, not seq order.
    expect(out.indexOf('Cindy')).toBeLessThan(out.indexOf('Alice'));
  });

  it('falls back to ISO time when no formatter passed', () => {
    const m1 = msg('m1', 1, {
      from_kind: 'agent',
      from_agent_id: 'a1',
      created_at: Date.UTC(2026, 4, 25, 0, 0, 0),
    });
    const out = buildMarkdownTranscript([m1], {
      agentsById: ctx().agentsById,
      viewer: ctx().viewer,
    });
    expect(out).toContain('2026-05-25T00:00:00.000Z');
  });

  it('handles multi-paragraph content without mangling internal newlines', () => {
    const m1 = msg('m1', 1, {
      from_kind: 'agent',
      from_agent_id: 'a1',
      content: 'line one\n\nline two',
      created_at: 1000,
    });
    const out = buildMarkdownTranscript([m1], ctx());
    expect(out).toContain('line one\n\nline two');
  });
});

describe('suggestImageFilename', () => {
  const m = msg('m1', 42);

  it('combines sanitized title and first-message seq for png', () => {
    expect(suggestImageFilename([m], 'design discussion')).toBe(
      'design-discussion-42.png',
    );
  });

  it('strips path-unsafe characters', () => {
    expect(suggestImageFilename([m], 'a/b\\c:d*e?f"g<h>i|j')).toBe(
      'abcdefghij-42.png',
    );
  });

  it('falls back when title is null', () => {
    expect(suggestImageFilename([m], null)).toBe('transcript-42.png');
  });

  it('uses 0 seq when messages array is empty', () => {
    expect(suggestImageFilename([], 'foo')).toBe('foo-0.png');
  });

  it('truncates very long titles to keep the filename usable', () => {
    const long = 'x'.repeat(200);
    const out = suggestImageFilename([m], long);
    // 80-char prefix + "-42.png"
    expect(out.length).toBeLessThanOrEqual(80 + '-42.png'.length);
  });
});
