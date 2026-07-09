import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  HostCancelPendingResponseSchema,
  HostCreateResponseSchema,
  HostDeleteBlockedResponseSchema,
  HostDeletePendingAgentsResponseSchema,
  HostDeleteResponseSchema,
  HostDisconnectResponseSchema,
  HostDtoSchema,
  HostGetResponseSchema,
  HostListResponseSchema,
  HostProxyConfigOfflineResponseSchema,
  HostProxyConfigResponseSchema,
  HostProxyConfigSchema,
  HostRotateTokenUserManagedResponseSchema,
  HostStatusResponseSchema,
  HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE,
  RuntimeCatalogResponseSchema,
  UpdateHostInputSchema,
  apiPaths,
  type HostAvailability,
  type HostCancelPendingResponse,
  type HostCreateResponse,
  type HostDeleteDependentAgent,
  type HostDeleteDependents,
  type HostDeleteResponse,
  type HostDisconnectResponse,
  type HostDto,
  type HostListResponse,
  type HostProxyConfig,
  type HostStatusResponse,
  type RuntimeCatalogResponse,
  type UpdateHostInput,
} from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import { canUseLocalHostPath } from './host-provenance';

// Re-export the shared proxy DTO so feature consumers (HostDetailView) keep a
// single import surface off this hooks module without reaching past it — the
// *type* still originates from `@silverhand/shared` (single source), we just
// forward it.
export type { HostProxyConfig } from '@silverhand/shared';

export const hostsKey = ['hosts'] as const;
export const hostByIdKey = (hostId: string) => ['host', hostId] as const;
export const backendInfoKey = ['backend-info'] as const;
/** Per-host dynamic-status query key. Each host gets its own cache entry
 *  so the manual-refresh button on `HostDetailView` only revalidates that
 *  one host's snapshot (registration view + daemon-derived facts), never
 *  the whole host list. */
export const hostStatusKey = (hostId: string) =>
  ['host-status', hostId] as const;
export const hostProxyConfigKey = (hostId: string) =>
  ['host-proxy-config', hostId] as const;
/** Per-host runtime-detection catalog query key. Each computer's installed
 *  runtimes are host-local truth (the daemon resolves them on that machine),
 *  so the catalog is cached per host and never shared across computers. */
export const hostRuntimeCatalogKey = (hostId: string) =>
  ['host-runtime-catalog', hostId] as const;

export interface BackendInfoSnapshot {
  /** Deployment mode of the active backend handle. Remote Settings saves must
   * update the persisted profile + renderer backend handle, not only the
   * daemon's outbound config. */
  mode: 'embedded' | 'remote';
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
      mode: 'embedded',
      url: '',
      local_host_id: null,
      local_host_status: 'error',
      local_host_ws_attached_at: null,
      local_host_server_url: null,
    };
  }
  return {
    mode: info.mode,
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

export function useHostsQuery(options?: {
  enabled?: boolean;
  /** Poll the owner-scoped host list on an interval. Used by the Add-
   *  computer flow to watch a freshly-created row flip `status`
   *  pending → active once the daemon first attaches. Off by default. */
  refetchInterval?: number | false;
}) {
  return useQuery({
    queryKey: hostsKey,
    queryFn: fetchHosts,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * #task:1348 — fetch a single host the viewer owns by id.
 *
 * Unlike `useHostsQuery` (the rail/picker list, which the backend filters
 * down to FINALIZED computers), `GET /api/hosts/:id` intentionally returns
 * un-finalized drafts too. That's exactly what the Add-computer modal needs:
 * it minted a draft that won't appear in the list, and must watch its
 * lifecycle `status` flip `pending → attached → active` (`attached` = daemon
 * connected but the user hasn't confirmed the setup yet). Poll with
 * `refetchInterval` while waiting for the first connect.
 */
export function useHostByIdQuery(
  hostId: string | null | undefined,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: hostByIdKey(hostId ?? '__none__'),
    queryFn: async (): Promise<HostDto> => {
      const raw = await api<unknown>(apiPaths.host(hostId!));
      return HostGetResponseSchema.parse(raw).host;
    },
    enabled: (options?.enabled ?? true) && Boolean(hostId),
    refetchInterval: options?.refetchInterval ?? false,
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

export interface HostStatusFreshnessPolicy {
  /** React Query `staleTime` for this consumer. */
  staleTime: number;
  /** React Query `refetchOnMount` for this consumer. */
  refetchOnMount: 'always' | false;
}

/**
 * `#task:1010`/`#task:1011` (Cindy review P1) — decide the cache
 * freshness policy for `useHostStatusQuery` based on the consumer.
 *
 * The two consumers share `hostStatusKey(hostId)` but have OPPOSITE
 * freshness needs, and they must NOT inherit each other's policy:
 *
 *   - **Manual consumers (`pollUntilAvailable === false`)** —
 *     `staleTime: Infinity` + no mount refetch: the cache entry stays
 *     fresh as long as it's in memory, and the user pulls fresh data via an
 *     explicit Refresh button.
 *
 *   - **ConnectionPane pill (`pollUntilAvailable === true`)** — the
 *     remote-mode readiness source. It MUST re-validate against the live
 *     remote backend on every mount and MUST NOT trust a stale
 *     `available` left in the shared cache by a prior HostDetailView
 *     read. Otherwise the pill would flash/stick "Ready" while the
 *     daemon is actually disconnected (the `refetchInterval` stops as
 *     soon as it sees `available`, so without a forced fresh mount probe
 *     a stale `available` would never be corrected). Hence
 *     `staleTime: 0` + `refetchOnMount: 'always'`.
 *
 * Pure + exported so a unit test pins the "pollUntilAvailable never
 * inherits the fresh-forever manual cache" contract without rendering
 * the hook.
 */
export function hostStatusFreshnessPolicy(
  pollUntilAvailable: boolean,
): HostStatusFreshnessPolicy {
  return pollUntilAvailable
    ? { staleTime: 0, refetchOnMount: 'always' }
    : { staleTime: Infinity, refetchOnMount: false };
}

/**
 * `#task:808` slice 4 — fetch the per-host dynamic snapshot powering
 * host detail surfaces. Returns the discriminated `HostStatusResponse`; the
 * detail view branches on `data.availability` for the snapshot card and
 * always renders `data.agents[]` (registration is a DB fact, survives
 * daemon disconnect — see Cindy `Mtf5zZL-Y7PauIDi`).
 *
 * **Freshness is consumer-dependent** — see `hostStatusFreshnessPolicy`.
 * Manual consumers use `staleTime: Infinity` and explicit invalidation.
 * Live connection surfaces opt into `pollUntilAvailable`, which forces a fresh
 * mount probe + poll-until-available so they never trust an old offline cache.
 *
 * The hook is `enabled` only when `hostId` is provided so the master/
 * detail right pane mounting with no selection doesn't burn a request.
 */
export function useHostStatusQuery(
  hostId: string | null | undefined,
  options?: { enabled?: boolean; pollUntilAvailable?: boolean },
) {
  const freshness = hostStatusFreshnessPolicy(
    options?.pollUntilAvailable ?? false,
  );
  return useQuery<HostStatusResponse>({
    queryKey: hostStatusKey(hostId ?? '__none__'),
    queryFn: async () => {
      const raw = await api<unknown>(apiPaths.hostStatus(hostId!));
      return HostStatusResponseSchema.parse(raw);
    },
    enabled: (options?.enabled ?? true) && Boolean(hostId),
    staleTime: freshness.staleTime,
    refetchOnMount: freshness.refetchOnMount,
    refetchOnWindowFocus: false,
    // `#task:1010` — opt-in polling for the ConnectionPane "This
    // computer" pill in remote mode. There, `local_host_ws_attached_at`
    // is structurally null (the attachment registry lives in the remote
    // backend, not in-process), so the pill needs host-status
    // `availability` as the readiness source. We poll only until the
    // host reports `available`, then stop — a `disconnected` host keeps
    // polling (it's the genuine "Connecting" case) but never round-trips
    // the daemon (the backend short-circuits to `disconnected` before
    // dispatch when no attachment exists). Default callers (manual
    // refresh on HostDetailView) leave this off.
    refetchInterval: options?.pollUntilAvailable
      ? query =>
          query.state.data?.availability === 'available'
            ? false
            : CONNECTING_POLL_MS
      : false,
  });
}

/**
 * `#task:1359` — batch availability probe for the placement pickers. Placement
 * needs BOTH axes: a computer must be `placeable` (lifecycle) AND its daemon
 * online (availability). `placeable` alone lets an offline-but-finalized
 * computer through, so the picker reads live availability per candidate and
 * disables the offline ones (shiki: "offline computer 应该 disabled").
 *
 * Returns `{ availabilityById, allSettled }`. `availabilityById` maps each host
 * to its last *settled* availability. It is `undefined` only while the FIRST
 * probe is unresolved (no settled data yet); a background refetch of already-
 * settled data KEEPS the last availability rather than blanking it — freshness
 * is an orthogonal axis and must never erase the settled fact (Alice/#1370; the
 * create-dialog jitter, Cindy CDP #task:1376). `allSettled` is false until every
 * probe first lands; the pickers gate default selection on it so staggered
 * `/status` resolution can't transiently make one host look like the only
 * available target and auto-select it (Cindy P1). A genuine offline still
 * propagates: the status query settles to a non-`available` value and the fold
 * flips authoritatively — this removes only the transient in-flight `undefined`,
 * never a real state.
 *
 * Each entry shares `hostStatusKey(id)` with `useHostStatusQuery` so the detail
 * view and the picker never keep divergent caches. The dialog is transient, so
 * we take a fresh mount probe (`staleTime: 0` + `refetchOnMount`). The result
 * has a stable identity keyed on a content signature so downstream memos only
 * recompute when a host's settle-state actually changes, not every render.
 */
export interface HostAvailabilitySnapshot {
  availabilityById: Map<string, HostAvailability | undefined>;
  allSettled: boolean;
}

/**
 * Pure fold from per-host probe state to the picker's availability snapshot.
 * A `checking` host is reported as `undefined` even if it carries a stale
 * `available`, and flips `allSettled` false. Exported so the "staggered probes
 * never yield a premature single-available default" contract is unit-tested
 * without rendering React Query.
 */
export function foldHostAvailability(
  entries: {
    id: string;
    checking: boolean;
    availability: HostAvailability | undefined;
  }[],
): HostAvailabilitySnapshot {
  const availabilityById = new Map<string, HostAvailability | undefined>();
  let allSettled = true;
  for (const entry of entries) {
    availabilityById.set(entry.id, entry.checking ? undefined : entry.availability);
    if (entry.checking) allSettled = false;
  }
  return { availabilityById, allSettled };
}

export interface HostAvailabilityQueryState {
  id: string;
  /** `true` only while the FIRST probe is unresolved (React Query `isPending`)
   *  — no settled data yet. A background refetch of already-settled data is NOT
   *  pending, so it must not be treated as `checking`. */
  isPending: boolean;
  /** Last settled availability from the query cache (survives a background
   *  refetch); `undefined` when the probe has no data (pending or errored). */
  availability: HostAvailability | undefined;
}

/**
 * Pure bridge from per-host React Query state to the picker snapshot.
 * `checking` is driven by `isPending` (no settled data yet), NOT by in-flight
 * `isFetching`: availability is a single-source "last settled fact" and
 * freshness is an orthogonal axis that must never blank it (Alice/#1370). This
 * is the exact seam the create-dialog jitter fix lives on (Cindy CDP
 * #task:1376) — the four cases the review gates on:
 *   - initial pending           → checking (undefined + allSettled false)
 *   - background refetch w/data  → last-settled availability preserved
 *   - settled disconnected/etc.  → flips authoritatively (offline propagates)
 *   - errored no-data (settled)  → undefined + settled (no stuck "Checking…")
 * Exported so those cases are unit-tested without rendering React Query.
 */
export function foldHostAvailabilityQueries(
  results: HostAvailabilityQueryState[],
): HostAvailabilitySnapshot {
  return foldHostAvailability(
    results.map(result => ({
      id: result.id,
      checking: result.isPending,
      availability: result.availability,
    })),
  );
}

export function useHostAvailabilityMap(
  hostIds: string[],
): HostAvailabilitySnapshot {
  const results = useQueries({
    queries: hostIds.map(id => ({
      queryKey: hostStatusKey(id),
      queryFn: async (): Promise<HostStatusResponse> => {
        const raw = await api<unknown>(apiPaths.hostStatus(id));
        return HostStatusResponseSchema.parse(raw);
      },
      staleTime: 0,
      refetchOnMount: 'always' as const,
      refetchOnWindowFocus: false,
    })),
  });
  const entries = hostIds.map((id, i) => {
    const result = results[i];
    return {
      id,
      // `isPending` (NOT `isFetching`): "no settled data yet" = the true initial
      // probe. A BACKGROUND refetch of already-settled data has
      // `isPending===false` (data exists) even while `isFetching===true`, so it
      // keeps exposing the last availability instead of blanking it. Using
      // `isFetching` here conflated the two, so every 5s `hostStatusKey` poll
      // (shared with `useAgentOnlineByHost` behind an open create dialog) flipped
      // a known-available host to "unavailable" for ~50ms — collapsing the
      // Runtime section and re-centering the vertically-centered modal = jitter
      // (Cindy CDP #task:1376: modal y 308→312, section h 84→76, 5s cadence).
      isPending: result?.isPending ?? true,
      availability: result?.data?.availability,
    };
  });
  // Signature keys on the SETTLED fact, not freshness: `isPending` ('c') / each
  // settled availability / errored-no-data ('x'). A background refetch that
  // doesn't change the settled availability leaves the signature (and the memo)
  // untouched — no re-render churn, no flicker.
  const signature = entries
    .map(entry => `${entry.id}=${entry.isPending ? 'c' : (entry.availability ?? 'x')}`)
    .join(';');
  return useMemo(
    () => foldHostAvailabilityQueries(entries),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
}

export interface UpdateHostMutationVars {
  display_label: string | null;
}

/**
 * `#task:1361` — per-agent liveness for the AGENTS rail, sourced from each
 * computer's host status (`/status.agents[].online`, derived backend-side from
 * the daemon's active-runtime set) rather than the conversation runtime-state.
 * A daemon-connected agent that is spawned & reachable but not mid-turn reads
 * `online` here yet `idle` in `/runtime-state`, so the rail dot — which means
 * "is this agent up on its computer" — must read this source, not the
 * conversation runtime-state projection (Cindy #task:1362 P1).
 *
 * Shares `hostStatusKey(id)` with the detail view / picker (one cache per
 * computer, N computers ≤ N agents), polled on the rail cadence so presence
 * stays live. Returns `Map<agentId, boolean>` (true = online); agents whose
 * computer has no status (deleted / unowned host) are absent → caller treats
 * them as offline.
 */
export function useAgentOnlineByHost(hostIds: string[]): Map<string, boolean> {
  const results = useQueries({
    queries: hostIds.map(id => ({
      queryKey: hostStatusKey(id),
      queryFn: async (): Promise<HostStatusResponse> => {
        const raw = await api<unknown>(apiPaths.hostStatus(id));
        return HostStatusResponseSchema.parse(raw);
      },
      staleTime: 2_000,
      refetchInterval: 5_000,
      refetchOnWindowFocus: false,
    })),
  });
  // Content signature over every agent's online flag, so the memo (and Map
  // identity) only changes when a liveness bit actually flips.
  const signature = results
    .map(r => (r.data?.agents ?? []).map(a => `${a.agent_id}:${a.online}`).join(','))
    .join('|');
  return useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of results) {
      for (const a of r.data?.agents ?? []) {
        map.set(a.agent_id, a.online === 'online');
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
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

/** True when an `api()` failure carries the shared `computer_offline`
 *  envelope. This classifies a *raced* offline error at the UI layer (the
 *  computer went unreachable between the availability check and the GET/PUT
 *  landing) so the form can show the connect hint once — it is NOT a second
 *  source of the "offline" fact. The durable offline signal lives solely on
 *  the availability axis (`useHostStatusQuery`); this query and mutation are
 *  config-or-throw and never encode offline as data.
 *
 *  Exported so a unit test pins the contract-boundary parse (typed
 *  `error_code` discriminator via the shared schema) without rendering the
 *  hook — mirrors `interpretDeleteComputerError`. */
export function isHostProxyOfflineError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const parsed = HostProxyConfigOfflineResponseSchema.safeParse(
    safeJsonParse(err.body),
  );
  return (
    parsed.success &&
    parsed.data.error_code === HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE
  );
}

/**
 * Proxy config for a computer is **host-local truth** — it lives in the
 * target daemon's per-computer profile, never in the control-plane DB. The
 * backend reads/writes it by dispatching to the live daemon over the composite
 * outbound adapter, so both GET and SET require the computer to be **online**
 * (a live attachment). When it isn't, the route fails closed with a typed
 * `computer_offline` envelope (503).
 *
 * **config-or-throw** (Alice/Cindy #1350 single-source review): "offline" is
 * modeled in exactly ONE place — the availability axis (`useHostStatusQuery`,
 * which drives the section gate + hint). So this query resolves to the bare
 * `HostProxyConfig` on success and lets *every* failure — including a raced
 * `computer_offline` — propagate as a normal query error. It never encodes
 * offline as a `{ ok: false }` data sentinel: doing so duplicated the
 * availability fact and, cached under `staleTime: Infinity`, pinned a stale
 * offline hint that never cleared after the computer recovered (the P1 Cindy
 * caught). Recovery is now by construction — availability flips back to
 * `available` → the gate re-enables this query → it refetches.
 *
 * `HostProxyConfigSchema` / `HostProxyConfigResponseSchema` are the single
 * shared source (`@silverhand/shared`); we never reshape the DTO here.
 */
export function useHostProxyConfigQuery(
  hostId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<HostProxyConfig>({
    queryKey: hostProxyConfigKey(hostId ?? '__none__'),
    queryFn: async () => {
      const raw = await api<unknown>(apiPaths.hostProxyConfig(hostId!));
      return HostProxyConfigResponseSchema.parse(raw).config;
    },
    enabled: (options?.enabled ?? true) && Boolean(hostId),
    // Successful configs are cached (renderer is the sole writer; a computer's
    // proxy doesn't drift underneath us) — no blanket `staleTime: 0` that would
    // re-fetch happy-path config on every remount. Offline is NOT cached here:
    // it propagates as an error and recovers when availability re-enables us.
    staleTime: Infinity,
    // Don't retry-hammer a raced `computer_offline`; recovery rides the
    // availability transition, not query retries.
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSaveHostProxyConfigMutation(hostId: string) {
  const qc = useQueryClient();
  return useMutation<HostProxyConfig, Error, HostProxyConfig>({
    mutationFn: async (config: HostProxyConfig) => {
      const body = HostProxyConfigSchema.parse(config);
      const raw = await api<unknown>(apiPaths.hostProxyConfig(hostId), {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return HostProxyConfigResponseSchema.parse(raw).config;
    },
    // config-or-throw: a raced `computer_offline` rejects the mutation (the
    // caller shows the connect hint once); it is never written into the query
    // cache. Only a confirmed write updates the cached config.
    onSuccess: config => {
      qc.setQueryData(hostProxyConfigKey(hostId), config);
    },
  });
}

/**
 * #task:1348 / #task:1428 — create a user-managed computer. The backend mints a
 * PENDING host + a reveal-once connect token and returns the bootstrap payload
 * (`connect_token` + `daemon_npm_spec` + `advertised_origin_override`); the
 * desktop assembles the connect command locally from those + its own connected
 * server URL. Naming happens AFTER the first successful connect, so this only
 * starts the flow; the row shows up in the sidebar as pending until a daemon
 * attaches.
 *
 * **Reveal-once boundary**: `connect_token` is the cleartext credential shown
 * exactly once. The caller keeps it in local component state only — never write
 * it into the query cache. The `daemon_command` / `server_url` fields are
 * deprecated migration bridges and are no longer consumed.
 */
export function useCreateComputerMutation() {
  const qc = useQueryClient();
  return useMutation<HostCreateResponse, Error, void>({
    mutationFn: async () => {
      const raw = await api<unknown>(apiPaths.hosts, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return HostCreateResponseSchema.parse(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKey });
    },
  });
}

export type RotateConnectTokenResult = z.infer<
  typeof HostRotateTokenUserManagedResponseSchema
>;

/**
 * #task:1348 / #task:1354 — delete the user-managed computer behind an
 * abandoned Add-computer draft.
 *
 * A pending computer is a modal-scoped DRAFT, not a permanent lifecycle
 * event (shiki: "这个连接只是一个临时的生命周期"). Closing the Add-computer
 * dialog before the setup is finalized deletes the draft row and
 * hard-invalidates its reveal-once token, so no orphan pending card lingers
 * in the rail and the never-copied command can't later connect.
 *
 * ⚠️ Post-#task:1355 this route is the UNIFIED empty-computer delete:
 * `DELETE /api/hosts/:id` hard-deletes an owner's `remote + user_invite`
 * host whenever it has no dependents — INCLUDING a *finalized* empty
 * computer. The old `finalized_at → 409 host_already_active` guard that made
 * a close-time cancel a benign no-op is GONE. So this mutation is NOT safe
 * to fire on a computer that has been finalized — the caller
 * (`NewComputerDialog`) owns that decision via its categorical
 * "finalized → never delete" guard and only fires this for a genuine draft
 * abandon. It stays best-effort (404/409 just mean "nothing to clean up"),
 * but "best-effort" no longer implies "harmless on a real computer".
 */
export function useCancelPendingComputerMutation() {
  const qc = useQueryClient();
  return useMutation<HostCancelPendingResponse, Error, string>({
    mutationFn: async (hostId: string) => {
      const raw = await api<unknown>(apiPaths.hostCancelPending(hostId), {
        method: 'DELETE',
      });
      return HostCancelPendingResponseSchema.parse(raw);
    },
    onSettled: () => {
      // Refresh the rail whether the delete landed or the row turned out
      // to be a real (already-attached) computer — either way the list
      // may have changed.
      void qc.invalidateQueries({ queryKey: hostsKey });
    },
  });
}

/**
 * #task:1348 / #task:1428 — rotate a user-managed computer's connect token.
 * Mints a fresh reveal-once credential, invalidates the old token, and
 * force-drops any live connection using it (no grace — Cindy/Alice contract).
 * Same bootstrap-payload shape as create; the new `connect_token` lands once in
 * the response and is kept in local state only, and the card assembles the
 * command locally from it (the `daemon_command` bridge field is not consumed).
 */
export function useRotateConnectTokenMutation(hostId: string) {
  const qc = useQueryClient();
  return useMutation<RotateConnectTokenResult, Error, void>({
    mutationFn: async () => {
      const raw = await api<unknown>(apiPaths.hostRotateConnectToken(hostId), {
        method: 'POST',
      });
      return HostRotateTokenUserManagedResponseSchema.parse(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKey });
    },
  });
}

/**
 * #task:1348 / #task:1351 — disconnect a user-managed computer's CURRENT
 * live connection WITHOUT touching credentials or lifecycle. This is a
 * pure availability-axis kick: the connect token stays valid and the same
 * connection command reconnects later (contrast rotate/revoke, which
 * invalidate the token). The backend returns a benign `disconnected:false`
 * no-op when there was no live connection, so callers don't special-case
 * races.
 *
 * Invalidate both the host list (rail availability pips) and this host's
 * status (the detail-view pill + the Disconnect button's own gate) so the
 * UI flips online → offline right after the kick; liveness also arrives
 * via host-connection-sync, this just makes it immediate.
 */
export function useDisconnectHostMutation(hostId: string) {
  const qc = useQueryClient();
  return useMutation<HostDisconnectResponse, Error, void>({
    mutationFn: async () => {
      const raw = await api<unknown>(apiPaths.hostDisconnect(hostId), {
        method: 'POST',
      });
      return HostDisconnectResponseSchema.parse(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKey });
      void qc.invalidateQueries({ queryKey: hostStatusKey(hostId) });
    },
  });
}

/**
 * #task:1354 — a `409 has_dependents` delete block, surfaced as a typed
 * error so the UI can render the dependency-block state (how many agents /
 * workspaces still pin this computer) instead of a generic failure. Carries
 * the shared `dependents` value object verbatim — no renderer-local reshape.
 */
export class ComputerHasDependentsError extends Error {
  constructor(
    readonly dependents: HostDeleteDependents,
    /** #task:1380 — backend marks an *agent-only* dependency set as
     *  cascade-able. When true the UI offers a second "also deletes its N
     *  agents" confirm that re-issues DELETE with `{ cascade_agents: true }`;
     *  when false (a regular workspace still pins this computer) it stays a
     *  hard block the user must clear in its own context first. */
    readonly canCascadeAgents: boolean,
    /** #task:1380 — the identities of the agents that would be cascade-deleted,
     *  as the backend's DB delete-set (`listByHost` — the SAME rows the cascade
     *  loop deletes, so shown == deleted, and it stays populated even when the
     *  computer is offline). The cascade confirm lists these under the
     *  "Agents will be removed" impact block. Empty for a non-cascade-able
     *  block (a regular workspace pins the computer). Never sourced from the
     *  daemon host-status view, which is empty/stale offline (Alice #task:1380). */
    readonly agents: HostDeleteDependentAgent[],
  ) {
    super('has_dependents');
    this.name = 'ComputerHasDependentsError';
  }
}

/**
 * #task:1380 — a `409 has_pending_agents` block, surfaced as its OWN typed
 * error so the UI keeps it OFF the structural cascade/hard-block axis. An agent
 * on this computer is still materializing (a transient state that resolves on
 * its own), so the correct UX is "wait and retry", NOT a cascade confirm.
 *
 * Distinct code, distinct type on purpose (Alice #task:1380 invariant): if
 * pending collapsed into `has_dependents`, the pending agent would count into
 * `dependents.agents` with `can_cascade_agents: true`, the UI would render a
 * cascade confirm, the user would confirm, the backend would re-`409`-pending,
 * and the confirm screen would reappear — a dead-end. Routing it here renders a
 * transient retry hint instead.
 */
export class ComputerHasPendingAgentsError extends Error {
  constructor(readonly pendingAgents: number) {
    super('has_pending_agents');
    this.name = 'ComputerHasPendingAgentsError';
  }
}

/**
 * #task:1354 / #task:1380 — delete a user-managed computer (the single removal
 * verb; there is no user-facing revoke).
 *
 * The backend `DELETE /api/hosts/:id` covers both unfinalized Add-computer
 * drafts and finalized empty computers:
 *   - empty → hard-deletes the row, cascades its credential, force-drops any
 *     live WS; success is `{ host_id, deleted: true }`.
 *   - still owns agents / workspaces → refused with `409 has_dependents`
 *     (nothing deleted; the RESTRICT FK is the correctness backstop). We map
 *     that to `ComputerHasDependentsError` carrying the counts +
 *     `can_cascade_agents` so the caller shows the block state (hard) or the
 *     agent-cascade confirm.
 *
 * #task:1380 — pass `{ cascadeAgents: true }` on the confirm re-issue. That
 * sends `{ cascade_agents: true }` in the DELETE body; it is an INTENT
 * confirmation only, never a bypass — the backend re-computes the dependency
 * set on its own truth and still 409s if a regular workspace pins the computer
 * (Alice invariant), so this mutation may reject with `ComputerHasDependentsError`
 * even on the cascade attempt and the caller must not assume success.
 *
 * On success we invalidate `hostsKey`; the app-shell then drops the deleted
 * row from `computerHosts`, which auto-clears the detail selection — no
 * explicit navigation needed here.
 */
export interface DeleteComputerVars {
  cascadeAgents?: boolean;
}

export function useDeleteComputerMutation(hostId: string) {
  const qc = useQueryClient();
  return useMutation<HostDeleteResponse, Error, DeleteComputerVars | void>({
    mutationFn: async vars => {
      try {
        const raw = await api<unknown>(apiPaths.host(hostId), {
          method: 'DELETE',
          ...(vars?.cascadeAgents
            ? { body: JSON.stringify({ cascade_agents: true }) }
            : {}),
        });
        return HostDeleteResponseSchema.parse(raw);
      } catch (err) {
        throw interpretDeleteComputerError(err);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hostsKey });
    },
  });
}

/**
 * Per-host runtime-detection catalog (#task:1376). Asks the *target*
 * computer's daemon (composite dispatch by hostId — not app-local
 * `/api/runtimes`) which offerable runtimes (catalog `selectable`)
 * are installed, returning an explicit state per runtime.
 *
 * - `enabled` gates the probe on the caller's availability check: an offline
 *   computer can't be probed, so the picker collapses into the availability
 *   gate rather than a bogus all-absent result.
 * - `retry: false` — a dispatch failure (host unreachable/timeout) is a real
 *   "unknown-for-all" signal the UI surfaces as *enabled + can't-confirm*, not
 *   silently retried into a spinner.
 * - `reprobe()` is the manual "Recheck" force path: it hits `?force=1` to
 *   bypass the daemon's short TTL (a user who just installed a runtime
 *   shouldn't have to reopen the dialog) and writes the fresh result back into
 *   the same cache key. It never throws — a probe hiccup must not break the
 *   dialog; the last-known catalog stays in place.
 */
export function useHostRuntimeCatalog(
  hostId: string | null | undefined,
  options?: { enabled?: boolean },
): {
  data: RuntimeCatalogResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  reprobe: () => Promise<void>;
  isReprobing: boolean;
} {
  const qc = useQueryClient();
  const [isReprobing, setIsReprobing] = useState(false);
  const enabled = (options?.enabled ?? true) && Boolean(hostId);
  const query = useQuery({
    queryKey: hostRuntimeCatalogKey(hostId ?? '__none__'),
    enabled,
    // Installed-runtime sets change rarely; cache within a dialog session but
    // refetch on remount so reopening after an install picks it up. `reprobe`
    // (force) is the immediate-refresh escape hatch.
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const raw = await api<unknown>(apiPaths.hostRuntimeCatalog(hostId!));
      return RuntimeCatalogResponseSchema.parse(raw);
    },
  });
  const reprobe = useCallback(async () => {
    if (!hostId) return;
    setIsReprobing(true);
    try {
      const raw = await api<unknown>(
        `${apiPaths.hostRuntimeCatalog(hostId)}?force=1`,
      );
      qc.setQueryData(
        hostRuntimeCatalogKey(hostId),
        RuntimeCatalogResponseSchema.parse(raw),
      );
    } catch {
      // Swallow: a forced re-probe failure leaves the last-known catalog (or
      // the unknown-for-all fallback) in place. Never break the dialog.
    } finally {
      setIsReprobing(false);
    }
  }, [hostId, qc]);
  return {
    data: query.data,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    reprobe,
    isReprobing,
  };
}

/**
 * Pure: interpret a delete failure. A `409 has_dependents` envelope (parsed
 * via the shared `HostDeleteBlockedResponseSchema` — single source, never a
 * renderer-local reshape) becomes a typed `ComputerHasDependentsError`
 * carrying the counts; every other failure passes through unchanged.
 *
 * Exported so a unit test pins the contract-boundary parse (nested
 * `dependents`, `error_code` discriminator) without rendering the hook.
 */
export function interpretDeleteComputerError(err: unknown): Error {
  if (err instanceof ApiError && err.status === 409) {
    const body = safeJsonParse(err.body);
    // Transient pending-agents block: its own typed error, kept off the
    // structural cascade/hard-block axis (Alice invariant — see
    // ComputerHasPendingAgentsError). Parsed via the shared schema
    // (`@silverhand/shared`, Cindy #task:1380) — single source, no
    // renderer-local reshape.
    const pending = HostDeletePendingAgentsResponseSchema.safeParse(body);
    if (pending.success) {
      return new ComputerHasPendingAgentsError(pending.data.pending_agents);
    }
    const blocked = HostDeleteBlockedResponseSchema.safeParse(body);
    if (blocked.success) {
      return new ComputerHasDependentsError(
        blocked.data.dependents,
        blocked.data.can_cascade_agents,
        blocked.data.agents,
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Best-effort JSON parse of an `ApiError.body` string; returns `null` on
 *  non-JSON so a schema `safeParse` cleanly falls through to the generic
 *  error path instead of throwing. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
