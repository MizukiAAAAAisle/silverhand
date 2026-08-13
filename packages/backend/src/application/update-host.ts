import type { HostDto } from '@silverhand/shared';
import type { HostUnitOfWork } from '../auth/host-ports.js';

/**
 * UpdateHost use case (#task:1982 W5) — `PATCH /api/hosts/:id`: name a
 * computer, and finalize a user-invite setup on the naming that follows its
 * first daemon attach.
 *
 * ## Why this stopped being a route body
 *
 * The route used to read the host row, decide from that snapshot whether this
 * PATCH is "just a rename" or "the finalize step", and only THEN open a
 * `ctx.db.transaction` to write. Every fact the decision rests on —
 * `provisioning_source`, `kind`, `finalized_at`, `activated_at`, ownership,
 * revocation — was read OUTSIDE the transaction that acts on it, which is
 * TOCTOU on any engine with concurrent writers: a concurrent revoke, a
 * concurrent finalize, or a daemon's first attach landing between the read and
 * the write all produce a decision that was true when taken and false when
 * written.
 *
 * Here, the whole decision is taken from `getSetupStateForUpdate` INSIDE
 * `atomically`, whose port contract is that those values do not drift before
 * the transaction commits (SQLite: the scope's root-only `BEGIN IMMEDIATE`
 * holds the write lock before that read runs; pooled/PG: a `SELECT ... FOR
 * UPDATE` on the host row). Nothing is read before the scope, so there is no
 * earlier snapshot left to trust.
 *
 * ## HTTP-agnostic (spec §1.1/§4)
 *
 * Returns a typed {@link UpdateHostResult}; the route maps kind → status. Two
 * pieces of ordering are DOMAIN policy, not presentation, and are therefore
 * decided here:
 *  - identity before input validity: reporting "your body is malformed" for a
 *    host the requester does not own would confirm the host exists, so an
 *    unparseable body still collapses to `notFound` for a non-owner. That is
 *    why the command carries a validity marker instead of the route answering
 *    400 on its own.
 *  - the two 200 arms stay distinct (`renamed` vs `finalized`) even though the
 *    route renders them identically: whether this call consumed the one-time
 *    finalize is the interesting fact for a caller and a test, and collapsing
 *    it would make "did we finalize?" unobservable without re-reading the DB.
 */

export type UpdateHostDeps = {
  /** Atomic boundary AND the authoritative read: the decision and its write
   *  live in one scope. The ONLY dependency — the setup port's write faces
   *  return the wire projection themselves (R4), so this use case needs
   *  neither a row type nor a row → DTO callback, and there is no shape in
   *  which a physical `hosts` row can reach it. */
  uow: HostUnitOfWork;
};

export type UpdateHostCommand = {
  hostId: string;
  /** Route passes the resolved `requireSessionBearerUser(c)` user id. */
  requesterUserId: string;
  /**
   * The route's parsed body. `valid: false` means schema validation failed —
   * the route holds the issues for the 400 body, but whether a 400 is even
   * allowed to be revealed is decided here (see the ordering note above).
   */
  input: { valid: true; displayLabel: string | null } | { valid: false };
};

/**
 * Named result — no HTTP status policy. `noFinalize` / `updateAndFinalize` are
 * the two write decisions; the four refusals are the reasons a write did not
 * happen. A write returning nothing is a defensive throw, not an arm.
 *
 * This is also the scope's own return type: the port hands back the projection
 * already, so there is no second "row-carrying" outcome type to unwrap after
 * the transaction.
 */
export type UpdateHostResult =
  | { kind: 'notFound' }
  | { kind: 'revoked' }
  | { kind: 'invalidInput' }
  | { kind: 'pendingAttach' }
  | { kind: 'labelRequired' }
  | { kind: 'renamed'; host: HostDto }
  | { kind: 'finalized'; host: HostDto };

export function updateHost(
  deps: UpdateHostDeps,
  cmd: UpdateHostCommand,
): UpdateHostResult {
  const now = Date.now();
  return deps.uow.atomically<UpdateHostResult>(tx => {
    const state = tx.setup.getSetupStateForUpdate(cmd.hostId);
    // Cross-user and missing collapse to the same answer — no host-id
    // enumeration, and it holds for a malformed body too (see the ordering
    // note): identity is settled before the request's shape is discussed.
    if (!state || state.ownerUserId !== cmd.requesterUserId) {
      return { kind: 'notFound' };
    }
    if (state.revokedAt !== null) {
      // A renamed-then-revoked workflow must not mutate audit history.
      return { kind: 'revoked' };
    }
    if (!cmd.input.valid) return { kind: 'invalidInput' };

    // The finalize question, answered from in-scope state only. A host that is
    // already finalized takes the plain-rename path — `finalized_at` is
    // set once.
    const finalizing =
      state.provisioningSource === 'user_invite' &&
      state.kind === 'remote' &&
      state.finalizedAt === null;
    if (finalizing) {
      if (state.activatedAt === null) return { kind: 'pendingAttach' };
      const label = cmd.input.displayLabel;
      // Finalizing IS the naming step, so a cleared label cannot be the
      // request that completes it. `normalizeDisplayLabel` would map
      // whitespace-only to null, which is why blank is refused here too.
      if (label === null || label.trim() === '') return { kind: 'labelRequired' };
    }

    const renamed = tx.setup.updateDisplayLabel(cmd.hostId, cmd.input.displayLabel);
    if (!renamed) {
      // Defensive: we hold an authoritative in-scope read of this row, so the
      // UPDATE + re-SELECT cannot miss it. Fail loudly (→ 500).
      throw new Error(`HostSetupPort.updateDisplayLabel returned null for ${cmd.hostId}`);
    }
    if (!finalizing) return { kind: 'renamed', host: renamed };

    const finalized = tx.setup.markFinalized(cmd.hostId, now);
    if (!finalized) {
      throw new Error(`HostSetupPort.markFinalized returned null for ${cmd.hostId}`);
    }
    return { kind: 'finalized', host: finalized };
  });
}
