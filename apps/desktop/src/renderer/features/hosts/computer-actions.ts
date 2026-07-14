import type { HostDto } from '@silverhand/shared';

/**
 * The four mutually-exclusive lifecycle/credential verbs the Computer
 * Detail page exposes. Named to match the contract in
 * `docs/user-managed-computer-v1.md` §6 (interaction actions; the
 * Revoke/Delete boundary is §5) — they are NOT synonyms:
 *
 *   - `connection` — user-managed only: the connection-management
 *     surface, holding two ORTHOGONAL actions (NOT one
 *     credential-preserving op):
 *       - rotate — mints a fresh reveal-once command, invalidates the
 *         old token, and force-drops its live WS (a credential swap);
 *       - disconnect — force-drops the live WS only, leaving the token
 *         intact so the same command reconnects (credential-preserving).
 *   - `delete`     — user-managed only: terminal removal with
 *     dependency check + optional agent cascade.
 *   - `refresh`    — app-managed, current-machine only: rotate the
 *     backend-issued host token, which updates local daemon config in
 *     place (the token never enters the renderer).
 *   - `revoke`     — app-managed only: soft revoke (writes `revoked_at`,
 *     invalidates cred, keeps agents/workspaces). Independent of Delete.
 *
 * `provisioning_source` is legitimately used here for flow selection
 * (§1.1: UI copy, connect/recovery flow, revoke/rotate messaging) —
 * NOT for capability derivation. Ownership + lifecycle are the
 * capability inputs; `provisioning_source` picks which flow the
 * capability takes.
 */
export type ComputerAction = 'connection' | 'delete' | 'refresh' | 'revoke';

export interface ComputerActionsInput {
  host: HostDto;
  /** The viewer's user id, or `null` while unauthenticated. */
  viewerId: string | null;
  /** The host id this desktop's own daemon runs as, or `null` when
   *  the current session has no attached local computer (unclaimed /
   *  revoked / remote-only view). */
  currentLocalHostId: string | null;
}

export interface ComputerActionsResult {
  readonly connection: boolean;
  readonly delete: boolean;
  readonly refresh: boolean;
  readonly revoke: boolean;
}

const NONE: ComputerActionsResult = Object.freeze({
  connection: false,
  delete: false,
  refresh: false,
  revoke: false,
});

/**
 * Decide which mutation actions the Computer Detail page renders for
 * a given host. Pure — testable without React.
 *
 * Invariants (locked by the four-matrix test):
 *   - A viewer who does not own the host gets no mutations.
 *   - A revoked host is terminal; no credential/lifecycle mutation
 *     surfaces (Delete included — a revoked user-managed row does not
 *     re-open the delete path here).
 *   - `connection` and `delete` are user-managed (`user_invite`) only.
 *   - `refresh` and `revoke` are app-managed (`app_install`) only.
 *   - `refresh` also requires the host to be THIS desktop's own local
 *     computer, because it updates local daemon config; rotating
 *     another machine's app-managed token from here would silently
 *     miss the daemon that actually reads it.
 *   - The user-managed and app-managed action sets are mutually
 *     exclusive per host — no host ever renders both a Connection
 *     panel and a Refresh panel.
 *   - `provisioning_source` is matched by EXACT discriminator. Any
 *     value that is neither `user_invite` nor `app_install` (today:
 *     `system`, and any future source) fails closed to NONE. Falling
 *     back "anything not user_invite → app-managed" would categorize
 *     backend-placeholder rows like `ensureStandaloneServer` as
 *     app-managed and expose them to Refresh/Revoke actions that have
 *     no meaning for that origin.
 */
export function computerActions(
  input: ComputerActionsInput,
): ComputerActionsResult {
  const { host, viewerId, currentLocalHostId } = input;

  const owns = viewerId !== null && host.creator_user_id === viewerId;
  if (!owns) return NONE;

  const revoked = host.status === 'revoked' || host.revoked_at !== null;
  if (revoked) return NONE;

  // Exact discriminators — no fall-through. `system` (backend placeholders
  // like `ensureStandaloneServer`) is neither app-managed nor user-managed
  // and MUST NOT accrete either action set: it has no daemon config to
  // rotate (no `refresh`), no revoke-preserves-agents semantics (no
  // `revoke`), no reveal-once connect command (no `connection`), and
  // no dependency-checked terminal delete flow (no `delete`).
  if (host.provisioning_source === 'user_invite') {
    return { connection: true, delete: true, refresh: false, revoke: false };
  }
  if (host.provisioning_source === 'app_install') {
    const isCurrent =
      currentLocalHostId !== null && host.id === currentLocalHostId;
    return {
      connection: false,
      delete: false,
      refresh: isCurrent,
      revoke: true,
    };
  }
  return NONE;
}
