import type { HostDto } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { HostUnitOfWork } from '../auth/host-ports.js';
import type { HostRepo } from '../repos/host-repo.js';

/**
 * RevokeHost use case.
 *
 * Owns the whole `POST /api/hosts/:id/revoke` orchestration that previously
 * lived in the route body: owner resolution (cross-user / missing collapse to
 * `notFound` to defeat host-id enumeration), the SINGLE transaction that
 * soft-deletes the host row (only when not already revoked, so a re-revoke does
 * not advance the tombstone) and ALWAYS sweeps the host's active credentials
 * (reconciling a half-failed prior run), a post-commit refetch, a post-commit
 * availability invalidation (agents on the host just went Offline), and the
 * post-commit best-effort daemon disconnect when the host is on the WS
 * transport. It does NOT cascade-delete agents /
 * workspaces / conversations — runtime placement is the boundary that fails
 * closed afterwards.
 *
 * HTTP-agnostic by construction (spec §1.1/§4): it returns a typed
 * {@link RevokeHostResult}; the route maps kind → HTTP status + body. It never
 * imports Hono `Context` and never builds a `Response`.
 *
 * The disconnect is a post-commit, best-effort effect (spec §2/§2.1): it runs
 * AFTER the commit so the credential is already revoked when the daemon's
 * reconnect reaches upgrade-auth, and a failure is logged + swallowed — it is
 * optimistic UX, never the authoritative revoke effect. It is deliberately NOT
 * part of `OutboundFrameAdapter`: revoke is credential/lifecycle control, while
 * the adapter is the command/data-plane port. Co-located app-managed embedded
 * hosts have no host-WS connection to close; user-managed revoke is rejected at
 * the route before reaching this use case.
 *
 * A post-commit refetch returning null is treated as a defensive invariant
 * breach — a soft-delete is an UPDATE, so the row is always present — and throws
 * (→ a generic 500). It is NOT a result arm (spec §2.1/§3.1).
 */

export type RevokeHostDeps = {
  ctx: BackendContext;
  /** Read side (owner resolution + post-commit refetch/DTO). */
  hosts: HostRepo;
  /** Atomic boundary: host soft-delete + credential sweep in ONE transaction. */
  uow: HostUnitOfWork;
};

export type RevokeHostCommand = {
  hostId: string;
  /** Route passes the resolved `requireSessionBearerUser(c)` user id. */
  requesterUserId: string;
};

/**
 * Named result — no HTTP status policy (spec §3.1). The route maps kind →
 * status/body with an exhaustive `switch` + `never` fallback. A post-commit
 * refetch returning null is a defensive throw, NOT a result arm.
 */
export type RevokeHostResult =
  | { kind: 'revoked'; host: HostDto }
  | { kind: 'notFound' };

export function revokeHost(
  deps: RevokeHostDeps,
  cmd: RevokeHostCommand,
): RevokeHostResult {
  const { ctx, hosts, uow } = deps;

  // Owner resolution. Cross-user / missing collapse to `notFound` so the route
  // returns 404 either way — no host-id enumeration (spec §2).
  const host = hosts.get(cmd.hostId);
  if (!host || host.user_id !== cmd.requesterUserId) {
    return { kind: 'notFound' };
  }

  const now = Date.now();
  // A revoke flips every agent on this host to Offline on the availability read
  // face (`host.revoked_at !== null` ⇒ offline). Capture whether THIS call is
  // the real state transition (null → tombstone) so the post-commit
  // invalidation fires exactly once, on the edge that changes the value — an
  // idempotent re-revoke changes nothing and must stay silent.
  const wasNewlyRevoked = host.revoked_at === null;
  // Single transaction: soft-delete the host row (only when not already
  // revoked, so a re-revoke does not advance the tombstone) and ALWAYS sweep
  // active credentials (covers idempotent re-revoke and reconciles a
  // half-failed prior run where the host row is revoked but credentials are
  // still active). Both writes commit together or not at all.
  uow.atomically(tx => {
    if (host.revoked_at === null) {
      tx.hosts.revoke(cmd.hostId, now);
    }
    tx.credentials.revokeAllForHost(cmd.hostId, now);
  });

  const updated = hosts.get(cmd.hostId);
  if (!updated) {
    // Defensive: a SELECT immediately after a committed soft-delete (an UPDATE)
    // must find the row. Surface as a loud throw (→ 500) if it ever happens.
    throw new Error(`HostRepo.get returned null for revoked host ${cmd.hostId}`);
  }

  // #task:2043 B — availability invalidation at the AUTHORITATIVE post-commit
  // edge, not inferred from socket teardown. A co-located embedded host has no
  // host-WS connection to close (the disconnect below is a no-op for it), yet
  // its agents just went Offline; driving the fan-out from the committed fact
  // transition is the only signal that reaches those viewers. Best-effort: a
  // publish failure must not fail the revoke.
  if (wasNewlyRevoked) {
    try {
      ctx.publishAgentAvailabilityChangedForHost?.(cmd.hostId);
    } catch (err) {
      ctx.logger.warn(
        { err, hostId: cmd.hostId, action: 'host_revoke_availability' },
        'host_revoke availability invalidation failed (non-blocking)',
      );
    }
  }

  // Post-commit best-effort daemon disconnect (spec §2.1): runs AFTER the commit so
  // the credential is already revoked when the daemon's reconnect arrives at
  // upgrade-auth. Only WS-attached hosts have a live connection to close; never
  // the authoritative revoke effect — log and swallow.
  const wsController = ctx.hostWsController?.();
  if (wsController) {
    try {
      wsController.disconnectHost(cmd.hostId);
    } catch (err) {
      ctx.logger.warn(
        { err, hostId: cmd.hostId, action: 'host_revoke_disconnect' },
        'host_revoke disconnect failed (non-blocking)',
      );
    }
  }

  return { kind: 'revoked', host: hosts.toDto(updated) };
}
