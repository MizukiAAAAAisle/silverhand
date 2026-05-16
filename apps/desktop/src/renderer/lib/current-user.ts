/**
 * The current viewer's user id, as resolved at app boot.
 *
 * Pre-PR1 (V1): the renderer hard-coded `'local'` because the backend
 * row was synthesized from `serverConfig.user_id` at request time —
 * there was no real `users` row.
 *
 * Post pre-ship rewrite (V1): `users` is empty until the human runs
 * `POST /api/register`, which atomically INSERTs a row with a 16-hex
 * random id and writes `app_settings.viewer_user_id`. The renderer
 * reads `/api/me` at boot; while the response is the
 * `registration_required` shape the renderer mounts the registration
 * gate INSTEAD of the shell, so `setCurrentUserId` is never called
 * pre-registration. After registration succeeds, `useViewerUser()`
 * receives the resolved `UserDto` and calls
 * `setCurrentUserId(viewer.id, viewer.display_name)` once; from then
 * on `getCurrentUserId()` / `isCurrentUserId()` resolve against the
 * real id.
 *
 * Until the boot fetch returns, `getCurrentUserId()` returns `null`.
 * The api() helper interprets that as "do not stamp the
 * X-Silverhand-Principal header" — the backend's principal middleware
 * then resolves the viewer via `app_settings.viewer_user_id` (set by
 * registration). The literal `'local'` is NOT a valid viewer id under
 * this model and is not aliased to "me" anywhere.
 *
 * V2 (multi-user): the same setter is called from the auth-resolved
 * session/token claims; the rest of the renderer stays untouched.
 */
let currentUserId: string | null = null;
let currentUserDisplayName: string = 'you';

export function setCurrentUserId(id: string, displayName?: string): void {
  currentUserId = id;
  if (displayName) currentUserDisplayName = displayName;
}

/** Resolved viewer id, or null until the boot-time hydration finishes. */
export function getCurrentUserId(): string | null {
  return currentUserId;
}

export const CURRENT_USER_DISPLAY_NAME = 'you' as const;
export const CURRENT_USER_SUBTITLE = 'current viewer' as const;

/**
 * Legacy v1 user messages have `from_user_id = null`. Treat those as
 * authored by the current viewer at the renderer boundary; newer rows
 * carry the explicit viewer id.
 *
 * No `'local'` alias: the pre-ship rewrite migration NULLs / DELETEs
 * any pre-v21 `'local'` literal references. If a `'local'` id ever
 * leaks through to the renderer post-rewrite that's a bug — surface
 * it as a stranger, not as "me".
 */
export function isCurrentUserId(userId: string | null | undefined): boolean {
  if (userId === null || userId === undefined) return true;
  return currentUserId !== null && userId === currentUserId;
}

export function formatUserDisplayName(
  userId: string | null | undefined,
): string {
  if (isCurrentUserId(userId)) return currentUserDisplayName;
  return typeof userId === 'string' ? userId : currentUserDisplayName;
}
