/**
 * The current viewer's user ID.
 *
 * v1: always 'local' — there is no auth system yet. This is the single
 * place in the renderer where this identity is defined. All API calls
 * that need to identify the viewer read from here (via the api() helper
 * which injects X-Silverhand-Principal automatically).
 *
 * When auth is introduced, replace this constant with a resolver that
 * reads from an auth token / session cookie. No other file should need
 * to change.
 */
export const CURRENT_USER_ID = 'local' as const;
export const CURRENT_USER_DISPLAY_NAME = 'you' as const;
export const CURRENT_USER_SUBTITLE = 'current viewer' as const;

/**
 * Legacy v1 user messages have `from_user_id = null`. Treat those as
 * authored by the current viewer at the renderer boundary; newer rows
 * carry the explicit viewer id via X-Silverhand-Principal.
 */
export function isCurrentUserId(userId: string | null | undefined): boolean {
  return userId === null || userId === undefined || userId === CURRENT_USER_ID;
}

export function formatUserDisplayName(
  userId: string | null | undefined,
): string {
  if (isCurrentUserId(userId)) return CURRENT_USER_DISPLAY_NAME;
  return typeof userId === 'string' ? userId : CURRENT_USER_DISPLAY_NAME;
}
