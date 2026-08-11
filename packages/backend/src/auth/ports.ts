/**
 * Auth application ports — the driver-free contract between auth
 * orchestration (signup / login / reset / session issuance) and persistence.
 *
 * Nothing in this file may name better-sqlite3 types, SQL strings, or
 * statement/result shapes; the db-boundary port-contract gate pins that.
 * Concrete SQLite implementations live in `src/repos/` and may only be
 * imported by composition roots.
 */
import type {
  AuthSessionRow,
  UserPasswordCredentialRow,
  UserRow,
} from '@silverhand/shared';
import type { PasswordHashResult } from './credential-types.js';

export interface AuthUsersPort {
  getByEmail(email: string): UserRow | null;
  getByName(name: string): UserRow | null;
  create(input: { id: string; name: string; displayName: string; email: string }): UserRow;
}

export interface HandleNamespacePort {
  /** agents+users share ONE @-handle namespace; implementations must reuse
   *  the shared `isParticipantHandleAvailable` predicate, not re-derive it. */
  isParticipantHandleTaken(name: string): boolean;
}

export interface AuthCredentialsPort {
  getCredential(userId: string): UserPasswordCredentialRow | null;
  upsertPreparedCredential(
    userId: string,
    prepared: PasswordHashResult,
  ): UserPasswordCredentialRow;
  /** email → (userId, passwordHash) read model for login verification. */
  lookupLoginCredential(
    email: string,
  ): { userId: string; passwordHash: string | null } | null;
}

export interface NewAuthSessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  lastUsedAt: number;
  userAgent: string | null;
  ipFirstSeen: string | null;
}

export interface AuthSessionsPort {
  insertSession(row: NewAuthSessionRow): AuthSessionRow;
  getByTokenHash(tokenHash: string): AuthSessionRow | null;
  touchLastUsed(id: string, at: number): void;
  revokeByTokenHash(tokenHash: string, at: number): boolean;
  revokeAllForUser(userId: string, at: number): number;
}

/** Ports scoped to ONE transaction: the UnitOfWork implementation guarantees
 *  every port in the scope operates on the same transaction/connection. */
export interface AuthTxScope {
  users: AuthUsersPort;
  credentials: AuthCredentialsPort;
  sessions: AuthSessionsPort;
}

export interface AuthUnitOfWork {
  /**
   * Atomic write: all-or-nothing across the scope's ports, which the
   * persistence implementation binds to one transaction/connection.
   *
   * Lock acquisition strategy (e.g. SQLite BEGIN IMMEDIATE for the offline
   * admin process competing with a running server) is a persistence-side
   * transaction POLICY chosen at composition time — it never appears on this
   * application-facing contract.
   */
  atomically<T>(fn: (tx: AuthTxScope) => T): T;
}
