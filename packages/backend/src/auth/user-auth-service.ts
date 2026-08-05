import { randomBytes } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { AuthSignupInput } from '@silverhand/shared';
import { UserRepo } from '../repos/user-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import {
  normalizeLoginEmail,
  type PasswordCredentialService,
} from './password.js';
import type { AuthSessionService } from './session.js';

export interface UserPasswordResetResult {
  userId: string;
  email: string;
  sessionsRevoked: number;
}

export class UserAuthService {
  private readonly db: Db;
  private readonly users: UserRepo;
  private readonly passwordCredentials: PasswordCredentialService;
  private readonly authSessions: AuthSessionService;
  private readonly events?: ScopeEventBus;

  constructor(opts: {
    db: Db;
    users: UserRepo;
    passwordCredentials: PasswordCredentialService;
    authSessions: AuthSessionService;
    events?: ScopeEventBus;
  }) {
    this.db = opts.db;
    this.users = opts.users;
    this.passwordCredentials = opts.passwordCredentials;
    this.authSessions = opts.authSessions;
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

  async signup(
    input: AuthSignupInput,
  ): Promise<
    | { ok: true; userId: string }
    | { ok: false; code: 'auth_failed' }
    | { ok: false; code: 'handle_taken' }
  > {
    const email = normalizeLoginEmail(input.email);
    if (this.users.getByEmail(email)) {
      await this.passwordCredentials.verifyLoginPassword({
        email,
        password: input.password,
      });
      return { ok: false, code: 'auth_failed' };
    }

    const credential = await this.passwordCredentials.hashPasswordCredential(
      input.password,
    );
    const displayName =
      input.display_name ?? displayNameFromEmailLocalPart(emailLocalPart(email));
    const tx = this.db.transaction(
      (args: { id: string; name: string; displayName: string; email: string }) => {
        const row = this.users.create({
          id: args.id,
          name: args.name,
          displayName: args.displayName,
          email: args.email,
        });
        this.passwordCredentials.setPreparedUserPasswordCredential(
          row.id,
          credential,
        );
        return row.id;
      },
    );

    // The retry loop covers ONLY internal id allocation. The handle is the
    // user's choice (#task:1830), so a name collision is a fact to report, not
    // something to work around by silently storing a suffixed variant of a
    // permanent, non-renamable identifier.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const userId = tx({
          id: randomHex(8),
          name: input.name,
          displayName,
          email,
        });
        // The tx committed a brand-new user row — the existing-email case is
        // handled above and returns `auth_failed` before reaching here — so
        // announce the genuine creation exactly once after commit.
        this.publishCreated(userId);
        return { ok: true, userId };
      } catch (err) {
        if (isEmailConflict(err)) {
          await this.passwordCredentials.verifyLoginPassword({
            email,
            password: input.password,
          });
          return { ok: false, code: 'auth_failed' };
        }
        // Both halves of the mention namespace land here: the `users.name`
        // column UNIQUE and the migration v21 cross-table trigger against
        // `agents.name`. One code for both — the caller cannot act differently
        // on "a human has it" vs "an agent has it".
        if (isNameConflict(err)) return { ok: false, code: 'handle_taken' };
        if (isUserIdConflict(err)) continue;
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
    const tx = this.db.transaction((): UserPasswordResetResult => {
      this.passwordCredentials.setPreparedUserPasswordCredential(
        user.id,
        credential,
      );
      return {
        userId: user.id,
        email: user.email ?? email,
        sessionsRevoked: this.authSessions.revokeAllForUser(user.id),
      };
    });

    return { ok: true, reset: tx.immediate() };
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
  return (normalized || 'User').slice(0, 64);
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
