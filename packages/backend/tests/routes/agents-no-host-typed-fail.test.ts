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
});
