import { randomBytes } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { AuthSignupInput } from '@silverhand/shared';
import { UserRepo } from '../repos/user-repo.js';
import {
  normalizeLoginEmail,
  type PasswordCredentialService,
} from './password.js';

export class UserAuthService {
  private readonly db: Db;
  private readonly users: UserRepo;
  private readonly passwordCredentials: PasswordCredentialService;

  constructor(opts: {
    db: Db;
    users: UserRepo;
    passwordCredentials: PasswordCredentialService;
  }) {
    this.db = opts.db;
    this.users = opts.users;
    this.passwordCredentials = opts.passwordCredentials;
  }

  async signup(
    input: AuthSignupInput,
  ): Promise<{ ok: true; userId: string } | { ok: false; code: 'auth_failed' }> {
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

    const baseName = profileNameFromEmailLocalPart(emailLocalPart(email));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return {
          ok: true,
          userId: tx({
            id: randomHex(8),
            name: nameCandidate(baseName, attempt),
            displayName,
            email,
          }),
        };
      } catch (err) {
        if (isEmailConflict(err)) {
          await this.passwordCredentials.verifyLoginPassword({
            email,
            password: input.password,
          });
          return { ok: false, code: 'auth_failed' };
        }
        if (isNameConflict(err) || isUserIdConflict(err)) continue;
        throw err;
      }
    }
    throw new Error('UserAuthService.signup: could not allocate unique user identity');
  }
}

function emailLocalPart(email: string): string {
  return email.split('@')[0] ?? 'user';
}

function displayNameFromEmailLocalPart(localPart: string): string {
  const normalized = localPart
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'User').slice(0, 64);
}

function profileNameFromEmailLocalPart(localPart: string): string {
  const normalized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/[-_]+$/g, '');
  const base = normalized || 'user';
  const alphaFirst = /^[a-z]/.test(base) ? base : `user-${base}`;
  return alphaFirst.slice(0, 32);
}

function nameCandidate(baseName: string, attempt: number): string {
  if (attempt === 0) return baseName.length >= 2 ? baseName : `${baseName}u`;
  const suffix = `-${randomHex(2)}`;
  return `${baseName.slice(0, Math.max(2, 32 - suffix.length))}${suffix}`;
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
