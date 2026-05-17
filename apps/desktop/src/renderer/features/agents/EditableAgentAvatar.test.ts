import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { formatAvatarMutationError } from './EditableAgentAvatar';

/**
 * Cindy PR-3 review #2 — error mapping must cover both PR-2 service
 * codes AND cross-cutting HTTP states (403/404/etc.) so a stale
 * `created_by_user_id` cache or a deleted-underfoot agent never
 * surfaces as a generic toast. Each branch of `formatAvatarMutationError`
 * is asserted independently here.
 */

function apiErrorWith(status: number, body: string): ApiError {
  return new ApiError(status, '', body);
}

describe('formatAvatarMutationError', () => {
  it('renders avatar_too_large from a 413 + service-error body', () => {
    expect(
      formatAvatarMutationError(
        apiErrorWith(413, JSON.stringify({ error: '...', code: 'avatar_too_large' })),
      ),
    ).toBe('Avatar must be 5 MB or smaller.');
  });

  it('renders avatar_unsupported_type from a 415 + service-error body', () => {
    expect(
      formatAvatarMutationError(
        apiErrorWith(415, JSON.stringify({ error: '...', code: 'avatar_unsupported_type' })),
      ),
    ).toBe('Avatar must be a PNG, JPEG, GIF, or WEBP image.');
  });

  it('renders avatar_missing from a 400 + service-error body', () => {
    expect(
      formatAvatarMutationError(
        apiErrorWith(400, JSON.stringify({ error: '...', code: 'avatar_missing' })),
      ),
    ).toBe('Avatar file is empty.');
  });

  it('renders avatar_storage_failed from a 400 + service-error body', () => {
    expect(
      formatAvatarMutationError(
        apiErrorWith(400, JSON.stringify({ error: '...', code: 'avatar_storage_failed' })),
      ),
    ).toBe('Storage backend failed to write the avatar. Try again.');
  });

  it('renders the permission-race line for 403 forbidden (no service code)', () => {
    // Backend's PATCH/avatar 403 path returns `{ error: 'forbidden' }`
    // with no `code`. We fall through to the status-based branch.
    expect(
      formatAvatarMutationError(apiErrorWith(403, JSON.stringify({ error: 'forbidden' }))),
    ).toBe("You no longer have permission to edit this agent's avatar.");
  });

  it('renders the agent-deleted line for 404 (no service code)', () => {
    // 404 happens when the agent was deleted between cache resolve and
    // mutation send. canEditAgent's missing-row branch also lands at
    // 403, so 404 here means agent_not_found from the route layer
    // (e.g. `agentsByName` cache miss on the backend).
    expect(formatAvatarMutationError(apiErrorWith(404, ''))).toBe(
      'This agent no longer exists.',
    );
  });

  it('renders a generic HTTP fallback for unmapped statuses', () => {
    expect(formatAvatarMutationError(apiErrorWith(500, ''))).toBe(
      'Failed to update avatar (HTTP 500).',
    );
  });

  it('falls back to a generic message for non-ApiError throwables', () => {
    expect(formatAvatarMutationError(new Error('network down'))).toBe(
      'Failed to update avatar.',
    );
    expect(formatAvatarMutationError('plain string')).toBe('Failed to update avatar.');
  });

  it('prefers the service code over the status line when both are present', () => {
    // Belt-and-suspenders: even if a 4xx response also carries an
    // unrelated status (say a future backend pairs 413 with a custom
    // line), we always re-render the localized service-code message.
    const err = apiErrorWith(413, JSON.stringify({ error: '...', code: 'avatar_too_large' }));
    expect(formatAvatarMutationError(err)).toBe('Avatar must be 5 MB or smaller.');
  });
});
