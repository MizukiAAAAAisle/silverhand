import { describe, expect, it } from 'vitest';
import { ServerInfoSchema, serverFeatures } from '../src/index.js';

describe('serverFeatures', () => {
  it('treats an older response without features as legacy signup and no recovery', () => {
    const info = ServerInfoSchema.parse({ signup_enabled: true });
    expect(serverFeatures(info)).toEqual({
      signup_enabled: true,
      password_recovery_enabled: false,
      account_deletion_enabled: false,
    });
  });

  it('prefers the nested signup value, including false over a legacy true', () => {
    const info = ServerInfoSchema.parse({
      signup_enabled: true,
      features: {
        signup_enabled: false,
        password_recovery_enabled: true,
        account_deletion_enabled: true,
      },
    });
    expect(serverFeatures(info)).toEqual({
      signup_enabled: false,
      password_recovery_enabled: true,
      account_deletion_enabled: true,
    });
  });

  it('reads a missing recovery key inside features as off', () => {
    const info = ServerInfoSchema.parse({ signup_enabled: false, features: {} });
    expect(serverFeatures(info)).toEqual({
      signup_enabled: false,
      password_recovery_enabled: false,
      account_deletion_enabled: false,
    });
  });
});
