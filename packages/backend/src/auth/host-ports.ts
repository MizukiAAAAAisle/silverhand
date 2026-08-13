/**
 * Host-domain application ports — the driver-free contract between host
 * orchestration and persistence. Two faces of one aggregate live here:
 * credential lifecycle (issue / rotate / verify / revoke) and setup lifecycle
 * (first-attach activation → naming → finalize). Same discipline as
 * auth/ports.ts: no better-sqlite3 types, no SQL, gated by the db-boundary
 * port-contract suite.
 */
import type {
  HostCredentialKind,
  HostCredentialRow,
  HostDto,
  HostKind,
  HostProvisioningSource,
  HostRow,
} from '@silverhand/shared';

export interface NewHostCredentialRow {
  id: string;
  hostId: string;
  tokenHash: string;
  kind: HostCredentialKind;
  expiresAt: number | null;
  consumedAt: number | null;
}

/** Single consistent read joining a credential with its host's auth state —
 *  a field projection only; every verdict stays in the domain service. */
export interface CredentialWithHostStatus extends HostCredentialRow {
  host_user_id: string | null;
  host_revoked_at: number | null;
}

export interface HostCredentialsPort {
  insert(row: NewHostCredentialRow): HostCredentialRow;
  getById(id: string): HostCredentialRow | null;
  lookupVerification(tokenHash: string): CredentialWithHostStatus | null;
  /**
   * SEMANTIC read-model, stated honestly: the full "active long-lived
   * credential" business predicate — kind = long_lived, not consumed, not
   * revoked, not expired at `now`, host not revoked and bound to a user — is
   * encoded in this query (single consistent read). Behavior tests pin every
   * condition; the domain does NOT re-derive this verdict.
   */
  hasActiveLongLivedCredential(hostId: string, now: number): boolean;
  revokeById(credentialId: string, revokedAt: number): boolean;
  revokeAllForHost(hostId: string, revokedAt: number): number;
  /** Rotation sweep: revoke every other active long-lived credential,
   *  stamping `revoked_at = revokedAt` and back-filling `consumed_at`. The
   *  optional `onlyExpiringAfter` keeps the grace-window variant's exclusion
   *  of already-expired rows. */
  revokeOtherLongLivedForHost(input: {
    hostId: string;
    keepCredentialId: string;
    revokedAt: number;
    consumedAt: number;
    onlyUnexpiredAt?: number;
  }): number;
}

/** Read-only eligibility face (transaction-free preflights and verdicts). */
export interface HostAuthStateReadPort {
  /** NON-LOCKING read of exists/bound/revoked facts; safe only outside a
   *  transaction (preflight verdicts, read-model checks). The three-way
   *  verdict (missing/unbound/revoked) stays in the domain. Inside a
   *  UnitOfWork, use `getAuthStateForUpdate` so the read conflicts with a
   *  concurrent revoke until commit. */
  getAuthState(hostId: string): { userId: string | null; revokedAt: number | null } | null;
}

/** The minimal host-aggregate face the host-token use cases need — one
 *  method per use case, deliberately not a general host facade. */
export interface HostAuthStatePort extends HostAuthStateReadPort {
  /** Soft-delete the host row (idempotent guard is the caller's policy). */
  revoke(hostId: string, revokedAt: number): boolean;
  /** Allocate a named user-invite host row (create-host-invite use case:
   *  the row and its first credential must commit atomically).
   *
   *  RESIDUAL (#task:1979-era face, named not defended): this returns the
   *  physical `HostRow`, so the create-invite use case still holds one. It
   *  predates the R4 projection rule and is left as-is here rather than
   *  reshaped mid-cut — but it is NOT a licence: every write face ADDED since
   *  (see {@link HostSetupPort}) returns a runtime-built projection, and this
   *  one is the reason `HostRow` still appears in this module at all. */
  createUserInvite(input: { userId: string }): HostRow;
  /**
   * LOCKING in-transaction eligibility read. Contract: the read MUST conflict
   * with a concurrent host revoke until this transaction commits — an
   * `atomically` scope guarantees atomicity only, not isolation, so a plain
   * "read eligibility then insert" is TOCTOU under any engine with concurrent
   * writers (e.g. PostgreSQL READ COMMITTED: another tx can revoke the host
   * after this read and commit, then the credential insert still succeeds).
   * The named mechanism is on {@link HostUnitOfWork.atomically}: the scope's
   * `BEGIN IMMEDIATE` holds the write lock BEFORE this read runs, so no other
   * writer's commit can be ordered between the read and the insert. "One
   * synchronous connection" is NOT the mechanism — it says nothing about a
   * second process on the same file. A pooled adapter MUST back this with
   * `SELECT ... FOR UPDATE` (or SERIALIZABLE / an equivalent conflicting
   * read) — never a plain SELECT.
   */
  getAuthStateForUpdate(hostId: string): { userId: string | null; revokedAt: number | null } | null;
}

/**
 * The authoritative facts a rename/finalize decision is made from, projected
 * field by field (R4). Deliberately NOT a `HostRow`: install identity, labels,
 * last-seen telemetry and credential state are not inputs to this decision, so
 * the decision cannot start depending on them.
 */
export interface HostSetupState {
  /** `null` never occurs for a claimed host; the decision treats a non-owner
   *  and a missing row identically (no host-id enumeration). */
  ownerUserId: string | null;
  revokedAt: number | null;
  provisioningSource: HostProvisioningSource;
  kind: HostKind;
  /** First successful daemon attach. Finalizing before this is the
   *  `host_pending_attach` conflict. */
  activatedAt: number | null;
  /** Set once, by finalize. */
  finalizedAt: number | null;
}

/**
 * The setup-lifecycle face: name the computer, and finalize a user-invite host
 * after its first attach. One method per step, deliberately not a host facade.
 */
export interface HostSetupPort {
  /**
   * LOCKING in-transaction read of the facts above. Contract: the values MUST
   * NOT drift before this transaction commits — the decision made from them
   * (finalize or not) is written in the same scope, so a plain "read state then
   * write" is TOCTOU under any engine with concurrent writers (PostgreSQL READ
   * COMMITTED: another transaction can revoke the host, or finalize it, after
   * this read and commit first).
   *
   * The mechanism is the scope's, not this method's: {@link
   * HostUnitOfWork.atomically} opens `BEGIN IMMEDIATE`, so the write lock is
   * already held when this read runs. Note what the older "a root transaction
   * takes the write lock at its FIRST WRITE" wording could not carry: here the
   * authoritative read PRECEDES every write in the scope, so deferred-BEGIN
   * lock acquisition would land after the fact it is supposed to protect. A
   * pooled/PG adapter MUST back this with `SELECT ... FOR UPDATE` on the host
   * row (or run the transaction at SERIALIZABLE / a provably equivalent
   * conflicting read) — never a plain SELECT.
   */
  getSetupStateForUpdate(hostId: string): HostSetupState | null;
  /** Write the operator-visible label. `null` (or blank) clears it back to the
   *  default. Returns the updated host as a wire projection built at runtime —
   *  never the physical row (R4): the persistence adapter owns the row → DTO
   *  mapping, so a new `hosts` column cannot reach the use case, and the use
   *  case needs no row→DTO callback to answer its caller. `null` when the id
   *  does not exist — which, after an authoritative in-scope read, is an
   *  invariant breach and the caller's business is to fail loudly, not to
   *  branch. */
  updateDisplayLabel(hostId: string, label: string | null): HostDto | null;
  /** Stamp `finalized_at` (first write wins). Same projection contract as
   *  `updateDisplayLabel`. */
  markFinalized(hostId: string, finalizedAt: number): HostDto | null;
}

export interface HostTxScope {
  credentials: HostCredentialsPort;
  hosts: HostAuthStatePort;
  setup: HostSetupPort;
}

export interface HostUnitOfWork {
  /**
   * Atomic write across the scope's ports AND the domain's serialization
   * point. Both flows in this domain are read-then-write over the SAME host
   * row — credential issue reads eligibility then inserts, setup reads the
   * finalize facts then writes them — and in both the authoritative read comes
   * FIRST, so atomicity alone cannot carry them.
   *
   * SQLite adapter: root-only `BEGIN IMMEDIATE`. The write lock is taken at
   * BEGIN, before the callback's first statement, which is what makes the
   * scope's `...ForUpdate` reads locking reads; nested use is refused loudly
   * because `.immediate()` inside an open transaction silently degrades to a
   * savepoint that takes no lock. A pooled/PG adapter owes the equivalent per
   * scope method (`SELECT ... FOR UPDATE` on the host row, or SERIALIZABLE).
   */
  atomically<T>(fn: (tx: HostTxScope) => T): T;
}

/** The verify face the WS transport consumes; injected from the composition
 *  root so transport modules never touch concrete persistence. */
export interface HostTokenVerifier {
  verifyHostToken(token: string, opts?: { now?: number }): VerifyHostTokenResult;
}

export type VerifyHostTokenFailureCode =
  | 'missing'
  | 'credential_not_usable'
  | 'credential_revoked'
  | 'credential_expired'
  | 'host_revoked'
  | 'host_unbound';

export type VerifyHostTokenResult =
  | {
      ok: true;
      hostId: string;
      userId: string;
      credentialId: string;
    }
  | {
      ok: false;
      code: VerifyHostTokenFailureCode;
    };
