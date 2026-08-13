import { createHash, randomBytes } from 'node:crypto';
import type { HostCredentialKind, HostCredentialRow } from '@silverhand/shared';
import type {
  CredentialWithHostStatus,
  HostAuthStatePort,
  HostAuthStateReadPort,
  HostCredentialsPort,
  HostTxScope,
  HostUnitOfWork,
  HostTokenVerifier,
  VerifyHostTokenResult,
} from './host-ports.js';

export type {
  VerifyHostTokenFailureCode,
  VerifyHostTokenResult,
} from './host-ports.js';

export const HOST_TOKEN_ROTATION_GRACE_MS = 60_000;

export interface IssuedHostToken {
  hostToken: string;
  credential: HostCredentialRow;
}

export interface PreparedHostTokenRotation {
  hostId: string;
  hostToken: string;
  issuedAt: number;
  graceUntil: number;
}

export type HostCredentialIssueFailureCode =
  | 'host_missing'
  | 'host_unbound'
  | 'host_revoked';

export class HostCredentialIssueError extends Error {
  constructor(
    readonly code: HostCredentialIssueFailureCode,
    readonly hostId: string,
  ) {
    super(`cannot issue host credential for ${hostId}: ${code}`);
    this.name = 'HostCredentialIssueError';
  }
}

/** Host credential domain logic (token generation, lifecycle verdicts,
 *  rotation semantics); persistence goes through the driver-free host-token
 *  ports, atomic writes through the domain UnitOfWork. */
export class HostTokenService implements HostTokenVerifier {
  private readonly credentials: HostCredentialsPort;
  private readonly hosts: HostAuthStateReadPort;
  private readonly uow: HostUnitOfWork;

  /** Reads and single-statement writes go straight through the ports; the
   *  UnitOfWork is reserved for the REAL atomic operations (issuance's
   *  eligibility+insert, the two rotations) — it is an atomic boundary, not
   *  a repository locator. */
  constructor(opts: {
    credentials: HostCredentialsPort;
    hosts: HostAuthStateReadPort;
    uow: HostUnitOfWork;
  }) {
    this.credentials = opts.credentials;
    this.hosts = opts.hosts;
    this.uow = opts.uow;
  }

  issueHostToken(input: {
    hostId: string;
    kind?: HostCredentialKind;
    expiresAt?: number | null;
    consumedAt?: number | null;
  }): IssuedHostToken {
    const kind = input.kind ?? 'long_lived';
    // The eligibility read and the insert share ONE transaction; the read is
    // the LOCKING `getAuthStateForUpdate` so a concurrent revoke cannot
    // commit between the read and the insert (atomicity alone is not
    // isolation — see the port contract).
    return this.uow.atomically(tx =>
      issueHostTokenWithin(tx, {
        hostId: input.hostId,
        kind,
        expiresAt: input.expiresAt ?? null,
        consumedAt: input.consumedAt ?? null,
      }),
    );
  }

  prepareHostTokenRotation(input: {
    hostId: string;
    now?: number;
    graceMs?: number;
  }): PreparedHostTokenRotation {
    const issuedAt = input.now ?? Date.now();
    const graceUntil = issuedAt + (input.graceMs ?? HOST_TOKEN_ROTATION_GRACE_MS);
    // Write-free, NON-LOCKING preflight: the authoritative eligibility check
    // (locking read) re-runs inside completePreparedHostTokenRotation's
    // transaction.
    assertHostCanReceiveCredential(this.hosts, input.hostId);
    return {
      hostId: input.hostId,
      hostToken: randomBytes(32).toString('base64url'),
      issuedAt,
      graceUntil,
    };
  }

  completePreparedHostTokenRotation(
    input: PreparedHostTokenRotation,
  ): IssuedHostToken {
    if (input.graceUntil <= input.issuedAt) {
      throw new Error('HostTokenService.completePreparedHostTokenRotation: invalid grace window');
    }
    return this.uow.atomically(tx => {
      const issued = insertHostToken(tx, {
        hostId: input.hostId,
        hostToken: input.hostToken,
        kind: 'long_lived',
        expiresAt: null,
        consumedAt: null,
      });
      tx.credentials.revokeOtherLongLivedForHost({
        hostId: input.hostId,
        keepCredentialId: issued.credential.id,
        revokedAt: input.graceUntil,
        consumedAt: input.issuedAt,
        onlyUnexpiredAt: input.issuedAt,
      });
      return issued;
    });
  }

  rotateHostToken(input: {
    hostId: string;
    now?: number;
    graceMs?: number;
  }): IssuedHostToken {
    return this.completePreparedHostTokenRotation(
      this.prepareHostTokenRotation(input),
    );
  }

  /** "Immediate" is the BUSINESS semantic — no grace window, every other
   *  long-lived credential is revoked at once — not a storage lock mode. */
  rotateHostTokenImmediate(input: {
    hostId: string;
    now?: number;
  }): IssuedHostToken {
    const now = input.now ?? Date.now();
    return this.uow.atomically(tx => {
      const issued = issueHostTokenWithin(tx, { hostId: input.hostId });
      tx.credentials.revokeOtherLongLivedForHost({
        hostId: input.hostId,
        keepCredentialId: issued.credential.id,
        revokedAt: now,
        consumedAt: now,
      });
      return issued;
    });
  }

  revokeCredential(credentialId: string, revokedAt = Date.now()): boolean {
    return this.credentials.revokeById(credentialId, revokedAt);
  }

  /** Bulk-revoke every active credential for a host (Stage B.4 host
   *  revoke). No grace — once a host is being soft-deleted there is
   *  no operational reason to leave any active token behind. Returns
   *  the number of rows updated; idempotent (a re-run on an
   *  already-swept host is a no-op). */
  revokeAllCredentialsForHost(
    hostId: string,
    revokedAt: number = Date.now(),
  ): number {
    return this.credentials.revokeAllForHost(hostId, revokedAt);
  }

  verifyHostToken(token: string, opts: { now?: number } = {}): VerifyHostTokenResult {
    const normalized = token.trim();
    if (!normalized) return { ok: false, code: 'missing' };

    const row = this.credentials.lookupVerification(hashHostToken(normalized));
    if (!row) return { ok: false, code: 'missing' };
    return this.credentialVerdict(row, opts.now ?? Date.now());
  }

  hasActiveLongLivedCredential(
    hostId: string,
    opts: { now?: number } = {},
  ): boolean {
    const now = opts.now ?? Date.now();
    return this.credentials.hasActiveLongLivedCredential(hostId, now);
  }

  private credentialVerdict(
    row: CredentialWithHostStatus,
    now: number,
  ): VerifyHostTokenResult {
    if (row.kind !== 'long_lived') {
      return { ok: false, code: 'credential_not_usable' };
    }
    if (row.revoked_at !== null) {
      if (row.consumed_at !== null) {
        if (row.revoked_at <= now) {
          return { ok: false, code: 'credential_expired' };
        }
      } else {
        return { ok: false, code: 'credential_revoked' };
      }
    } else if (row.consumed_at !== null) {
      return { ok: false, code: 'credential_not_usable' };
    }
    if (row.expires_at !== null && row.expires_at <= now) {
      return { ok: false, code: 'credential_expired' };
    }
    if (row.host_revoked_at !== null) return { ok: false, code: 'host_revoked' };
    if (!row.host_user_id) return { ok: false, code: 'host_unbound' };

    return {
      ok: true,
      hostId: row.host_id,
      userId: row.host_user_id,
      credentialId: row.id,
    };
  }

}

function hostEligibilityVerdict(
  state: { userId: string | null; revokedAt: number | null } | null,
  hostId: string,
): void {
  if (!state) {
    throw new HostCredentialIssueError('host_missing', hostId);
  }
  if (!state.userId) {
    throw new HostCredentialIssueError('host_unbound', hostId);
  }
  if (state.revokedAt !== null) {
    throw new HostCredentialIssueError('host_revoked', hostId);
  }
}

/** Non-locking preflight eligibility (outside any transaction). */
function assertHostCanReceiveCredential(
  hosts: HostAuthStateReadPort,
  hostId: string,
): void {
  hostEligibilityVerdict(hosts.getAuthState(hostId), hostId);
}

/** Locking in-transaction eligibility: `getAuthStateForUpdate` must conflict
 *  with a concurrent revoke until commit (see the port contract). */
function assertHostCanReceiveCredentialForUpdate(
  hosts: HostAuthStatePort,
  hostId: string,
): void {
  hostEligibilityVerdict(hosts.getAuthStateForUpdate(hostId), hostId);
}

/**
 * Domain issuance: generates the random token and default lifecycle fields,
 * then inserts INSIDE an already-open transaction scope (eligibility is the
 * locking read `getAuthStateForUpdate`). Single authority for "issue a new
 * host credential" — used by `HostTokenService.issueHostToken`,
 * `rotateHostTokenImmediate` and the create-host-invite use case, so token
 * format and default lifecycle policy never drift across callers. Never call
 * it outside a UnitOfWork scope.
 */
export function issueHostTokenWithin(
  tx: HostTxScope,
  input: {
    hostId: string;
    kind?: HostCredentialKind;
    expiresAt?: number | null;
    consumedAt?: number | null;
  },
): IssuedHostToken {
  return insertHostToken(tx, {
    hostId: input.hostId,
    hostToken: randomBytes(32).toString('base64url'),
    kind: input.kind ?? 'long_lived',
    expiresAt: input.expiresAt ?? null,
    consumedAt: input.consumedAt ?? null,
  });
}

/** Lower-level insert with an EXACT pre-generated token — only for prepared
 *  rotation, whose token was minted by `prepareHostTokenRotation` and must be
 *  kept byte-for-byte. */
function insertHostToken(
  tx: HostTxScope,
  input: {
    hostId: string;
    hostToken: string;
    kind: HostCredentialKind;
    expiresAt: number | null;
    consumedAt: number | null;
  },
): IssuedHostToken {
  assertHostCanReceiveCredentialForUpdate(tx.hosts, input.hostId);
  const credential = tx.credentials.insert({
    id: randomBytes(12).toString('base64url'),
    hostId: input.hostId,
    tokenHash: hashHostToken(input.hostToken),
    kind: input.kind,
    expiresAt: input.expiresAt,
    consumedAt: input.consumedAt,
  });
  return { hostToken: input.hostToken, credential };
}

export function hashHostToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
