import { describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  validateAvatarFile,
} from '@silverhand/shared';

describe('validateAvatarFile', () => {
  it('accepts supported images inside the size cap', () => {
    expect(validateAvatarFile({ size: 128, type: 'image/png' })).toBeNull();
    expect(validateAvatarFile({ size: 128, type: 'image/jpeg' })).toBeNull();
  });

  it('rejects empty files', () => {
    expect(validateAvatarFile({ size: 0, type: 'image/png' })).toMatchObject({
      code: 'avatar_missing',
    });
  });

  it('rejects files larger than 5 MB', () => {
    expect(
      validateAvatarFile({
        size: AVATAR_MAX_BYTES + 1,
        type: 'image/png',
      }),
    ).toMatchObject({ code: 'avatar_too_large' });
  });

  it('rejects unsupported content types', () => {
    expect(validateAvatarFile({ size: 128, type: 'text/plain' })).toMatchObject({
      code: 'avatar_unsupported_type',
    });
  });
});
