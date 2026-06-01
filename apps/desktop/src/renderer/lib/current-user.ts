/**
 * The current viewer's user id, as resolved from the main-process
 * desktop auth session.
 *
 * The renderer never receives the `user_token`. On boot,
 * `useViewerUser()` asks main for the auth state; main reads /
 * validates the main-owned 0600 local session file and returns only the
 * resolved `UserDto`. When unauthenticated, the app mounts the setup
 * wizard instead of the shell, so `setCurrentUserId` is never called.
 * After signup/login succeeds, main stores the token and returns the
 * user dto; from then on `getCurrentUserId()` / `isCurrentUserId()`
 * resolve against the real id.
 */
let currentUserId: string | null = null;
let currentUserDisplayName: string = 'you';

export function setCurrentUserId(id: string, displayName?: string): void {
  currentUserId = id;
  if (displayName) currentUserDisplayName = displayName;
}

export function clearCurrentUser(): void {
  currentUserId = null;
  currentUserDisplayName = 'you';
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
