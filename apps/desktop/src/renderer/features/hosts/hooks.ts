import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  HostListResponseSchema,
  type HostDto,
  type HostListResponse,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { canUseLocalHostPath } from './host-provenance';

export const hostsKey = ['hosts'] as const;
export const backendInfoKey = ['backend-info'] as const;

export interface BackendInfoSnapshot {
  /** D3.c Commit 4 — server URL the renderer-side Settings form seeds
   *  from. Sourced from `BackendInfo.url`. */
  url: string;
  local_host_id: string | null;
  local_host_status: 'unclaimed' | 'claimed' | 'revoked' | 'error' | 'failed';
  /**
   * D3.a Commit 4 — diagnostic timestamp from the backend's
   * `HostWsServerController.getAttachment` for `local_host_id`.
   * `null` when no live attachment. Renderer may show a "connected
   * since" string but must NOT derive a new status word.
   */
  local_host_ws_attached_at: number | null;
}

async function fetchHosts(): Promise<HostListResponse> {
  const raw = await api<unknown>('/api/hosts');
  return HostListResponseSchema.parse(raw);
}

async function fetchBackendInfo(): Promise<BackendInfoSnapshot> {
  const info = await window.agentHub.getBackendInfo();
  if (!info) {
    return {
      url: '',
      local_host_id: null,
      local_host_status: 'error',
      local_host_ws_attached_at: null,
    };
  }
  return {
    url: info.url,
    local_host_id: info.local_host_id,
    local_host_status: info.local_host_status,
    local_host_ws_attached_at: info.local_host_ws_attached_at,
  };
}

export function useBackendInfoSnapshot() {
  return useQuery({
    queryKey: backendInfoKey,
    queryFn: fetchBackendInfo,
  });
}

export function useHostsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hostsKey,
    queryFn: fetchHosts,
    enabled: options?.enabled ?? true,
  });
}

export function useHostProvenanceGate(): {
  localHostId: string | null;
  localHostStatus: BackendInfoSnapshot['local_host_status'];
  currentLocalHost: HostDto | null;
  canUseCurrentLocalHostPath: boolean;
  canUseLocalHostPathFor: (hostId: string | null | undefined) => boolean;
  isLoading: boolean;
} {
  const backendInfoQuery = useBackendInfoSnapshot();
  const localHostId = backendInfoQuery.data?.local_host_id ?? null;
  const hostsQuery = useHostsQuery({ enabled: localHostId !== null });
  const hosts = useMemo(
    () => hostsQuery.data?.hosts ?? [],
    [hostsQuery.data],
  );
  const currentLocalHost = useMemo(
    () => hosts.find(host => host.id === localHostId) ?? null,
    [hosts, localHostId],
  );
  const canUseLocalHostPathFor = useCallback(
    (hostId: string | null | undefined) =>
      canUseLocalHostPath({
        hosts,
        localHostId,
        resourceHostId: hostId,
      }),
    [hosts, localHostId],
  );

  return {
    localHostId,
    localHostStatus: backendInfoQuery.data?.local_host_status ?? 'unclaimed',
    currentLocalHost,
    canUseCurrentLocalHostPath: canUseLocalHostPathFor(localHostId),
    canUseLocalHostPathFor,
    isLoading: backendInfoQuery.isLoading || hostsQuery.isLoading,
  };
}
