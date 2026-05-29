/**
 * D4.a Commit 6 (3) — backend route typed-fail gate tests for the
 * `agent start` / `agent stop` paths.
 *
 * Pinned arms (canonical typed `code` field on the JSON body + HTTP
 * status). These are the response shapes the renderer / CLI branches
 * on; a regression that drops the `code` field or changes the status
 * would silently break failure UX downstream.
 *
 *   1. **`host_runtime_disabled` (HTTP 409)** — backend booted in
 *      `deploymentMode: 'standalone'` (no daemon attached at all).
 *      Triggered by the `standaloneMode(ctx)` gate at the top of
 *      `startConversationAgent` / `stopConversationAgent`, BEFORE
 *      any placement resolution runs.
 *   2. **`local_host_unbound` (HTTP 409)** — embedded backend, but
 *      the viewer has no claimed local host. Triggered from inside
 *      `placement.resolveForAgent()` (which the real
 *      `DaemonAgentRuntimeHost.start()` calls). In tests we inject
 *      it via `t.fake.startError`.
 *   3. **`host_missing` (HTTP 404)** — placement resolved a host
 *      id but the host record was deleted concurrently.
 *   4. **`host_revoked` (HTTP 409)** — host record exists but is
 *      marked revoked.
 *   5. **`host_attach_pending` (HTTP 503, NEW in this commit)** —
 *      placement resolved, but the outbound WS to the daemon is
 *      not currently attached. Pre-D4.a Commit 6 this fell through
 *      as a generic untyped `{ error: msg }, 400` — the renderer
 *      could not branch on it. Triggered by
 *      `HostWsCommandTransportError('transport_no_connection' |
 *      'transport_disconnected')`.
 *
 * Negative pin (regression bait): other `HostWsCommandTransportError`
 * codes (`transport_timeout`, `transport_send_failed`,
 * `transport_invalid_command`, `transport_response_mismatch`)
 * intentionally fall through to the generic 400 path. They carry
 * different recovery semantics and must not be collapsed into the
 * `host_attach_pending` arm; otherwise a daemon-side schema bug
 * would mask itself as a transient transport issue. Cindy 5d/6
 * boundary call.
 *
 * Routes covered (both `/api/channels/:id/agents/:aid/start|stop`
 * and `/api/threads/:id/agents/:aid/start|stop` share the same
 * handler factory):
 *   - POST `/api/channels/:id/agents/:aid/start`
 *   - POST `/api/channels/:id/agents/:aid/stop`
 *
 * This is the D4.a Commit 6 "G1 typed-fail" gate Cindy required:
 * "agent spawn / wake / stop 在 no-host-attached / standalone G1 下
 * 返回 typed body，不 500 / 不 hang / 不 silent noop".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeHostPlacementError } from '../../src/host-placement-errors.js';
import { HostWsCommandTransportError } from '../../src/ws/host-ws-server.js';
import {
  ClearSessionExitTimeoutError,
  ClearSessionInProgressError,
} from '../../src/runtime/agent-runtime-host.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function createChannelWithAgent(
  t: TestApp,
): Promise<{ channelId: string; agentId: string }> {
  const agent = await (
    await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
  ).json() as { agent: { id: string } };
  const ws = await (
    await http(t).post('/api/workspaces', {
      name: `ws-${crypto.randomUUID().slice(0, 8)}`,
      member_agent_ids: [agent.agent.id],
    })
  ).json() as { onboarding_channel_id: string };
  t.fake.starts = [];
  t.fake.stops = [];
  t.fake.delivered = [];
  return { channelId: ws.onboarding_channel_id, agentId: agent.agent.id };
}

describe('agent start/stop — typed-fail gate (D4.a Commit 6 G1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  describe('host_runtime_disabled (standalone backend, 409) — REMOVED in D4.b P1-1', () => {
    // The blanket `standaloneMode(ctx)` guard on `start` / `stop`
    // was lifted in D4.b P1-1. Pre-D4.b the route returned a 409
    // `host_runtime_disabled` BEFORE placement resolved; post-lift
    // standalone + attached daemon goes through the same
    // `ctx.runtimeHost` path as embedded and standalone + no
    // daemon returns typed `host_attach_pending` (503) via
    // `OutboundRuntimeEventFanout.connectedConnectionId` →
    // `HostWsCommandTransportError('transport_no_connection')` →
    // `mapTransportErrorToPlacement`.
    //
    // Negative coverage for "real standalone, no daemon" is in
    // `packages/backend/tests/e2e/standalone-g2-route-runtime.test.ts`
    // because the typed error requires the real
    // `OutboundRuntimeEventFanout`, not the unit fake. The
    // happy-path "fake handles the call" arm below already pins
    // that `t.fake.starts` receives the call regardless of
    // `deploymentMode`.
    it.skip('removed — see G2 route e2e for the typed_attach_pending negative', () => {});
  });

  describe('local_host_unbound (no claimed host, 409)', () => {
    it('start → local_host_unbound (409) via placement error injected through runtimeHost', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      // Simulate the placement resolver throwing — that's exactly
      // what the real DaemonAgentRuntimeHost.start() does when the
      // viewer has no claimed local host.
      t.fake.startError = new RuntimeHostPlacementError(
        'local_host_unbound',
        'user has no owned local host',
      );
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/start`,
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('local_host_unbound');
    });
  });

  describe('host_missing (concurrent host delete, 404)', () => {
    it('start → host_missing (404)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.startError = new RuntimeHostPlacementError(
        'host_missing',
        'host record deleted',
      );
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/start`,
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('host_missing');
    });
  });

  describe('host_revoked (host marked revoked, 409)', () => {
    it('start → host_revoked (409)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.startError = new RuntimeHostPlacementError(
        'host_revoked',
        'host has been revoked',
      );
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/start`,
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('host_revoked');
    });
  });

  describe('host_attach_pending (NEW in D4.a Commit 6, 503)', () => {
    it('start → host_attach_pending (503) when transport_no_connection fires after placement resolves', async () => {
      // Pre-D4.a Commit 6 this case returned a generic untyped
      // `{ error: msg }` with status 400 — the renderer could not
      // distinguish it from any other 400 bad-request. The fix is a
      // narrow promotion in `placementErrorResponse` /
      // `mapTransportErrorToPlacement` of the
      // `transport_no_connection` arm to a typed
      // `host_attach_pending` placement-error code with HTTP 503
      // (transient service unavailable).
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.startError = new HostWsCommandTransportError(
        'transport_no_connection',
        `host h1 is not connected to outbound websocket`,
        { hostId: 'h1', commandKind: 'runtime_start' },
      );
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/start`,
      );
      expect(res.status).toBe(503);
      const body = await res.json() as { code: string; error: string };
      expect(body.code).toBe('host_attach_pending');
      // Error message includes the hostId so an operator can grep
      // the log → response correlation.
      expect(body.error).toContain('h1');
    });

    it('start → host_attach_pending (503) when transport_disconnected fires mid-dispatch', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.startError = new HostWsCommandTransportError(
        'transport_disconnected',
        `host h2 websocket connection changed before runtime_start`,
        { hostId: 'h2', commandKind: 'runtime_start' },
      );
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/start`,
      );
      expect(res.status).toBe(503);
      const body = await res.json() as { code: string; error: string };
      expect(body.code).toBe('host_attach_pending');
      expect(body.error).toContain('h2');
    });

    it('stop → host_attach_pending (503) when transport_no_connection fires after placement resolves', async () => {
      // Symmetric coverage: stop path uses the same
      // placementErrorResponse helper, so transport-promotion
      // must apply identically.
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      // Need a synthetic stop error; the FakeConversationManager
      // doesn't have a `stopError` field, so we monkey-patch the
      // method for this test alone.
      t.fake.stop = async () => {
        throw new HostWsCommandTransportError(
          'transport_no_connection',
          `host h3 is not connected to outbound websocket`,
          { hostId: 'h3', commandKind: 'runtime_stop' },
        );
      };
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/stop`,
      );
      expect(res.status).toBe(503);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('host_attach_pending');
    });
  });

  describe('non-promoted transport codes (regression bait — must NOT collapse into host_attach_pending)', () => {
    // Cindy 5d/6 review boundary: don't widen the promotion gate to
    // every HostWsCommandTransportError. These four arms have
    // different recovery semantics and should fall through to the
    // generic 400 path so callers don't retry-on-pending forever
    // when the underlying problem is e.g. a payload schema bug.
    const otherCodes = [
      'transport_timeout',
      'transport_send_failed',
      'transport_invalid_command',
      'transport_response_mismatch',
    ] as const;

    for (const code of otherCodes) {
      it(`start → generic 400 (NOT host_attach_pending) for transport code "${code}"`, async () => {
        t = buildTestApp();
        const { channelId, agentId } = await createChannelWithAgent(t);
        t.fake.startError = new HostWsCommandTransportError(
          code,
          `synthetic ${code}`,
          { hostId: 'hX', commandKind: 'runtime_start' },
        );
        const res = await http(t).post(
          `/api/channels/${channelId}/agents/${agentId}/start`,
        );
        // Must NOT be 503 / host_attach_pending.
        expect(res.status).not.toBe(503);
        // Generic fallback is the existing pre-Commit 6 behavior:
        // `{ error: msg }` at 400, no `code` field. Keep that
        // explicit so a future refactor that auto-adds `code` to
        // every error fails this test loud.
        expect(res.status).toBe(400);
        const body = await res.json() as { code?: string; error: string };
        expect(body.code).toBeUndefined();
        expect(body.error).toContain(code);
      });
    }
  });

  describe('happy path still works (sanity)', () => {
    it('start with no injected error → 200 + fake.starts gets the call', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/start`,
      );
      expect(res.status).toBe(200);
      expect(t.fake.starts).toEqual([{ conversationId: channelId, agentId }]);
    });
  });

  describe('bulk stop POST /api/agents/:id/stop — typed aggregation (Cindy round-2 P1)', () => {
    /**
     * Pre-fix the bulk-stop route swallowed every per-conversation
     * stop error with `.catch(warn)` and returned `{ stopped: live.length }`
     * regardless of whether ANY underlying stop succeeded. In
     * standalone + no-daemon, every call throws typed
     * `HostWsCommandTransportError('transport_no_connection')`, so the
     * route's response was a silent 200 — exactly the "no silent
     * no-op" arm D4 forbids.
     *
     * Post-fix:
     *   - 0 live conversations → 200 `{ stopped: 0 }` (true no-op,
     *     not failure-shaped).
     *   - All live stops fail with a typed transport/placement error
     *     → surface that error via `placementErrorResponse` (503
     *     `host_attach_pending` etc.).
     *   - All live stops succeed → 200 `{ stopped: <count> }`.
     *
     * Tested via direct DB seed to bypass the conversation creation
     * routes (and put rows in `status='active'` so the bulk path
     * actually iterates).
     */

    async function seedActiveConversation(
      t: TestApp,
      channelId: string,
      agentId: string,
    ): Promise<void> {
      t.ctx.db
        .prepare(
          `UPDATE conversation_agents
              SET status = 'active', pid = 12345
            WHERE conversation_id = ? AND agent_id = ?`,
        )
        .run(channelId, agentId);
    }

    it('all live stops failing with transport_no_connection → 503 host_attach_pending (NOT silent 200)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      await seedActiveConversation(t, channelId, agentId);
      t.fake.stop = async () => {
        throw new HostWsCommandTransportError(
          'transport_no_connection',
          `host h-bulk is not connected to outbound websocket`,
          { hostId: 'h-bulk', commandKind: 'runtime_stop' },
        );
      };
      const res = await http(t).post(`/api/agents/${agentId}/stop`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; error: string; stopped?: number };
      expect(body.code).toBe('host_attach_pending');
      // Regression bait: pre-fix this returned 200 `{ stopped: 1 }`.
      expect(res.status).not.toBe(200);
    });

    it('all live stops failing with local_host_unbound → 409 typed', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      await seedActiveConversation(t, channelId, agentId);
      t.fake.stop = async () => {
        throw new RuntimeHostPlacementError(
          'local_host_unbound',
          'no claimed local host',
        );
      };
      const res = await http(t).post(`/api/agents/${agentId}/stop`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('local_host_unbound');
    });

    it('no live conversations → 200 { stopped: 0 } (true no-op, fake.stop never called)', async () => {
      t = buildTestApp();
      const { agentId } = await createChannelWithAgent(t);
      // Don't seed active — the channel's conversation_agents row
      // remains in 'idle' so the bulk path's filter excludes it.
      let stopCalled = false;
      t.fake.stop = async () => {
        stopCalled = true;
      };
      const res = await http(t).post(`/api/agents/${agentId}/stop`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stopped: number };
      expect(body.stopped).toBe(0);
      expect(stopCalled).toBe(false);
    });

    it('all live stops succeed → 200 { stopped: <count> } (happy path)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      await seedActiveConversation(t, channelId, agentId);
      // Default fake.stop succeeds and records into t.fake.stops.
      const res = await http(t).post(`/api/agents/${agentId}/stop`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stopped: number };
      expect(body.stopped).toBe(1);
      expect(t.fake.stops).toHaveLength(1);
      expect(t.fake.stops[0]!.conversationId).toBe(channelId);
      expect(t.fake.stops[0]!.mode).toBe('hard');
    });
  });

  describe('clear-session POST /api/channels/:id/agents/:aid/clear-session — D4.c C7', () => {
    /**
     * D4.c C7 lifted the standalone guard. The route now delegates
     * to `runtimeHost.clearSession`, which (in the standalone
     * fanout) dispatches `runtime_clear_session` over the outbound
     * WS, bounded-waits for `runtime_exit` projection landed, and
     * commits the audit + cli_session_id clear in one DB tx.
     *
     * Three new typed-error arms the route promotes:
     *   - `HostWsCommandTransportError('transport_no_connection')`
     *     → 503 `host_attach_pending` (placement-error fall-through).
     *   - `ClearSessionExitTimeoutError` → 503 `clear_session_timeout`
     *     (route-local; intentionally NOT in the placement taxonomy
     *     per Cindy `nPqEVJjCLjuNDH-6` constraint #1).
     *   - `ClearSessionInProgressError` → 409
     *     `clear_session_in_progress` (route-local; concurrent
     *     same-(cid, aid) is misuse, not a coordination hazard).
     *
     * `t.fake.clearError` is the injection knob (mirrors
     * `t.fake.startError`); the fake's `clearedSessions` recorder
     * stays untouched on the error arms because the fake throws
     * before recording.
     */

    it('no daemon attached → 503 host_attach_pending (typed)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.clearError = new HostWsCommandTransportError(
        'transport_no_connection',
        'no live outbound WS for host local',
        { hostId: 'local', commandKind: 'runtime_clear_session' },
      );
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/clear-session`,
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('host_attach_pending');
      expect(t.fake.clearedSessions).toHaveLength(0);
    });

    it('runtime_exit projection times out → 503 clear_session_timeout (route-local typed)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.clearError = new ClearSessionExitTimeoutError(channelId, agentId);
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/clear-session`,
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('clear_session_timeout');
      // Regression bait — must NOT collapse into placement taxonomy.
      expect(body.code).not.toBe('host_attach_pending');
      expect(t.fake.clearedSessions).toHaveLength(0);
    });

    it('concurrent same-(cid, aid) → 409 clear_session_in_progress (route-local typed)', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      t.fake.clearError = new ClearSessionInProgressError(channelId, agentId);
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/clear-session`,
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('clear_session_in_progress');
      expect(t.fake.clearedSessions).toHaveLength(0);
    });

    it('embedded backend (happy path) → 200 + fake.clearedSessions recorded', async () => {
      t = buildTestApp();
      const { channelId, agentId } = await createChannelWithAgent(t);
      const res = await http(t).post(
        `/api/channels/${channelId}/agents/${agentId}/clear-session`,
      );
      expect(res.status).toBe(200);
      expect(t.fake.clearedSessions).toHaveLength(1);
      expect(t.fake.clearedSessions[0]!.conversationId).toBe(channelId);
      expect(t.fake.clearedSessions[0]!.agentId).toBe(agentId);
    });
  });

  // D4.d D3 — POST /api/agents standalone gate REMOVED. The route now
  // dispatches the `agent_materialize` wire intent in both deployment
  // modes (R4 invariant: handlers do not fork by deployment). When the
  // outbound controller is not installed (or has no live attachment),
  // the route returns 503 `host_attach_pending` — same shape as D4.b
  // runtime intents.
  //
  // Cindy D3 round-1 P1 §6.2 invariant: the online check fires BEFORE
  // L1 reserve, so a daemon-offline scenario must NOT leak an agent
  // row at all (the prior "reserve then flip to failed" was wrong).
  // This test pins both halves: 503 response shape + zero new rows.
  describe('POST /api/agents — daemon offline (fail-fast, NO reserve)', () => {
    it('no live host controller → 503 host_attach_pending + agent count UNCHANGED', async () => {
      t = buildTestApp({
        deploymentMode: 'standalone',
        // Force the "no controller installed" branch — same observable
        // surface a real standalone deployment with the daemon offline
        // would show.
        hostWsController: () => null,
      });
      const agentCountBefore = t.ctx.db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
        .get()!.c;

      const res = await http(t).post('/api/agents', {
        name: `d3-daemon-offline-${Date.now()}`,
        runtime: 'claude',
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; error?: string };
      expect(body.code).toBe('host_attach_pending');

      // Cindy D3 round-1 P1 — §6.2: online check runs BEFORE
      // reserve, so daemon-offline MUST leave the agents table
      // untouched. Pin both total count AND that no
      // pending/failed/active row was orphaned for this name.
      const agentCountAfter = t.ctx.db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
        .get()!.c;
      expect(agentCountAfter).toBe(agentCountBefore);
      const orphans = t.ctx.db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM agents
            WHERE name LIKE 'd3-daemon-offline-%'`,
        )
        .get()!.c;
      expect(orphans).toBe(0);
    });
  });
});
