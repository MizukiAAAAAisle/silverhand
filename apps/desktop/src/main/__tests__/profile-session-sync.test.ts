import { describe, expect, it } from 'vitest';
import { apiPaths, type UserDto } from '@silverhand/shared';
import {
  extractViewerUserFromProfileMutation,
} from '../profile-session-sync';

function userDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    name: 'iu',
    display_name: '@iu lakphy',
    avatar_url: null,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe('extractViewerUserFromProfileMutation', () => {
  it('extracts PATCH /api/me UserDto responses, preserving display names with spaces', () => {
    const user = userDto();

    expect(
      extractViewerUserFromProfileMutation(
        { method: 'PATCH', path: apiPaths.me },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it('extracts DELETE /api/me/avatar UserDto responses', () => {
    const user = userDto({ avatar_url: null });

    expect(
      extractViewerUserFromProfileMutation(
        { method: 'DELETE', path: apiPaths.meAvatar },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it('extracts POST /api/me/avatar upload responses from the nested user field', () => {
    const user = userDto({ avatar_url: 'silverhand-blob://users/u-1/avatar' });

    expect(
      extractViewerUserFromProfileMutation(
        { method: 'POST', path: apiPaths.meAvatar },
        {
          status: 200,
          bodyText: JSON.stringify({
            avatar_url: user.avatar_url,
            user,
          }),
        },
      ),
    ).toEqual(user);
  });

  it('ignores non-profile routes, reads, failures, and malformed bodies', () => {
    const user = userDto();

    expect(
      extractViewerUserFromProfileMutation(
        { method: 'GET', path: apiPaths.me },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProfileMutation(
        { method: 'PATCH', path: apiPaths.me },
        { status: 401, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProfileMutation(
        { method: 'PATCH', path: apiPaths.me },
        { status: 200, bodyText: '{"not":"a user"}' },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProfileMutation(
        { method: 'PATCH', path: '/api/workspaces' },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
  });
});
