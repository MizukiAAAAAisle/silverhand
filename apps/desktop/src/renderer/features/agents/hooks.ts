import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDto,
  AgentRuntimeStateDto,
  AgentWorkspaceFileRead,
  AgentWorkspaceTree,
  CreateAgentInput,
  McpProbeRequest,
  McpProbeResult,
  ScheduleDto,
  ScheduleListStatusFilter,
  UpdateAgentInput,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api, apiUpload, ApiError } from '@/lib/api';

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
        agent_home_workspace_id: string;
        dm_channel_id: string;
        onboarding_message_id: string;
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
