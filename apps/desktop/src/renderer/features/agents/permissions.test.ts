import { describe, expect, it } from 'vitest';
import type { AgentDto, RegistrationRequired, UserDto } from '@silverhand/shared';
import { canEditAgentProfile } from './permissions';

const agent = (overrides: Partial<AgentDto> = {}): AgentDto =>
  ({
    id: 'a-1',
    host_id: 'h-1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude',
    description: null,
    model: null,
    reasoning_effort: null,
    fast_mode: null,
    avatar_url: null,
    created_by_user_id: 'u-creator',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }) as AgentDto;

const viewer = (overrides: Partial<UserDto> = {}): UserDto =>
  ({
    id: 'u-creator',
    name: 'shiki',
    display_name: 'shiki',
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }) as UserDto;

const registrationRequired: RegistrationRequired = {
  registration_required: true,
  suggested_name: 'user-1234',
};

describe('canEditAgentProfile', () => {
  it('returns true when the viewer is the creator', () => {
    expect(
      canEditAgentProfile(viewer({ id: 'u-creator' }), agent({ created_by_user_id: 'u-creator' })),
    ).toBe(true);
  });

  it('returns false when the viewer is not the creator', () => {
    expect(
      canEditAgentProfile(viewer({ id: 'u-other' }), agent({ created_by_user_id: 'u-creator' })),
    ).toBe(false);
  });

  it('returns false during pre-registration / registration_required state', () => {
    // Pre-registration shell never has edit rights — the registration
    // gate covers the app, but we still default-deny rather than rely
    // on the gate as a side effect.
    expect(canEditAgentProfile(registrationRequired, agent())).toBe(false);
  });

  it('returns false while /api/me is still loading (viewer undefined)', () => {
    // Conservatively read-only until the query resolves; flips to the
    // editable form on the next render once the dto arrives.
    expect(canEditAgentProfile(undefined, agent())).toBe(false);
  });

  it('does not surface an agent-self path — only the creator branch is modeled', () => {
    // The renderer never holds an agent-self principal; even if some
    // future code shape compares "viewer.id === agent.id", the helper
    // must NOT treat that as edit permission. Profile-field self-edit
    // is intentionally not shipped (Cindy PR-2/PR-3 guardrail).
    expect(
      canEditAgentProfile(viewer({ id: 'a-1' }), agent({ id: 'a-1', created_by_user_id: 'u-creator' })),
    ).toBe(false);
  });
});
