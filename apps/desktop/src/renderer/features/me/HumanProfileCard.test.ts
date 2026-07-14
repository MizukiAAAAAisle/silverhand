import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  it('non-self viewer gets no editable affordances', () => {
    const html = render(makeUser({ id: 'u-other', display_name: 'Other' }), 'u-self');
    // No editable affordances on the non-self branch (identified by a11y name /
    // input type, not by the read-only copy).
    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/aria-label="(Change|Add) avatar"/);
    expect(html).not.toMatch(/aria-label="Edit display name"/);
  });

  it('self viewer sees the avatar picker and the pencil edit trigger', () => {
    const html = render(makeUser({ id: 'u-self', display_name: 'Self' }), 'u-self');
    expect(html).toMatch(/aria-label="Edit display name"/);
    // Avatar picker mounts with the click-the-avatar UX.
    expect(html).toContain('type="file"');
    expect(html).toMatch(/aria-label="(Change|Add) avatar"/);
  });

  it('non-self branch never surfaces edit-other-user affordances (v2 guard)', () => {
    const html = render(makeUser({ id: 'u-other' }), 'u-self');
    expect(html).not.toMatch(/sign in as|log in as|switch user/i);
  });
});

describe('HumanProfileCard source — display name edit contract', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('./HumanProfileCard.tsx', import.meta.url)),
    'utf8',
  );

  it('routes display-name edits through the shared InlineText primitive', () => {
    // Display name and avatar have exactly one editing surface — this
    // card. A local input on this card that PATCHes on blur would
    // silently reintroduce a second ownership site alongside Settings.
    expect(SRC).toMatch(/from ['"]@\/features\/common\/InlineText['"]/);
    expect(SRC).toMatch(/from ['"]@\/features\/common\/EditPencilButton['"]/);
    expect(SRC).toMatch(/<InlineText\b/);
  });

  it('does not carry its own GhostInput / blur-commit path', () => {
    const codeOnly = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(codeOnly).not.toMatch(/GhostInput/);
    expect(codeOnly).not.toMatch(/onBlur\s*=/);
  });
});
