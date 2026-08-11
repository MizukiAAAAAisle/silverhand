import { randomBytes } from 'node:crypto';
import type { AuthSignupInput } from '@silverhand/shared';
import { DISPLAY_NAME_MAX_LENGTH } from '@silverhand/shared';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import {
  normalizeLoginEmail,
  type PasswordCredentialService,
} from './password.js';
import type {
  AuthUnitOfWork,
  AuthUsersPort,
  HandleNamespacePort,
} from './ports.js';

export interface UserPasswordResetResult {
  userId: string;
  email: string;
  sessionsRevoked: number;
}

export class UserAuthService {
  private readonly uow: AuthUnitOfWork;
  private readonly users: AuthUsersPort;
  /** Signup needs the OTHER half of the @-handle namespace: a handle held by an
   *  agent is just as taken as one held by a human, and answering that before
   *  the credential check is what keeps the 409 off the email axis. */
  private readonly handles: HandleNamespacePort;
  private readonly passwordCredentials: PasswordCredentialService;
  private readonly events?: ScopeEventBus;

  constructor(opts: {
    uow: AuthUnitOfWork;
    users: AuthUsersPort;
    handles: HandleNamespacePort;
    passwordCredentials: PasswordCredentialService;
    events?: ScopeEventBus;
  }) {
    this.uow = opts.uow;
    this.users = opts.users;
    this.handles = opts.handles;
    this.passwordCredentials = opts.passwordCredentials;
    this.events = opts.events;
  }

  /**
   * Announce a genuine first-time signup to every app-scope viewer, the
   * standalone-path twin of `UserService.publishChanged` (human and agent
   * are isomorphic actors, so both identity-create paths propagate through
   * the same `user_changed` mechanism + `{user_id}` payload). Optional
   * because the offline reset-password admin path constructs this service
   * with no live event bus and never signs up (#task:1707).
   */
  private publishCreated(id: string): void {
    this.events?.publishToScope('app', 'user_changed', { user_id: id });
  }

  /**
   * Register a brand-new email+password identity.
   *
   * Answer ordering is a SECURITY property, not a style choice (#task:1830):
   * the handle verdict must depend only on the handle. If the email check came
   * first, an attacker holding one publicly-known taken handle could read 401
   * as "this email is registered" and 409 as "it is not" — the uniform
   * credential answer would have become an email-existence oracle the moment
   * signup gained a typed conflict code. So: pay the password cost, then decide
   * the handle, then the credential answer.
   */
  async signup(
    input: AuthSignupInput,
  ): Promise<
    | { ok: true; userId: string }
    | { ok: false; code: 'auth_failed' }
    | { ok: false; code: 'handle_taken' }
  > {
    const email = normalizeLoginEmail(input.email);
    // Cost floor first, before any branch: every attempt that gets HERE — signup
    // enabled, body already through the request schema — pays one Argon2id hash
    // whatever the outcome, so neither answer below is a cheap probe. Earlier
    // route-level exits (`signup_disabled`, `invalid input`) do not hash and read
    // no identity state, so they are not part of this floor. This replaces the
    // former dummy-verify on the existing-email path — the work is now
    // unconditional instead of per-branch.
    const credential = await this.passwordCredentials.hashPasswordCredential(
      input.password,
    );

    // Decided on the handle alone, for both halves of the mention namespace.
    // Racy by construction — the catch below re-answers in this same order, so
    // the ordering holds on the DB-conflict path too.
    if (this.handles.isParticipantHandleTaken(input.name)) {
      return { ok: false, code: 'handle_taken' };
    }
    if (this.users.getByEmail(email)) return { ok: false, code: 'auth_failed' };

    const displayName =
      input.display_name ?? displayNameFromEmailLocalPart(emailLocalPart(email));

    // The retry loop covers ONLY internal id allocation. The handle is the
    // user's choice (#task:1830), so a name collision is a fact to report, not
    // something to work around by silently storing a suffixed variant of a
    // permanent, non-renamable identifier.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const id = randomHex(8);
      try {
        const userId = this.uow.atomically(tx => {
          const row = tx.users.create({
            id,
            name: input.name,
            displayName,
            email,
          });
          tx.credentials.upsertPreparedCredential(row.id, credential);
          return row.id;
        });
        // The tx committed a brand-new user row — the existing-email case is
        // handled above and returns `auth_failed` before reaching here — so
        // announce the genuine creation exactly once after commit.
        this.publishCreated(userId);
        return { ok: true, userId };
      } catch (err) {
        // Internal id allocation is a different axis: retry, and whatever else
        // is wrong resurfaces on the next attempt.
        if (isUserIdConflict(err)) continue;
        if (isNameConflict(err) || isEmailConflict(err)) {
          // A conflict here means the world moved under the pre-checks, so
          // RE-ANSWER in the same priority order instead of mapping each error
          // 1:1. Mapping 1:1 would let SQLite pick the answer: when the handle
          // and the email are both taken, `users.email` UNIQUE can fire before
          // the name trigger, and a taken handle would then be reported as 401
          // — the very email-existence oracle the ordering above exists to
          // prevent. Re-reading the handle is authoritative because a conflict
          // proves the pre-check read is stale.
          if (this.handles.isParticipantHandleTaken(input.name)) {
            return { ok: false, code: 'handle_taken' };
          }
          // Handle free on re-read: either the email is the conflict, or a
          // handle taken at INSERT time has since been released (agent names
          // can be hard-deleted). Never lose the name-conflict fact.
          if (isEmailConflict(err)) return { ok: false, code: 'auth_failed' };
          return { ok: false, code: 'handle_taken' };
        }
        throw err;
      }
    }
    throw new Error('UserAuthService.signup: could not allocate unique user id');
  }

  async resetPassword(input: {
    email: string;
    password: string;
  }): Promise<
    | { ok: true; reset: UserPasswordResetResult }
    | { ok: false; code: 'user_not_found' }
  > {
    const email = normalizeLoginEmail(input.email);
    const user = this.users.getByEmail(email);
    if (!user) return { ok: false, code: 'user_not_found' };

    const credential = await this.passwordCredentials.hashPasswordCredential(
      input.password,
    );
    const reset = this.uow.atomically((tx): UserPasswordResetResult => {
      tx.credentials.upsertPreparedCredential(user.id, credential);
      return {
        userId: user.id,
        email: user.email ?? email,
        sessionsRevoked: tx.sessions.revokeAllForUser(user.id, Date.now()),
      };
    });

    return { ok: true, reset };
  }
}

function emailLocalPart(email: string): string {
  return email.split('@')[0] ?? 'user';
}

/**
 * Default for the MUTABLE `display_name` when signup omits it. Unlike the
 * handle, this is a label the user can change from the profile editor at any
 * time, so deriving a first value from the email costs nothing irreversible.
 * The retired `users.name` deriver used to live beside this one; the handle is
 * now supplied by the caller (#task:1830) and the prefill half moved to
 * `suggestParticipantNameFromEmail` in @silverhand/shared, where it sits next to
 * the grammar it must respect.
 */
function displayNameFromEmailLocalPart(localPart: string): string {
  const normalized = localPart
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Fit the SYSTEM-derived default to the same bound `DisplayNameSchema`
  // enforces on user-supplied names (#task:1849 swept the duplicated
  // literals): this value never passes through that schema — signup
  // writes it straight to the row — so a bare `64` here would be a second
  // authority on the field's length. Trailing trim runs after the cut in
  // case it lands mid-space, matching the schema's own `.trim()`.
  return (normalized || 'User')
    .slice(0, DISPLAY_NAME_MAX_LENGTH)
    .trim();
}

function isEmailConflict(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    /UNIQUE constraint failed: users\.email/.test(message)
    || /uniq_users_email_when_set/.test(message)
  );
}

function isNameConflict(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    /users\.name collides with an existing agent name/.test(message)
    || /UNIQUE constraint failed: users\.name/.test(message)
  );
}

function isUserIdConflict(err: unknown): boolean {
  return /UNIQUE constraint failed: users\.id/.test(errorMessage(err));
}

function errorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  return String((err as { message?: unknown }).message ?? '');
}

function randomHex(byteCount: number): string {
  return randomBytes(byteCount).toString('hex');
}
