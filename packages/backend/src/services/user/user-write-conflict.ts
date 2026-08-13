/**
 * The driver-free sentinel for a rejected `users` write (#task:1982 D4).
 *
 * Two application paths create human identities — the embedded profile
 * registration (`UserService.register`) and password signup
 * (`UserAuthService.signup`) — and BOTH used to decide "which uniqueness
 * lost?" by matching better-sqlite3 message text. That put SQLite dialect
 * knowledge in two application files and made the answer depend on wording
 * a migration could change silently.
 *
 * The persistence adapter is the only layer that may read a driver error;
 * it classifies the loss onto this axis and application code switches on
 * `kind`. Anything the adapter does not recognize is rethrown untouched —
 * an unknown write failure must never be laundered into a business answer.
 *
 * `kind` is the CONFLICTING AXIS, not the storage object: `user_id` is the
 * internally generated id (retryable — the caller may allocate another),
 * `name` is the mention handle across the shared `users.name` ⊕ `agents.name`
 * namespace (a fact to report, never worked around), `email` is the login
 * handle. Adding an axis is a contract change both create paths must answer.
 */
export type UserWriteConflictKind = 'user_id' | 'name' | 'email';

export class UserWriteConflictError extends Error {
  constructor(
    public readonly kind: UserWriteConflictKind,
    /** The original driver error, kept on the standard `cause` chain for logs
     *  — never re-parsed by callers. */
    driverError: unknown,
  ) {
    super(`user write conflict on ${kind}`, { cause: driverError });
    this.name = 'UserWriteConflictError';
  }
}
