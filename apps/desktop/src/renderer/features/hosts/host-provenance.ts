import type { HostDto } from '@silverhand/shared';

export interface LocalHostPathGateInput {
  hosts: ReadonlyArray<HostDto>;
  localHostId: string | null;
  resourceHostId: string | null | undefined;
}

export function canUseLocalHostPath({
  hosts,
  localHostId,
  resourceHostId,
}: LocalHostPathGateInput): boolean {
  if (!localHostId || !resourceHostId || resourceHostId !== localHostId) {
    return false;
  }
  const host = hosts.find(item => item.id === resourceHostId);
  return host?.kind === 'local' && host.revoked_at === null;
}
