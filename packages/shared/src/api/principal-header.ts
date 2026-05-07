export const X_SILVERHAND_PRINCIPAL_HEADER = 'X-Silverhand-Principal';
export const X_SILVERHAND_LEGACY_USER_ID_HEADER = 'X-Silverhand-User-Id';

const USER_PRINCIPAL_PREFIX = 'user:';

export function encodeUserPrincipalHeader(userId: string): string {
  return `${USER_PRINCIPAL_PREFIX}${encodeURIComponent(userId)}`;
}

export function decodeUserPrincipalHeader(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(USER_PRINCIPAL_PREFIX)) return null;
  const encodedUserId = trimmed.slice(USER_PRINCIPAL_PREFIX.length);
  if (!encodedUserId) return null;
  try {
    return decodeURIComponent(encodedUserId);
  } catch {
    return null;
  }
}
