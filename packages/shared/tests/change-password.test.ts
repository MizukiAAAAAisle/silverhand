import { describe, expect, it } from 'vitest';
import {
  ChangePasswordInputSchema,
  AuthSignupInputSchema,
  PasswordStatusResponseSchema,
} from '../src/api/user.js';

describe('self password change contract', () => {
  it('uses signup password bounds without trimming or normalizing secrets', () => {
    for (const password of [
      'short',
      '12345678',
      ' a b c d ',
      'x'.repeat(1024),
      'x'.repeat(1025),
      '😀'.repeat(512),
      '😀'.repeat(513),
    ]) {
      const change = ChangePasswordInputSchema.safeParse({
        current_password: 'old',
        new_password: password,
      });
      const signup = AuthSignupInputSchema.safeParse({
        email: 'test@example.com',
        name: 'alice',
        password,
      });
      expect(change.success).toBe(signup.success);
      if (change.success) expect(change.data.new_password).toBe(password);
    }
  });
  it('rejects caller identity and blank current passwords', () => {
    expect(
      ChangePasswordInputSchema.safeParse({ current_password: '', new_password: '12345678' })
        .success,
    ).toBe(false);
    expect(
      ChangePasswordInputSchema.safeParse({
        current_password: 'old',
        new_password: '12345678',
        user_id: 'other',
      }).success,
    ).toBe(false);
    expect(PasswordStatusResponseSchema.parse({ has_password: false })).toEqual({
      has_password: false,
    });
  });
});
