import { describe, expect, it } from 'vitest';
import {
  CompleteEmbeddedProfileSetupInputSchema,
  EmbeddedProfileSetupResponseSchema,
} from '../src/api/user.js';
import { apiPaths } from '../src/api/paths.js';

describe('embedded profile setup contract', () => {
  it('uses the existing identity validators and admits no caller-selected user or completion flag', () => {
    expect(
      CompleteEmbeddedProfileSetupInputSchema.parse({ name: 'Alice_1', display_name: ' Alice ' }),
    ).toEqual({ name: 'Alice_1', display_name: 'Alice' });
    for (const input of [
      { name: '123', display_name: 'Alice' },
      { name: 'Alice', display_name: '' },
      { name: 'Alice', display_name: 'Alice', user_id: 'someone-else' },
      { name: 'Alice', display_name: 'Alice', required: false },
    ])
      expect(CompleteEmbeddedProfileSetupInputSchema.safeParse(input).success).toBe(false);
  });

  it('returns durable status with the current viewer, without credentials', () => {
    const user = {
      id: 'u1',
      name: 'Alice',
      display_name: 'Alice',
      avatar_url: null,
      created_at: 1,
      updated_at: 2,
    };
    expect(EmbeddedProfileSetupResponseSchema.parse({ required: false, user })).toEqual({
      required: false,
      user,
    });
    expect(EmbeddedProfileSetupResponseSchema.safeParse({ user }).success).toBe(false);
    expect(apiPaths.embeddedProfileSetup).toBe('/api/me/embedded-profile-setup');
  });
});
