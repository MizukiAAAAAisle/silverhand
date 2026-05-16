export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_SIZE_LABEL = '5 MB';

export const AVATAR_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type AvatarValidationCode =
  | 'avatar_missing'
  | 'avatar_too_large'
  | 'avatar_unsupported_type';

export interface AvatarValidationError {
  code: AvatarValidationCode;
  message: string;
}

export interface AvatarFileLike {
  size: number;
  type: string;
}

export function validateAvatarFile(
  file: AvatarFileLike,
): AvatarValidationError | null {
  if (file.size <= 0) {
    return { code: 'avatar_missing', message: 'Avatar file is empty.' };
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return {
      code: 'avatar_too_large',
      message: `Avatar must be ${AVATAR_MAX_SIZE_LABEL} or smaller.`,
    };
  }
  const contentType = file.type.toLowerCase();
  if (!(AVATAR_ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return {
      code: 'avatar_unsupported_type',
      message: 'Avatar must be a PNG, JPEG, GIF, or WEBP image.',
    };
  }
  return null;
}
