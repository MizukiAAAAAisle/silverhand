/**
 * D4.b P1-1 — Standalone G2 route-level runtime e2e.
 *
 * Closes the gap Cindy `wY_2I5y4l-FXO19h` called out: the B1-B6
 * batch only exercised `ctx.runtimeHost` directly, so the public
 * HTTP surface still went through the D4.a blanket
 * `standaloneMode(ctx)` guard and would return 409
 * `host_runtime_disabled` for the user-facing user path. This test
 * pins the user path through real HTTP against the real backend:
 *
 *   1. **POST `/api/channels/:id/agents/:aid/start`** lands a
 *      `session_init` projection in DB exactly the same way the
 *      direct `runtimeHost.start` call did in B2.
 *   2. **POST `/api/channels/:id/messages`** writes the user
 *      message and triggers a live wake — `conversation_inboxes`
 *      `delivered_at` is non-null and `in_flight_owner` cleared.
 *   3. **POST `/api/channels/:id/agents/:aid/stop`** dispatches a
 *      hard stop, lands `runtime_exit`, and updates the row to
 *      `status='idle'`, `pid=NULL`, `cli_session_id` PRESERVED.
 *   4. **Negative** — backend booted without ANY daemon attached:
 *      POST start returns 503 `host_attach_pending` (typed),
 *      NOT the pre-D4.b 409 `host_runtime_disabled`, NOT a generic
 *      400/500. This is the load-bearing assertion proving the
 *      lift went through to a typed transient failure that the
 *      renderer can branch on.
 *
 * B-class deferral (Cindy P1-1 collapse): the agent / workspace /
 * channel CRUD routes still carry the `standaloneMode(ctx)` guard
 * with annotations marking them as placement/CRUD deferral — they
 * are NOT a runtime transport unavailable scenario. The test seeds
 * the workspace / agent / conversation rows directly via DB (the
 * same pattern B2-B6 use) so the user path under test isolates the
 * RUNTIME triggers (start / send / stop) on the lifted A-class
 * routes.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: same boundary lock as B1-B6.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Driver, DriverSpawnContext, ParsedEvent } from '@silverhand/host/drivers';
import type { RuntimeKind } from '@silverhand/shared';
import { AuthSessionService } from '../../src/auth/session.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import {
  bootDaemonWithSupervisor,
  bootG2Harness,
  waitFor,
  waitForAttachment,
  type DaemonWithSupervisorHandle,
  type G2Harness,
} from './g2-harness.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../host/tests/_fixtures/echo-runtime.cjs',
);

const SESSION_PREFIX = '__G2_SESSION_INIT__:';

function makeSessionInitDriver(sessionId: string): Driver {
  return {
    kind: 'claude',
    binary: FIXTURE,
    kickoffMode: 'self_inits',
    busyDeliveryMode: 'direct',
    oneShot: false,
    supportsNativeStandingPrompt: true,
    initLivenessSilenceMs: 30_000,
    initPreProtocolCapMs: 5 * 60_000,
    initPostProtocolMs: 60_000,
    buildArgs: (_ctx: DriverSpawnContext): string[] => [
      FIXTURE,
      '--emit-line',
      `${SESSION_PREFIX}${sessionId}`,
      '--echo-stdin',
    ],
    applyEnv: env => ({ ...env }),
    encodeStdinMessage: (text: string) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }),
    encodeInterruptControl: () => null,
    parseLine: (line: string): ParsedEvent[] => {
      const idx = line.indexOf(SESSION_PREFIX);
      if (idx < 0) return [];
      const sid = line.slice(idx + SESSION_PREFIX.length).trim();
      return [{ kind: 'session_init', sessionId: sid }];
    },
    classifyInitProgress: () => null,
  };
}

interface RouteEnv {
  harness: G2Harness;
  bearer: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  sessionId: string;
}

/**
 * Seed the standalone DB with the workspace / agent / channel rows
 * that the route-level user path will operate on, plus mint an
 * `auth_sessions` bearer for the harness user so HTTP requests
 * carry a real principal. The B-class CRUD routes (workspace +
 * agent + channel create) are deferred (still guarded — see
 * routes.ts annotations) so direct DB seed is the only way to get
 * these rows in place under the D4.b lift; that's the same pattern
 * B2-B6 used for runtimeHost-direct tests.
 */
function seedRouteEnv(harness: G2Harness, suffix: string): RouteEnv {
  const { db } = harness.backend.context;
  const now = Date.now();
  const workspaceId = `ws-g2-route-${suffix}`;
  const agentId = `agent-g2-route-${suffix}`;
  const conversationId = `conv-g2-route-${suffix}`;
  const sessionId = `g2-route-${suffix}-${now}`;
  const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
  mkdirSync(workspacePath, { recursive: true });

  db.prepare(
    `INSERT INTO workspaces
      (id, name, description, workspace_kind, workspace_path,
       workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
      VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
  ).run(workspaceId, `g2-route-${suffix}-workspace`, workspacePath, harness.hostId, now, now);
  db.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(workspaceId, harness.userId, now);
  db.prepare(
    `INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at,
       updated_at, display_name, reasoning_effort, fast_mode,
       created_by_user_id, avatar_storage_key, avatar_content_type)
      VALUES (?, ?, 'claude', NULL, ?, NULL, ?, ?, ?, NULL, NULL,
              ?, NULL, NULL)`,
  ).run(
    agentId,
    `agent-g2-route-${suffix}-name`,
    harness.hostId,
    now,
    now,
    `Agent G2 Route ${suffix}`,
    harness.userId,
  );
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(workspaceId, agentId, now);
  db.prepare(
    `INSERT INTO conversations
      (id, workspace_id, workspace_path, kind, parent_conversation_id,
       title, status, spawned_by_agent_id, closed_at, close_summary,
       pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, 'channel', NULL, ?, 'active', NULL, NULL, NULL,
              NULL, ?, ?)`,
  ).run(conversationId, workspaceId, workspacePath, `g2-route-${suffix}-channel`, now, now);
  db.prepare(
    `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(conversationId, harness.userId, now);
  db.prepare(
    `INSERT INTO conversation_agents
      (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
      VALUES (?, ?, NULL, NULL, 'idle', ?)`,
  ).run(conversationId, agentId, now);

  // Mint a real bearer via the same `AuthSessionService` the
  // production `/auth/login` path uses, so HTTP requests carry the
  // canonical user-token bearer the route gates expect.
  const { userToken } = new AuthSessionService(db).issueSession({
    userId: harness.userId,
  });

  return {
    harness,
    bearer: userToken,
    workspaceId,
    agentId,
    conversationId,
    sessionId,
  };
}

async function postJson(
  url: string,
  bearer: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, body: parsed };
}

describe('Standalone G2 — route-level runtime path (D4.b P1-1)', () => {
  let harness: G2Harness | null = null;
  let daemon: DaemonWithSupervisorHandle | null = null;

  afterEach(async () => {
    try {
      await daemon?.stop();
    } catch {
      // best-effort
    }
    daemon = null;
    if (harness) {
      await harness.shutdown();
      harness = null;
    }
  });

  it('HTTP start → session_init projection; HTTP send → live wake delivered_at; HTTP stop → runtime_exit (all via real routes)', async () => {
    harness = await bootG2Harness();
    const env = seedRouteEnv(harness, 'happy');
    const { db } = harness.backend.context;

    // Seed one pending inbox row pre-start so the lifted route's
    // `runtimeHost.start` → `startDeliveryBacked` path has work to
    // do — the production daemon-spawn path uses `startup_delivery`
    // to drain the inbox in the same RPC that spawns. (B2 used the
    // same pattern directly through `runtimeHost.start`; this test
    // exercises it through HTTP.)
    const preStartMsgId = `route-pre-${env.sessionId}`;
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(
      preStartMsgId,
      env.conversationId,
      harness.userId,
      'pre-start startup_delivery',
      Date.now(),
    );
    new ConversationInboxRepo(db).enqueue(
      env.conversationId,
      env.agentId,
      preStartMsgId,
    );

    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(env.sessionId),
    });

    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId);

    const baseUrl = harness.serverUrl;

    // ── Phase 1: HTTP POST start ────────────────────────────────
    //
    // The lifted route now actually reaches `ctx.runtimeHost.start`
    // → outbound dispatch → daemon supervisor spawn → fixture
    // emits `__G2_SESSION_INIT__:<sid>` → wire `runtime_parsed_event`
    // → status projector lands `cli_session_id`. Same observable
    // contract as B2 but driven through HTTP.
    const startRes = await postJson(
      `${baseUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/start`,
      env.bearer,
      {},
    );
    if (startRes.status !== 200) {
      throw new Error(
        `HTTP start unexpected status=${startRes.status} body=${JSON.stringify(startRes.body)}`,
      );
    }
    expect(startRes.body).toMatchObject({ ok: true });

    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null; status: string }>(
            `SELECT cli_session_id, status FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(env.conversationId, env.agentId);
        if (!row || row.cli_session_id !== env.sessionId) return null;
        if (row.status !== 'active') return null;
        return true;
      },
      { timeoutMs: 10_000, label: 'HTTP start → session_init projection' },
    );

    // ── Phase 2: HTTP POST messages → live wake ─────────────────
    //
    // The lifted send-to-agent-backed route enters
    // `conversationMessageService.sendMessage` which calls
    // `runtimeHost.deliverMessage` per agent (best-effort). With
    // the daemon attached, deliverMessage's `live wake` path runs:
    // claim pending inbox → submit live wake batch → daemon writes
    // to stdin → fixture echoes back. The DB observable Cindy
    // boundary #3 requires is `conversation_inboxes.delivered_at`
    // non-null + `in_flight_owner` cleared. We assert exactly
    // that, on the row HTTP POST messages just inserted.
    const sendRes = await postJson(
      `${baseUrl}/api/channels/${env.conversationId}/messages`,
      env.bearer,
      { content: 'live wake via route' },
    );
    expect(sendRes.status).toBe(201);
    const sentMessageId = (sendRes.body.message as { id: string }).id;
    expect(typeof sentMessageId).toBe('string');

    const inboxRow = await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<
            [string, string, string],
            {
              delivered_at: number | null;
              in_flight_owner: string | null;
              in_flight_at: number | null;
            }
          >(
            `SELECT delivered_at, in_flight_owner, in_flight_at
               FROM conversation_inboxes
              WHERE conversation_id = ? AND agent_id = ? AND message_id = ?`,
          )
          .get(env.conversationId, env.agentId, sentMessageId);
        if (!row) return null;
        if (row.delivered_at === null) return null;
        return row;
      },
      { timeoutMs: 10_000, label: 'HTTP send → conversation_inboxes.delivered_at' },
    );
    expect(inboxRow.delivered_at).not.toBeNull();
    expect(inboxRow.in_flight_owner).toBeNull();
    expect(inboxRow.in_flight_at).toBeNull();

    // ── Phase 3: HTTP POST stop ─────────────────────────────────
    //
    // Hard stop dispatched through the lifted route. Same
    // observable contract as B4: `runtime_exit` lands, projector
    // writes `status='idle' AND pid=NULL AND cli_session_id
    // PRESERVED`.
    const stopRes = await postJson(
      `${baseUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/stop`,
      env.bearer,
      { mode: 'hard' },
    );
    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({ ok: true });

    const postStopRow = await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<
            [string, string],
            {
              status: string;
              pid: number | null;
              cli_session_id: string | null;
            }
          >(
            `SELECT status, pid, cli_session_id
               FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(env.conversationId, env.agentId);
        if (!row) return null;
        if (row.status !== 'idle') return null;
        if (row.pid !== null) return null;
        return row;
      },
      { timeoutMs: 10_000, label: 'HTTP stop → runtime_exit DB projection' },
    );
    expect(postStopRow.status).toBe('idle');
    expect(postStopRow.pid).toBeNull();
    // Cindy `BYHZJI9ALSVmmlFr` `--resume` contract holds through
    // the HTTP path too — stop preserves cli_session_id.
    expect(postStopRow.cli_session_id).toBe(env.sessionId);
  });

  it('HTTP start with NO daemon attached → 503 host_attach_pending (typed; NOT host_runtime_disabled / 500)', async () => {
    // The harness boots the backend but we deliberately skip
    // `bootDaemonWithSupervisor` — no daemon is ever attached to
    // this backend. Pre-D4.b the blanket `standaloneMode(ctx)`
    // guard short-circuited with 409 `host_runtime_disabled`
    // ("this mode never runs agents"). Post-lift the actual
    // transport layer fires:
    //
    //   `ControlPlaneRuntimeHost.start` → projection.startDeliveryBacked
    //     → `connectedConnectionId(hostId, 'runtime_start')`
    //     → `HostWsCommandTransportError('transport_no_connection')`
    //     → `placementErrorResponse` / `mapTransportErrorToPlacement`
    //     → JSON `{ code: 'host_attach_pending', error: '...' }` (503).
    //
    // This is the load-bearing typed-fail Cindy P1-1 required —
    // the renderer can branch on the code to retry / surface a
    // distinct "daemon attaching" affordance.
    //
    // Note: `startDeliveryBacked` only dispatches when the inbox
    // has pending rows; without pending the `start` path would
    // short-circuit. We seed one pending inbox row first so the
    // transport layer actually gets called (and throws).
    harness = await bootG2Harness();
    const env = seedRouteEnv(harness, 'nodaemon');

    const { db } = harness.backend.context;
    const pendingMsgId = `pending-${env.sessionId}`;
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(
      pendingMsgId,
      env.conversationId,
      harness.userId,
      'must trigger transport',
      Date.now(),
    );
    new ConversationInboxRepo(db).enqueue(
      env.conversationId,
      env.agentId,
      pendingMsgId,
    );

    const res = await postJson(
      `${harness.serverUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/start`,
      env.bearer,
      {},
    );

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'host_attach_pending' });
    // Regression bait — the pre-D4.b code was a 409 with a
    // different code. Pin both negative arms loud so a future
    // refactor that re-adds the standaloneMode guard fails here.
    expect(res.status).not.toBe(409);
    expect(res.body.code).not.toBe('host_runtime_disabled');
    // Message includes the host id for log → response correlation
    // (D4.a Commit 6 contract).
    expect(typeof res.body.error).toBe('string');
    expect((res.body.error as string).length).toBeGreaterThan(0);
  });

  it('HTTP stop with NO daemon attached → 503 host_attach_pending (symmetric to start)', async () => {
    // Same lift contract on the stop path. The fanout's `stop()`
    // dispatches `runtime_stop` via `transport.sendCommand` which
    // throws typed `transport_no_connection` when no daemon is
    // attached → 503 `host_attach_pending`.
    harness = await bootG2Harness();
    const env = seedRouteEnv(harness, 'nodaemonstop');

    const res = await postJson(
      `${harness.serverUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/stop`,
      env.bearer,
      { mode: 'hard' },
    );

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'host_attach_pending' });
  });
});
