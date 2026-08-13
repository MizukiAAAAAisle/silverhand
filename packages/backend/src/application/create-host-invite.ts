import type { HostRow } from '@silverhand/shared';
import {
  issueHostTokenWithin,
  type IssuedHostToken,
} from '../auth/host-token.js';
import type { HostUnitOfWork } from '../auth/host-ports.js';

/**
 * CreateHostInvite use case: allocate a user-invite host row and issue its
 * first connect credential in ONE atomic boundary. The pair used to rely on
 * a raw route transaction wrapping a service that opened its own — correct
 * only through SQLite's implicit savepoint nesting; an explicit UoW scope is
 * the engine-independent contract (#task:1979).
 *
 * The application expresses only "issue the first credential for this host":
 * the random token and default lifecycle fields come from the domain issuance
 * operation (`issueHostTokenWithin`), so token format / default policy never
 * drift across callers. Depends on the ports alone — no concrete repo import,
 * no post-commit refetch.
 */
export type CreateHostInviteDeps = {
  uow: HostUnitOfWork;
};

export function createHostInvite(
  deps: CreateHostInviteDeps,
  cmd: { userId: string },
): { host: HostRow; issued: IssuedHostToken } {
  return deps.uow.atomically(tx => {
    const host = tx.hosts.createUserInvite({ userId: cmd.userId });
    const issued = issueHostTokenWithin(tx, { hostId: host.id });
    return { host, issued };
  });
}
