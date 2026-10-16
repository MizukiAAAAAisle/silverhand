/**
 * The WIRE form of a principal's avatar: the relative avatar path with a
 * `?v=<updated_at>` cache-buster, or null when the row carries no avatar blob.
 * A storage key never crosses the wire — it is a server-side coordinate, and
 * `avatar_url` is the only avatar fact a client is given.
 *
 * One rule, one definition (#task:2035). Every DTO that carries `avatar_url`
 * derives it exactly this way, and before this helper the same three-line
 * ternary was spelled out in five places — AgentDto, UserDto, the conversation
 * roster, the message-author resolver and the activity preview — which is one
 * spelling per surface that could drift from the others. The cache-buster is
 * load-bearing: `updated_at` is bumped by every avatar upload/clear, so a
 * renderer's HTTP cache refreshes on exactly those writes and on no others.
 *
 * `path` is passed in rather than derived from a kind, because the caller
 * already knows which principal it holds (`apiPaths.agentAvatar(id)` /
 * `apiPaths.userAvatar(id)`) and a kind parameter here would add a second
 * agent-vs-human discrimination to a function whose whole job is the suffix.
 */
export function principalAvatarUrl(
  path: string,
  avatarStorageKey: string | null,
  updatedAt: number,
): string | null {
  // Truthiness, not `!== null`, so the five call sites this replaces keep their
  // exact behavior: an empty storage key was never an avatar either.
  return avatarStorageKey ? `${path}?v=${updatedAt}` : null;
}

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The avatar-maker source of an avatar image. Sent as the optional multipart
 * `design` part (JSON text) next to `file` on avatar upload; an upload without it
 * clears the stored design. `config` is opaque to the server (JSON object, ≤ 4 KB).
 */
export interface AvatarDesign {
  parts_version: number;
  config: Record<string, unknown>;
}

export const AVATAR_DESIGN_FIELD = 'design';

/** `GET …/avatar/design`; `null` when the current avatar is not a design. */
export interface AvatarDesignResponse {
  design: AvatarDesign | null;
}
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
