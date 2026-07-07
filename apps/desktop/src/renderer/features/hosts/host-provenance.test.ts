import { describe, expect, it } from 'vitest';
import type { HostDto } from '@silverhand/shared';
import { canUseLocalHostPath } from './host-provenance';

function host(partial: Partial<HostDto> & Pick<HostDto, 'id'>): HostDto {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    kind: partial.kind ?? 'local',
    created_at: partial.created_at ?? 1,
    revoked_at: partial.revoked_at ?? null,
    last_seen_at: partial.last_seen_at ?? 2,
    activated_at: partial.activated_at ?? 1,
    finalized_at: partial.finalized_at ?? 1,
    connected_host_name: partial.connected_host_name ?? null,
    provisioning_source: partial.provisioning_source ?? 'app_install',
    status:
      partial.status ??
      ((partial.revoked_at ?? null) !== null
        ? 'revoked'
        : partial.activated_at === null
          ? 'pending'
          : partial.finalized_at === null
            ? 'attached'
            : 'active'),
    placeable:
      partial.placeable ??
      ((partial.revoked_at ?? null) === null &&
        (partial.activated_at ?? 1) !== null &&
        (partial.finalized_at ?? 1) !== null),
    creator_user_id: partial.creator_user_id ?? 'viewer',
    display_label: partial.display_label ?? null,
  };
}

describe('host provenance gate', () => {
  it('allows local-host-only UX only for the current active local host', () => {
    const hosts = [
      host({ id: 'host-local' }),
      host({ id: 'host-other-local' }),
      host({ id: 'host-remote', kind: 'remote' }),
      host({ id: 'host-revoked', revoked_at: 123 }),
    ];

    expect(
      canUseLocalHostPath({
        hosts,
        localHostId: 'host-local',
        resourceHostId: 'host-local',
      }),
    ).toBe(true);
    expect(
      canUseLocalHostPath({
        hosts,
        localHostId: 'host-local',
        resourceHostId: 'host-other-local',
      }),
    ).toBe(false);
    expect(
      canUseLocalHostPath({
        hosts,
        localHostId: 'host-remote',
        resourceHostId: 'host-remote',
      }),
    ).toBe(false);
    expect(
      canUseLocalHostPath({
        hosts,
        localHostId: 'host-revoked',
        resourceHostId: 'host-revoked',
      }),
    ).toBe(false);
    expect(
      canUseLocalHostPath({
        hosts,
        localHostId: null,
        resourceHostId: 'host-local',
      }),
    ).toBe(false);
  });
});
