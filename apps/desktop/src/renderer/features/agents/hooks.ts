import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AgentAvailability,
  AgentAvailabilityDto,
  AgentDto,
  AgentLiveness,
  AgentLivenessDto,
  AgentRuntimeStateDto,
  AgentWorkspaceFileRead,
  AgentWorkspaceTree,
  CreateAgentInput,
  McpProbeRequest,
  McpProbeResult,
  ScheduleDto,
  ScheduleListStatusFilter,
  SwitchAgentRuntimeInput,
  SwitchAgentRuntimeResponse,
  UpdateAgentInput,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import {
  AGENT_AVAILABILITY_CHANGED_EVENT,
  AgentAvailabilityChangedEventSchema,
} from '@silverhand/shared';
import { api, apiUpload, ApiError } from '@/lib/api';
import { isCurrentViewerScope, onWsFrame, subscribeViewerScope } from '@/lib/ws-client';

const agentsKey = ['agents'] as const;
const agentKey = (id: string) => ['agents', id] as const;
/**
 * Which directory an Agent Workspace read targets (Cindy #task:1190):
 *  - `home` → no `workspace_id` param → the agent home / L1 dir (full page);
 *  - `workspace` → `?workspace_id=<id>` → that workspace's L2 dir (side panel).
 * The resolver is source-blind on the wire — the frontend never builds a path,
 * only names a workspace. Passing an agent_home/DM workspace id resolves back to
 * home (expected overlap), so the renderer never branches on source.
 */
export type AgentWorkspaceSource =
  | { kind: 'home' }
  | { kind: 'workspace'; workspaceId: string };

/** Cache-scope segment so home vs each workspace get distinct query entries.
 *  The prefix `['agents', id, 'workspace']` still matches all of them, so the
 *  pane's coarse refresh-invalidate keeps working. */
function sourceScope(source: AgentWorkspaceSource): string {
  return source.kind === 'workspace' ? `ws:${source.workspaceId}` : 'home';
}

/** The `?workspace_id=` query fragment for a source (`''` for home → existing
 *  L1 behaviour). Exported for the contract test — the param name must match
 *  the backend exactly. */
export function workspaceScopeQuery(source: AgentWorkspaceSource): string {
  return source.kind === 'workspace'
    ? `workspace_id=${encodeURIComponent(source.workspaceId)}`
    : '';
}

const agentWorkspaceTreeKey = (id: string, scope: string) =>
  ['agents', id, 'workspace', 'tree', scope] as const;
const agentWorkspaceFileKey = (id: string, scope: string, path: string) =>
  ['agents', id, 'workspace', 'file', scope, path] as const;
const agentRuntimeStateKey = (id: string) => ['agents', id, 'runtime-state'] as const;
const agentSchedulesKey = (id: string, status: ScheduleListStatusFilter) =>
  ['agents', id, 'schedules', status] as const;
/**
 * List agents the viewer can see. Default = the full `canViewAgent` ACL set
 * (agents the viewer created OR participates in via a shared workspace).
 *
 * `scope: 'owned'` narrows to agents the LOGIN USER created — the backend
 * composes `created_by_user_id == viewer.userId` ON TOP of the ACL floor
 * (`GET /api/agents?scope=owned`, #task:1256). The "who counts as mine"
 * predicate lives ONLY in that backend contract; the renderer passes the flag
 * and never re-filters `created_by_user_id` client-side, so the CLI and every
 * other consumer share one definition. The scoped result gets its own cache
 * key (`['agents', 'owned']`) so it doesn't clobber the default list; both are
 * refreshed by the `['agents']`-prefixed invalidations on create/delete/avatar.
 */
export function useAgents(options?: { enabled?: boolean; scope?: 'owned' }) {
  const scope = options?.scope;
  return useQuery({
    queryKey: scope ? ([...agentsKey, scope] as const) : agentsKey,
    queryFn: async () => {
      const res = await api<{ agents: AgentDto[] }>(
        scope ? `/api/agents?scope=${scope}` : '/api/agents',
      );
      return res.agents;
    },
    enabled: options?.enabled ?? true,
  });
}

export function useAgent(agentId: string | null) {
  return useQuery({
    queryKey: agentId ? agentKey(agentId) : ['agents', 'none'],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<{ agent: AgentDto }>(`/api/agents/${agentId}`);
      return res.agent;
    },
  });
}

const agentLivenessKey = (id: string) => ['agents', id, 'liveness'] as const;

/**
 * The liveness query's refresh + retry policy, as ONE falsifiable config apart
 * from the fold. The endpoint has NO push invalidation (Alice, #task:2043): the
 * server recomputes the bit per GET from its host snapshot and never emits a
 * change event. So freshness is the client's responsibility — a mounted surface
 * (a DM popover, the profile hero) must refresh on a bounded timer, or a value
 * read once at mount would silently age past `staleMs`, fold to `unknown`, and
 * the hero that just showed "online" would disappear ~15s later (shiki, dogfood
 * 2026-08-17). `staleTime` alone does NOT do this: it only expires the value, it
 * never refetches — so without an interval the stale value is never replaced.
 *
 * INVARIANT `refetchIntervalMs < staleMs` (asserted in the unit test): each
 * mounted poll writes a fresh `dataUpdatedAt`, resetting the stale countdown
 * BEFORE the value can age out. A reachable host therefore keeps reading its
 * last state for as long as the surface is mounted — the fold never sees a
 * fresh value flip to `unknown` between polls (no per-poll flicker; see
 * `projectAgentLiveness`, which by design does not read `isFetching`). The value
 * only ages into `unknown` when the polls themselves FAIL past `staleMs` — an
 * unreachable host, which is the honest outcome.
 *
 * `refetchIntervalInBackground: false` — an unmounted / backgrounded surface has
 * no viewer, so it stops polling and refetches on the next mount instead.
 */
export const AGENT_LIVENESS_QUERY_POLICY = {
  staleMs: 15 * 1000,
  refetchIntervalMs: 10 * 1000,
  refetchIntervalInBackground: false,
  /** Transport / 5xx retries are BOUNDED — a persistently-failing read has
   *  nothing to eventually deliver by retrying forever, so after this many it
   *  settles into the honest `unknown` rather than hammering an unreachable
   *  host. A 4xx is terminal before this count even applies (see below). */
  maxRetries: 2,
} as const;

/**
 * Retry predicate for the liveness read, pulled out so its ceiling is a unit
 * assertion rather than behavior buried in the query config:
 *  - a 4xx is TERMINAL — a 404 is the endpoint's anti-enumeration answer for a
 *    non-viewer, which retrying can never turn into a liveness bit;
 *  - transport failures and 5xx retry up to `maxRetries`, then stop so the read
 *    folds to `unknown` instead of retrying forever against a host with no
 *    pending answer to give.
 */
export function agentLivenessRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < AGENT_LIVENESS_QUERY_POLICY.maxRetries;
}

/**
 * Pure projection of the liveness query state onto the tri-state a consumer
 * draws. The endpoint has NO invalidation channel (Alice, #task:2043): the
 * server recomputes the bit per GET from its host snapshot and never pushes a
 * change, so a value the client holds is trustworthy ONLY while it is a FRESH
 * successful read. Every other state folds to `unknown` — the honest "we don't
 * know", NEVER to `offline` (an unreachable/disconnected host is not a dead
 * process, #task:2039):
 *  - `data === undefined` — first load in flight, disabled, or a read that
 *    failed with no prior value (incl. the 404 anti-enum for a non-viewer);
 *  - `isStale` — a value aged past `staleTime`. With nothing to invalidate it, a
 *    stale bit has no authority; it also covers a value stranded behind a failing
 *    background refetch (React Query retains the old `data` and keeps `status`
 *    `'success'`, but never refreshes `dataUpdatedAt`, so it ages into stale).
 *
 * A FRESH value with a poll in flight (`isFetching`, mounted refresh not yet
 * resolved) intentionally reads as its last state, NOT `unknown`: the input is
 * `{ data, isStale }` and deliberately omits `isFetching`. Folding an in-flight
 * poll to `unknown` would flicker a mounted `online` hero to nothing on every
 * `refetchInterval` tick. A fresh value is still authoritative until it either
 * goes stale or a poll replaces it (see `AGENT_LIVENESS_QUERY_POLICY`).
 *
 * Splitting this out makes the fold falsifiable in isolation: the query config
 * (retry/refetch policy) can move without touching the online/offline/unknown
 * decision, and each fold case is a one-line unit assertion.
 */
export function projectAgentLiveness(state: {
  data: AgentLiveness | undefined;
  isStale: boolean;
}): AgentLiveness {
  if (state.data === undefined || state.isStale) return 'unknown';
  return state.data;
}

/**
 * The agent's process liveness — the ONE viewer-authorized bit
 * `GET /api/agents/:id/liveness` answers (#task:2043 B). Tri-state:
 *  - `online`  — the runtime is live on its computer;
 *  - `offline` — the computer answered and the process is not running;
 *  - `unknown` — the host hasn't answered / the computer is unreachable, OR the
 *    client's own read is loading / stale / failing. This is NOT the same as
 *    offline (a revoked or disconnected host is not a dead process), so a
 *    consumer renders unknown as unknown — usually nothing — never as Offline.
 *
 * `canViewAgent`-gated, so the HUMAN endpoint of a human↔agent DirectPair can
 * read its counterpart's liveness — the bit the old owner-only host-status path
 * could not give a non-owner, which is why a DM popover showed no status at all
 * (#task:2039). A point read, not a realtime subscription: the endpoint has no
 * push channel, so a mounted surface polls on a BOUNDED interval
 * (`AGENT_LIVENESS_QUERY_POLICY`, interval < staleTime) to keep a resident value
 * fresh; an unmounted surface stops. The tri-state is projected by
 * `projectAgentLiveness`, so a cached-old / cold / failing read reads as
 * `unknown` rather than asserting a possibly-wrong online/offline forever.
 */
export function useAgentLiveness(
  agentId: string | null | undefined,
): AgentLiveness {
  const query = useQuery({
    queryKey: agentId ? agentLivenessKey(agentId) : ['agents', 'none', 'liveness'],
    enabled: !!agentId,
    staleTime: AGENT_LIVENESS_QUERY_POLICY.staleMs,
    // Bounded mounted refresh: the endpoint never pushes, so poll to keep a
    // resident value fresh. Interval < staleTime, so a reachable host stays
    // fresh between polls (no flicker); only failing polls let it age to
    // `unknown`. Stops when the surface unmounts / backgrounds.
    refetchInterval: AGENT_LIVENESS_QUERY_POLICY.refetchIntervalMs,
    refetchIntervalInBackground:
      AGENT_LIVENESS_QUERY_POLICY.refetchIntervalInBackground,
    retry: agentLivenessRetry,
    queryFn: async () => {
      const res = await api<AgentLivenessDto>(apiPaths.agentLiveness(agentId!));
      return res.liveness;
    },
  });
  return projectAgentLiveness({ data: query.data, isStale: query.isStale });
}

const agentAvailabilityKey = (id: string) => ['agents', id, 'availability'] as const;

/**
 * Transport / 5xx retries for the availability read are BOUNDED, and a 4xx is
 * TERMINAL — the SAME shape as the liveness read: a 404 is the endpoint's
 * anti-enumeration answer for a non-viewer, which no amount of retrying turns
 * into an availability bit. A persistently-failing read has nothing to deliver
 * by hammering an unreachable authority, so it settles into the renderer's
 * `unknown` (no-status) instead.
 */
const AGENT_AVAILABILITY_MAX_RETRIES = 2;

export function agentAvailabilityRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < AGENT_AVAILABILITY_MAX_RETRIES;
}

/**
 * Pure projection of the availability query state onto the tri-state a consumer
 * composes. Unlike liveness, this axis is EVENT-invalidated, not timer-polled
 * (#task:2043): the route is the single source of the value and
 * `agent_availability_changed` drives every refresh, so a successful value stays
 * authoritative until an event invalidates it — there is no `staleTime` timer to
 * age it out, hence no `isStale` input here.
 *  - `data === undefined` — first load in flight, disabled, or a read that failed
 *    with no prior value (incl. the 404 anti-enum for a non-viewer) → `unknown`,
 *    the renderer's "we cannot tell", which composes to no-status.
 *  - otherwise the last successful value. A refetch triggered by an event (or a
 *    transient 5xx during one) retains the prior `data` while it re-reads; reading
 *    that last value rather than flickering to `unknown` matches the liveness fold
 *    and keeps a mounted line from blinking between the invalidation and its
 *    replacement. The next event (or its `snapshot_required` recovery) corrects a
 *    stale-after-fault value.
 */
export function projectAgentAvailability(state: {
  data: AgentAvailability | undefined;
}): AgentAvailability | 'unknown' {
  return state.data === undefined ? 'unknown' : state.data;
}

/** Minimal WS frame shape {@link decideAgentAvailabilityInvalidation} consumes,
 *  so the decision is exercised without React or a socket (mirrors
 *  `DirectPairsSyncFrame`). */
export interface AgentAvailabilitySyncFrame {
  type: string;
  kind?: string;
  payload?: unknown;
}

/**
 * Pure decision: does this frame invalidate the given agent's availability?
 *
 * `snapshot_required` counts unconditionally (for the one mounted agent): a
 * replay gap may have swallowed the `agent_availability_changed` frame, and the
 * only recovery for a dropped viewer-scoped delta is to refetch — same reasoning
 * as every other viewer-scoped list (see `decideDirectPairsInvalidation`).
 * An `agent_availability_changed` event counts only when its validated
 * `agent_id` matches — the event is per-viewer but not per-agent, so a mounted
 * surface refetches solely its own agent.
 *
 * The caller gates `isCurrentViewerScope(frame.scope)` first — kept out of here
 * so the decision stays dependency-free and unit-testable.
 */
export function decideAgentAvailabilityInvalidation(
  frame: AgentAvailabilitySyncFrame,
  agentId: string,
): boolean {
  if (frame.type === 'snapshot_required') return true;
  if (frame.type !== 'event' || frame.kind !== AGENT_AVAILABILITY_CHANGED_EVENT) {
    return false;
  }
  const parsed = AgentAvailabilityChangedEventSchema.safeParse(frame.payload);
  return parsed.success && parsed.data.agent_id === agentId;
}

/**
 * The agent's reachability — the ONE viewer-authorized bit
 * `GET /api/agents/:id/availability` answers (#task:2043). TWO values on the
 * wire (`online` | `offline`), projected here to a tri-state with the renderer's
 * own `unknown` (query pending / errored with no prior value). Composes with
 * liveness via {@link projectGlobalPresence}.
 *
 * Unlike liveness, this endpoint HAS a push channel: the viewer-scoped
 * `agent_availability_changed {agent_id}` frame is a pure invalidation signal, so
 * the query is `staleTime: Infinity` with NO polling — a mounted surface
 * subscribes the `viewer:<userId>` scope and refetches only when a matching event
 * (or a `snapshot_required` replay recovery) arrives. The subscription lives with
 * the hook, not app-shell-global: availability only matters while a presence line
 * for that agent is on screen, so there is nothing to keep live for an agent no
 * view is reading (contrast `useDirectPairsSync`, which must catch a stranger's
 * first DM while the viewer looks elsewhere).
 */
export function useAgentAvailability(
  agentId: string | null | undefined,
): AgentAvailability | 'unknown' {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: agentId ? agentAvailabilityKey(agentId) : ['agents', 'none', 'availability'],
    enabled: !!agentId,
    // The route is the single source of the value; the event drives every
    // refresh, so there is no timer-based staleness (no poll, no age-out).
    staleTime: Infinity,
    retry: agentAvailabilityRetry,
    queryFn: async () => {
      const res = await api<AgentAvailabilityDto>(apiPaths.agentAvailability(agentId!));
      return res.availability;
    },
  });
  useEffect(() => {
    if (!agentId) return;
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (
        (frame.type !== 'event' && frame.type !== 'snapshot_required') ||
        !isCurrentViewerScope(frame.scope)
      ) {
        return;
      }
      if (decideAgentAvailabilityInvalidation(frame, agentId)) {
        void qc.invalidateQueries({ queryKey: agentAvailabilityKey(agentId) });
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [agentId, qc]);
  return projectAgentAvailability({ data: query.data });
}

/** The user-facing presence a consumer draws once both axes are composed. */
export type GlobalPresence = 'online' | 'away' | 'offline';

/**
 * Compose the two orthogonal presence axes into the one word the UI shows
 * (shiki 2026-08, frozen): Availability answers "can this agent work for me
 * right now" (host reachable × agent valid); liveness answers "is a live process
 * running this instant". Availability is the PRIMARY axis:
 *  - availability `unknown` (query pending / errored) → `null`: there is no
 *    presence to claim yet, so the consumer draws no dot and no label — never a
 *    speculative Offline for an agent we simply haven't read.
 *  - availability `offline` → `Offline`: the host is unreachable or the agent is
 *    invalid; this is the honest Offline regardless of any stale liveness bit (a
 *    reaped process on a reachable host is NOT offline).
 *  - availability `online` → the agent WILL answer. A live process now
 *    (`liveness === 'online'`) → `Online`; otherwise reachable-but-idle
 *    (idle-reaped, waking on the next message, or liveness not yet known) →
 *    `Away` (shiki: idle-reap → Away, not Offline).
 *
 * Reading Offline ONLY from availability — never from liveness — is the whole
 * point: liveness-alone showed a reachable agent that had just replied as
 * Offline (#task:2039, "sea"). The transitions this admits as data arrives move
 * one way only (no-status → Away → Online), never a backward flip to a louder
 * claim.
 */
export function projectGlobalPresence(
  availability: AgentAvailability | 'unknown',
  liveness: AgentLiveness,
): GlobalPresence | null {
  if (availability === 'unknown') return null;
  if (availability === 'offline') return 'offline';
  return liveness === 'online' ? 'online' : 'away';
}

const agentProfileMcpKey = (id: string) => ['agents', id, 'profile-mcp'] as const;

/**
 * Read the agent's raw profile MCP config (`mcp.json`, or `null` when unset).
 * The endpoint is `canEditAgent`-gated — the raw can carry secrets, so a
 * non-editor viewer gets a 403 (surfaced as a "private" state, not retried).
 * 4xx responses are terminal: retrying can't turn a forbidden/not-found into
 * bytes, it only delays the locked/empty state.
 */
export function useAgentProfileMcp(agentId: string | null) {
  return useQuery({
    queryKey: agentId ? agentProfileMcpKey(agentId) : ['agents', 'none', 'profile-mcp'],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<{ raw: string | null }>(apiPaths.agentProfileMcp(agentId!));
      return res.raw;
    },
    retry: (count, err) =>
      !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
  });
}

/**
 * Live MCP **probe** — connect to one server's real endpoint, run the protocol
 * `initialize` handshake and, when `include_tools`, `tools/list`. A mutation,
 * not a query: it is an explicit, side-effectful, user-triggered diagnostic
 * (never on mount, never polled). The host owns the whole connection
 * lifecycle (one-shot connect → close in `finally`); the renderer just fires
 * the request and renders the returned snapshot. The endpoint is
 * `canEditAgent`-gated, same as the raw read.
 *
 * One mutation instance per ServerRow so each row's pending/result state is
 * isolated. `server_name` is the RAW name (the host connects to the real
 * endpoint, not the `silverhand_profile__` runtime alias).
 */
export function useMcpProbe(agentId: string) {
  return useMutation({
    mutationFn: async (body: McpProbeRequest) => {
      // Route returns the bare `McpProbeResult` (200), canEditAgent-gated;
      // protocol failures are `{ok:false, phase}` at 200, only host-transport
      // faults are HTTP errors. (#task:1137 backend, agents.ts:603.)
      return api<McpProbeResult>(apiPaths.agentProfileMcpProbe(agentId), {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgentInput) => {
      // D4.d D3 — `POST /api/agents` now REQUIRES an
      // `Idempotency-Key` header (1..64, `[A-Za-z0-9_-]`) per
      // design §14 Q1. The key is generated inside this
      // `mutationFn` closure and lives for exactly the single
      // `api()` HTTP attempt below.
      //
      // Scope note (Cindy D3 round-2 P2): D3 ONLY commits to
      // "every HTTP attempt carries an Idempotency-Key". We do
      // NOT commit to key reuse across React Query's builtin
      // retry surface — each invocation of `mutationFn`
      // (whether from a fresh `mutate()` call or from React
      // Query's automatic retry) re-enters this scope and
      // generates a new key. If a future UX wants a "Retry"
      // button to round-trip the original create's idempotent
      // state, the key must be lifted out of `mutationFn` into
      // mutation context / component state — that's an explicit
      // future change, not an emergent property of the current
      // code.
      //
      // `crypto.randomUUID()` is RFC 4122 v4 — 36 chars,
      // [0-9a-f-] only, well within the route's 1..64
      // `[A-Za-z0-9_-]` window. No need for any extra encoding.
      const idempotencyKey = crypto.randomUUID();
      const res = await api<{
        agent: AgentDto;
        agent_home_workspace_id: string | null;
        dm_channel_id: string | null;
        onboarding_message_id: string | null;
      }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useUpdateAgent(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateAgentInput) => {
      if (!agentId) throw new Error('no agent id');
      const res = await api<{ agent: AgentDto }>(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      return res.agent;
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: agentKey(agentId) });
    },
  });
}

/**
 * Cache-invalidation side effects for a successful runtime switch. Extracted
 * from `useSwitchAgentRuntime.onSuccess` so it can be unit-tested against a
 * real QueryClient with a seeded run-state query (Cindy #1470 review).
 *
 * The run-state keys are `['conversations', conversationId, 'agent-run-states']`
 * — see `lib/agentRunStateCache.ts::agentRunStatesKey` (the single authority;
 * `features/channels/hooks.ts::useAgentRunStates` calls into it). A bare
 * `['conversations']` prefix would over-fire against every conversation-scoped
 * query, so we use a structured predicate that matches only run-state slots.
 */
export function applySwitchAgentRuntimeSideEffects(
  qc: QueryClient,
  agentId: string,
): void {
  qc.invalidateQueries({ queryKey: agentsKey });
  qc.invalidateQueries({ queryKey: agentKey(agentId) });
  qc.invalidateQueries({ queryKey: agentRuntimeStateKey(agentId) });
  qc.invalidateQueries({ queryKey: ['channels'] });
  qc.invalidateQueries({
    predicate: q =>
      q.queryKey[0] === 'conversations' && q.queryKey[2] === 'agent-run-states',
  });
}

/**
 * PUT /api/agents/:id/runtime — transition an agent to a different runtime
 * (#task:1470). Distinct from `useUpdateAgent`'s PATCH: runtime changes carry
 * transition semantics (stop child processes, clear CLI sessions, reset
 * per-runtime state) and MUST go through the dedicated backend command, not
 * the ordinary field-patch route.
 *
 * Contract (`SwitchAgentRuntimeInputSchema` in shared): all four keys
 * required; `null` on model / reasoning_effort / fast_mode is the explicit
 * "Use driver default" sentinel. The schema also enforces `(runtime, value)`
 * legality — the UI's per-runtime catalog gating mirrors this, so a legal UI
 * state is always accepted.
 *
 * Response (`SwitchAgentRuntimeResponse`) carries transition side-effects.
 * The renderer keys on `restart_failures > 0` to surface partial success as
 * a warning (not a green toast), so a "runtime committed but N conversations
 * couldn't restart" outcome isn't misread as clean success. `restart_failures`
 * is a nonneg count (not a list of details).
 */
export function useSwitchAgentRuntime(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SwitchAgentRuntimeInput) => {
      if (!agentId) throw new Error('no agent id');
      const res = await api<SwitchAgentRuntimeResponse>(
        apiPaths.agentRuntime(agentId),
        {
          method: 'PUT',
          body: JSON.stringify(input),
        },
      );
      return res;
    },
    onSuccess: () => {
      if (!agentId) return;
      applySwitchAgentRuntimeSideEffects(qc, agentId);
    },
  });
}

/**
 * POST /api/agents/:id/avatar (multipart). Mirrors `useUploadAvatar` in
 * `features/me/hooks.ts` but for agents.
 *
 * The route is gated by `canEditAgent` (creator-or-system) — non-creator
 * humans get 403, which `apiUpload` surfaces as `ApiError`. The renderer
 * UI hides the upload control via `canEditAgentProfile` so the user
 * normally never reaches this hook without permission, but the
 * mutation still has to handle 403 in case the cached `created_by_user_id`
 * is stale or the agent was just transferred.
 *
 * On success the response carries the updated agent dto with a new
 * `avatar_url = ${apiPaths.agentAvatar(id)}?v=${updated_at}` cache-buster;
 * invalidating the list + detail keys re-renders every consumer with the
 * new URL, which `useAgentAvatarObjectUrls` picks up via its
 * `(id, avatar_url)` cache key.
 */
export function useUploadAgentAvatar(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!agentId) throw new Error('no agent id');
      const form = new FormData();
      form.set('file', file);
      const res = await apiUpload<{ avatar_url: string; agent: AgentDto }>(
        apiPaths.agentAvatar(agentId),
        form,
      );
      return res;
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: agentKey(agentId) });
    },
  });
}

/**
 * DELETE /api/agents/:id/avatar. Idempotent on the backend — clearing
 * an already-clear pointer returns 200 with `avatar_url: null`, so the
 * renderer doesn't have to special-case "nothing to clear".
 */
export function useClearAgentAvatar(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!agentId) throw new Error('no agent id');
      const res = await api<{ agent: AgentDto }>(
        apiPaths.agentAvatar(agentId),
        { method: 'DELETE' },
      );
      return res.agent;
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: agentKey(agentId) });
    },
  });
}

export function useAgentWorkspaceTree(
  agentId: string | null,
  source: AgentWorkspaceSource = { kind: 'home' },
) {
  const scope = sourceScope(source);
  return useQuery({
    queryKey: agentId
      ? agentWorkspaceTreeKey(agentId, scope)
      : ['agents', 'none', 'workspace', 'tree'],
    enabled: !!agentId,
    queryFn: async () => {
      const query = workspaceScopeQuery(source);
      const url = query
        ? `${apiPaths.agentWorkspaceTree(agentId!)}?${query}`
        : apiPaths.agentWorkspaceTree(agentId!);
      const res = await api<{ tree: AgentWorkspaceTree }>(url);
      return res.tree;
    },
    // The tree is essentially static for the human's purposes — files
    // appear/disappear when the agent edits them via tools. 30s stale
    // window plus a manual Refresh button on the pane header.
    staleTime: 30_000,
  });
}

/**
 * Read one file by virtual path, scoped to `source` (home or a workspace L2).
 * The (scope, path) pair is the cache key suffix — switching the selected file
 * or the source is a fresh query, and React Query's structural-share keeps the
 * previous content rendered until the new one resolves so the preview never
 * blanks.
 *
 * Pass `null` path to disable the query (no file selected → preview shows an
 * empty-state).
 */
export function useAgentWorkspaceFile(
  agentId: string | null,
  source: AgentWorkspaceSource,
  path: string | null,
) {
  const scope = sourceScope(source);
  return useQuery({
    queryKey:
      agentId && path
        ? agentWorkspaceFileKey(agentId, scope, path)
        : ['agents', 'none', 'workspace', 'file'],
    enabled: !!agentId && !!path,
    queryFn: async () => {
      const params = new URLSearchParams({ path: path! });
      if (source.kind === 'workspace') {
        params.set('workspace_id', source.workspaceId);
      }
      const url = `${apiPaths.agentWorkspaceFile(agentId!)}?${params.toString()}`;
      const res = await api<{ file: AgentWorkspaceFileRead }>(url);
      return res.file;
    },
    staleTime: 30_000,
  });
}

export function useAgentRuntimeState(agentId: string | null) {
  return useQuery({
    queryKey: agentId
      ? agentRuntimeStateKey(agentId)
      : ['agents', 'none', 'runtime-state'],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<AgentRuntimeStateDto>(
        `/api/agents/${agentId}/runtime-state`,
      );
      return res;
    },
    // Status / pid change as soon as the user clicks Stop or a conversation
    // spawns, so refetch on focus + every 5s while mounted.
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
}

export function useStopAgent(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!agentId) throw new Error('no agent id');
      return api<{ stopped: number }>(`/api/agents/${agentId}/stop`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: agentRuntimeStateKey(agentId) });
    },
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      await api<void>(`/api/agents/${agentId}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentsKey });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/** Per-agent schedule list for the panel. Default filter `active`
 *  matches the common case "what does this agent still have on the
 *  books"; users can flip to `all` to inspect terminal rows.
 *
 *  Polling cadence: 30s. The scheduler tick + sweep operate at 60s,
 *  so 30s gives at-most-30s lag between a fire and the row's
 *  fired_count / next_fire_at refreshing in the UI without burning
 *  HTTP traffic on the much slower human read cadence. */
export function useAgentSchedules(
  agentId: string | null,
  status: ScheduleListStatusFilter = 'active',
) {
  return useQuery({
    queryKey: agentId
      ? agentSchedulesKey(agentId, status)
      : ['agents', 'none', 'schedules', status],
    enabled: !!agentId,
    queryFn: async () => {
      const res = await api<{ schedules: ScheduleDto[] }>(
        `${apiPaths.agentSchedules(agentId!)}?status=${status}`,
      );
      return res.schedules;
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

/** User-initiated cancel from the panel. Invalidates every status
 *  filter for the agent because the row's status is what changed —
 *  active list shrinks, cancelled list grows. */
export function useCancelAgentSchedule(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (scheduleId: string) => {
      if (!agentId) throw new Error('no agent id');
      const res = await api<{ schedule: ScheduleDto }>(
        apiPaths.agentScheduleCancel(agentId, scheduleId),
        { method: 'POST' },
      );
      return res.schedule;
    },
    onSuccess: () => {
      if (!agentId) return;
      qc.invalidateQueries({ queryKey: ['agents', agentId, 'schedules'] });
    },
  });
}
