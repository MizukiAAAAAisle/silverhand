import { describe, expect, it } from 'vitest';
import { resolveAuthRuntimeConfig } from '../../src/auth/config.js';

describe('auth runtime config', () => {
  it('freezes signup and session settings from the startup environment', () => {
    const config = resolveAuthRuntimeConfig({
      SILVERHAND_DISABLE_SIGNUP: '1',
      SILVERHAND_AUTH_SESSION_TTL_DAYS: '2',
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(config.signupEnabled).toBe(false);
    expect(config.sessionTtlMs).toBe(2 * 24 * 60 * 60 * 1000);
  });
});
