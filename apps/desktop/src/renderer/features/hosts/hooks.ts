import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  HostDtoSchema,
  HostListResponseSchema,
  HostStatusResponseSchema,
  UpdateHostInputSchema,
  apiPaths,
  type HostDto,
  type HostListResponse,
  type HostStatusResponse,
  type UpdateHostInput,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import { canUseLocalHostPath } from './host-provenance';

export const hostsKey = ['hosts'] as const;
export const backendInfoKey = ['backend-info'] as const;
/** Per-host dynamic-status query key. Each host gets its own cache entry
 *  so the manual-refresh button on `HostDetailView` only revalidates that
 *  one host's snapshot (registration view + daemon-derived facts), never
 *  the whole host list. */
export const hostStatusKey = (hostId: string) =>
  ['host-status', hostId] as const;

export interface BackendInfoSnapshot {
  /** D3.c Commit 4 — embedded backend's listen URL (where the
   *  renderer's HTTP API calls go). Used as fallback display when
   *  `local_host_server_url` is null (pre-claim). NOT the value
   *  the Settings "Server" pane saves — that's `local_host_server_url`. */
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
  /**
   * D3.c Commit 4 — `server_url` currently in `daemon-config.json`,
   * i.e. the address the daemon dials to reach the backend. This
   * is what the Settings "Server" pane edits and the post-save
   * invalidation refetches. `null` when no daemon-config exists yet
   * (pre-claim). Distinct from `url` above (the embedded backend
   * listener) — see `preload/api.d.ts` `BackendInfo` for the full
   * rationale.
   */
  local_host_server_url: string | null;
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
      local_host_server_url: null,
    };
  }
  return {
    url: info.url,
    local_host_id: info.local_host_id,
    local_host_status: info.local_host_status,
    local_host_ws_attached_at: info.local_host_ws_attached_at,
    local_host_server_url: info.local_host_server_url,
  };
}

export function useBackendInfoSnapshot(options?: {
  /**
   * D3.d follow-up (Cindy `#task:636` review P1) — opt-in narrow
   * polling so the connection pill flips Connecting → Connected
   * without a user-triggered refetch.
   *
   * The base `useQuery` has no polling / no subscription; before this
   * opt-in, a renderer that mounted in `claimed && attached_at===null`
   * never saw `attached_at` flip to a number unless some other
   * mutation invalidated `backendInfoKey`. That left the pill stuck
   * on "Connecting…" indefinitely.
   *
   * When opted in we poll ONLY while the snapshot is actually in the
   * connecting window (`claimed + attached_at===null`); the moment
   * attached_at lands or the status moves to a terminal arm
   * (revoked / error / failed) we stop polling. Callers that don't
   * render the connection pill should NOT opt in — there's no other
   * field on `BackendInfoSnapshot` that flips out-of-band.
   */
  pollWhileConnecting?: boolean;
}) {
  return useQuery({
    queryKey: backendInfoKey,
    queryFn: fetchBackendInfo,
    refetchInterval: options?.pollWhileConnecting
      ? query => connectingRefetchIntervalMs(query.state.data ?? null)
      : false,
  });
}

/**
 * Pure helper that decides whether the next `refetchInterval` tick
 * fires — extracted so a unit test pins the "stop polling on
 * terminal / attached" matrix without spinning up React Query.
 *
 * Returns:
 *   - `false` (no refetch) for terminal / attached / pre-claim states
 *   - `CONNECTING_POLL_MS` (number) for the transitional connecting
 *     window so the pill flips Connecting → Connected within ~1
 *     poll cycle after the daemon's outbound WS lands.
 *
 * Chosen interval (1500ms) is a balance: short enough that the user
 * doesn't sit on "Connecting…" for visibly long after the daemon
 * actually attaches; long enough that we don't hammer the embedded
 * backend on a slow / never-attaches branch. The attach watchdog's
 * own budget is 10s (`outbound-attach.ts`), so worst-case 6-7 polls
 * over the entire connecting window — cheap.
 */
export const CONNECTING_POLL_MS = 1500;

export function connectingRefetchIntervalMs(
  data: BackendInfoSnapshot | null,
): number | false {
  if (!data) return false;
  // Only poll while we're explicitly waiting for the outbound WS
  // to land. Any other state — including `claimed + attached_at`
  // (already connected), `revoked` / `error` / `failed` (terminal),
  // and `unclaimed` (pre-claim, nothing to attach) — stops the
  // poll loop.
  if (data.local_host_status !== 'claimed') return false;
  if (data.local_host_ws_attached_at !== null) return false;
  return CONNECTING_POLL_MS;
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

/**
 * `#task:808` slice 4 — fetch the per-host dynamic snapshot powering
 * `HostDetailView`. Returns the discriminated `HostStatusResponse`; the
 * detail view branches on `data.availability` for the snapshot card and
 * always renders `data.agents[]` (registration is a DB fact, survives
 * daemon disconnect — see Cindy `Mtf5zZL-Y7PauIDi`).
 *
 * **Manual refresh only** (shiki: "agents 列表我觉得手动 refresh 就够了"):
 *   - `staleTime: Infinity` — never auto-refetches on focus / interval /
 *     remount; the cache entry is fresh as long as it's in memory.
 *   - `refetchOnWindowFocus: false` / `refetchInterval: false` — explicit
 *     belts on the same constraint.
 *   - The detail view exposes a Refresh button that calls
 *     `qc.invalidateQueries({ queryKey: hostStatusKey(hostId) })` to
 *     trigger a single one-off refetch.
 *
 * The hook is `enabled` only when `hostId` is provided so the master/
 * detail right pane mounting with no selection doesn't burn a request.
 */
export function useHostStatusQuery(
  hostId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<HostStatusResponse>({
    queryKey: hostStatusKey(hostId ?? '__none__'),
    queryFn: async () => {
      const raw = await api<unknown>(apiPaths.hostStatus(hostId!));
      return HostStatusResponseSchema.parse(raw);
    },
    enabled: (options?.enabled ?? true) && Boolean(hostId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
}

export interface UpdateHostMutationVars {
  display_label: string | null;
}

/**
 * `#task:808` slice 4 — rename a host (only `display_label` is mutable;
 * `name` stays the stable identifier set at claim time). On success we
 * invalidate `hostsKey` so the sidebar list re-renders the new label.
 *
 * Schema-guard the input client-side so a typo in the InlineRename
 * component fails fast in dev instead of surfacing as a 400 in the UI
 * (the server still enforces the same 256-char cap; this just keeps the
 * boundary loud-and-early). Server-side, the repo trims+slices to 64 and
 * maps empty → null, so a clear-on-blank flow works without a separate
 * "Clear" mutation: send `{ display_label: null }` to clear.
 */
export function useUpdateHostMutation(hostId: string) {
  const qc = useQueryClient();
  return useMutation<HostDto, Error, UpdateHostMutationVars>({
    mutationFn: async (vars: UpdateHostMutationVars): Promise<HostDto> => {
      const body: UpdateHostInput = UpdateHostInputSchema.parse(vars);
      const raw = await api<unknown>(apiPaths.host(hostId), {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const parsed = z.object({ host: HostDtoSchema }).parse(raw);
      return parsed.host;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKey });
    },
  });
}
