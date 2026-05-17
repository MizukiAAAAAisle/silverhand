import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentDto, UserDto } from '@silverhand/shared';
import { AgentProfileCard } from './AgentProfileCard';
import { setCurrentUserId } from '@/lib/current-user';

setCurrentUserId('u-creator', 'creator');

function makeAgent(overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id: 'a-1',
    host_id: 'h-1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude',
    description: 'Helpful assistant',
    model: null,
    reasoning_effort: null,
    fast_mode: null,
    avatar_url: null,
    created_by_user_id: 'u-creator',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as AgentDto;
}

function makeViewer(id: string): UserDto {
  return {
    id,
    name: id,
    display_name: id,
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
  } as UserDto;
}

function render(agent: AgentDto, viewerId: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Prime the viewer query so `useViewerUser` resolves synchronously
  // during SSR — without this, `viewer` is undefined and the helper
  // falls into the conservative read-only branch unconditionally
  // (which would make the "creator can edit" assertion pass for the
  // wrong reason).
  qc.setQueryData(['me'], makeViewer(viewerId));
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        StaticRouter,
        { location: '/members/a-1' },
        React.createElement(AgentProfileCard, {
          agent,
          runtimeState: undefined,
        }),
      ),
    ),
  );
}

describe('AgentProfileCard creator/read-only render branches', () => {
  it('non-creator viewer sees the read-only notice and no editable inputs', () => {
    const html = render(
      makeAgent({ created_by_user_id: 'u-creator' }),
      'u-other',
    );
    // The read-only notice mounts only on the non-creator branch.
    expect(html).toContain(
      "Only the creator can edit this agent&#x27;s profile.",
    );
    // Description text appears as static text, not inside a textarea.
    expect(html).toContain('Helpful assistant');
    expect(html).not.toContain('<textarea');
    // No editable file input — non-creator never sees the avatar picker.
    expect(html).not.toContain('type="file"');
  });

  it('creator viewer sees editable inputs and the avatar picker, no read-only notice', () => {
    const html = render(
      makeAgent({ created_by_user_id: 'u-creator' }),
      'u-creator',
    );
    expect(html).not.toContain(
      "Only the creator can edit this agent&#x27;s profile.",
    );
    // Description goes through GhostTextarea on the creator branch.
    expect(html).toContain('<textarea');
    // Editable avatar picker is mounted — the whole avatar circle is the
    // click target now (a hidden file input + a hover label band). Both
    // markers must show; the human/agent click-the-avatar UX consolidation
    // (#task:314) replaced the old "Choose…/Change…" button. The visible
    // strip label is a single verb ("Edit" / "Add") to fit within the
    // circular clip; the verbose text lives on the wrapper's `aria-label`.
    expect(html).toContain('type="file"');
    expect(html).toMatch(/>Edit<|>Add</);
    expect(html).toMatch(/aria-label="(Change avatar|Add avatar) for @Alice"/);
  });

  it('non-creator branch does not surface "agent self can edit profile" affordances', () => {
    // Cindy PR-3 review #2: the read-only form must not leak any
    // "you would be able to edit if you were the agent" hints. PR-2
    // only shipped agent-self avatar self-edit on the internal route;
    // profile fields are NOT covered. This assertion locks that
    // guardrail at the render layer.
    const html = render(
      makeAgent({ created_by_user_id: 'u-creator' }),
      'u-other',
    );
    expect(html).not.toMatch(/agent\s+self/i);
    expect(html).not.toMatch(/sign in as|log in as/i);
  });
});
