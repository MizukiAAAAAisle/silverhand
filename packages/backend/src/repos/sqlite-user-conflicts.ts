import {
  UserWriteConflictError,
  type UserWriteConflictKind,
} from '../services/user/user-write-conflict.js';

/**
 * The ONE place that decodes a SQLite rejection of a `users` write
 * (#task:1982 D4). Before this module the same message-matching lived in
 * `services/user-service.ts` and `auth/user-auth-service.ts`; both create
 * paths now funnel through `UserRepo.create`, so there is a single decoding
 * site and the two application files carry no driver dialect at all
 * (enforced by the driver-dialect fence in
 * `tests/db-boundary/port-contract.test.ts`).
 *
 * The uniqueness rules being decoded, and where they are declared:
 *   - `users.id`    — PRIMARY KEY (`users` DDL).
 *   - `users.name`  — column UNIQUE, PLUS the cross-namespace triggers that
 *     RAISE(ABORT, 'users.name collides with an existing agent name') when the
 *     handle is held by an agent (`baseline-schema.ts`). Both are the SAME
 *     domain fact — the shared `@handle` namespace — so both map to `name`.
 *   - `users.email` — the partial unique index `uniq_users_email_when_set`
 *     (SQLite names the INDEX, not the column, in that message).
 *
 * Message text is engine wording, deliberately quoted here and nowhere else.
 * If a migration renames the index or reworks the trigger, this module and its
 * per-arm tests are the only things to update.
 */
function classify(message: string): UserWriteConflictKind | null {
  if (/UNIQUE constraint failed: users\.id\b/.test(message)) return 'user_id';
  if (/users\.name collides with an existing agent name/.test(message)) return 'name';
  if (/UNIQUE constraint failed: users\.name\b/.test(message)) return 'name';
  if (/UNIQUE constraint failed: users\.email\b/.test(message)) return 'email';
  if (/uniq_users_email_when_set/.test(message)) return 'email';
  return null;
}

/**
 * Rethrow a `users` write failure as a driver-free conflict, or pass it
 * through untouched.
 *
 * Pass-through is the load-bearing half: a disk error, a CHECK violation or a
 * NOT NULL violation must NOT become a business answer like "handle taken".
 * Callers therefore see either a `UserWriteConflictError` or the original
 * error — never a swallowed one. Always throws; typed `never` so call sites
 * read as a rethrow rather than as recovery.
 */
export function throwAsUserWriteConflict(err: unknown): never {
  const message =
    err && typeof err === 'object'
      ? String((err as { message?: unknown }).message ?? '')
      : '';
  const kind = classify(message);
  if (kind) throw new UserWriteConflictError(kind, err);
  throw err;
}
