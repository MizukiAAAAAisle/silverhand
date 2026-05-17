import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserDto } from '@silverhand/shared';
import { HumanProfileCard } from './HumanProfileCard';
import { setCurrentUserId } from '@/lib/current-user';

setCurrentUserId('u-self', 'Self');

function makeUser(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-self',
    name: 'self',
    display_name: 'Self',
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as UserDto;
}

function render(user: UserDto, viewerId: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Prime the viewer query so `useViewerUser` resolves synchronously
  // during SSR (see AgentProfileCard.test for the same pattern). Without
  // priming, `viewer` is undefined and the helper falls into the
  // conservative read-only branch unconditionally.
  const viewer: UserDto = {
    id: viewerId,
    name: viewerId,
    display_name: viewerId,
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
  } as UserDto;
  qc.setQueryData(['me'], viewer);
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(HumanProfileCard, { user }),
    ),
  );
}

describe('HumanProfileCard creator/read-only render branches', () => {
  it('non-self viewer sees the read-only notice and a static name', () => {
    const html = render(makeUser({ id: 'u-other', display_name: 'Other' }), 'u-self');
    expect(html).toContain('Only this user can edit their profile.');
    expect(html).toContain('Other');
    // No editable affordances on the non-self branch.
    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/aria-label="(Change|Add) avatar"/);
  });

  it('self viewer sees the avatar picker and an editable display-name input', () => {
    const html = render(makeUser({ id: 'u-self', display_name: 'Self' }), 'u-self');
    expect(html).not.toContain('Only this user can edit their profile.');
    // Editable display name uses the GhostInput pattern (single-line).
    expect(html).toMatch(/<input[^>]*value="Self"/);
    // Avatar picker is mounted with the click-the-avatar UX.
    expect(html).toContain('type="file"');
    expect(html).toMatch(/>Edit<|>Add</);
    expect(html).toMatch(/aria-label="(Change|Add) avatar"/);
  });

  it('non-self branch never surfaces edit-other-user affordances (v2 guard)', () => {
    // Mirrors the agent guardrail: the read-only form must not leak any
    // "you would be able to edit if you were this user" hint. v1's
    // backend keys edits off `requireViewerUserId`, so anything that
    // suggests editing another human would be a UI lie.
    const html = render(makeUser({ id: 'u-other' }), 'u-self');
    expect(html).not.toMatch(/sign in as|log in as|switch user/i);
  });
});
