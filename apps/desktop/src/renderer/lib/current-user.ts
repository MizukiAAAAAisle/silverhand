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
 * Displayed label for rows whose author has been lost (pre-multi-human
 * `from_user_id = null` and post-rewrite rows whose `user_id` did not
 * survive a destructive backend cleanup). Renders to humans as
 * "Unknown" rather than masquerading as the current viewer.
 *
 * Multi-human invariant: a `null` author MUST NOT collapse to "you" —
 * that path made every legacy null-authored row appear as a personal
 * write to whoever happened to be signed in (Alice audit 2026-06-03
 * #task:857 P0.5 / #2).
 */
export const UNKNOWN_USER_DISPLAY_NAME = 'Unknown user' as const;

/**
 * Type narrowing: is the supplied user id the current viewer?
 *
 * Multi-human safe. Returns `false` for `null`/`undefined`/unknown ids
 * — the legacy "null = me" shortcut only ever worked when there was a
 * single human on the box; in a multi-human deployment every viewer
 * would see the same null-authored row as theirs, which both leaks
 * intent and corrupts the "edit own messages" affordance.
 */
export function isCurrentUserId(userId: string | null | undefined): boolean {
  if (userId === null || userId === undefined) return false;
  return currentUserId !== null && userId === currentUserId;
}

/**
 * Resolver shape consumed by {@link formatUserDisplayName}. Returns the
 * user's display name (or null when the user is not in the directory
 * yet — e.g. picker still loading). Built from `useUsersById()` /
 * conversation human members in callers.
 *
 * Kept as a plain function rather than a `Map<string, UserDto>` so
 * callers can layer multiple sources (conversation humans + global
 * users) without forcing a merge map at every callsite.
 */
export type UserNameResolver = (userId: string) => string | null;

/**
 * Render a human author's display name.
 *
 * Resolution order:
 *   1. `null`/`undefined` → {@link UNKNOWN_USER_DISPLAY_NAME}. Legacy
 *      rows whose author was never recorded. Do NOT collapse to "you".
 *   2. Viewer's own id → the viewer's display name (defaults to "you"
 *      sentinel). Stable across renders even if the directory hasn't
 *      hydrated yet.
 *   3. Resolver hit → the directory's display name.
 *   4. Fallback → the raw id. Indicates the user is not in the
 *      directory (deleted account, race window before `/api/users`
 *      loads). Surfaced as the id rather than a placeholder so a
 *      mis-match is debuggable.
 */
export function formatUserDisplayName(
  userId: string | null | undefined,
  resolver?: UserNameResolver,
): string {
  if (userId === null || userId === undefined) return UNKNOWN_USER_DISPLAY_NAME;
  if (isCurrentUserId(userId)) return currentUserDisplayName;
  if (resolver) {
    const resolved = resolver(userId);
    if (resolved) return resolved;
  }
  return userId;
}
