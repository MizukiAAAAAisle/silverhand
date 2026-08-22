/**
 * Standalone deployment — route-level runtime e2e.
 *
 * Origin: D4.b P1-1 (G2). Closes the gap Cindy `wY_2I5y4l-FXO19h`
 * called out: the B1-B6 batch only exercised `ctx.runtimeHost`
 * directly, so the public HTTP surface still went through the D4.a
 * blanket `standaloneMode(ctx)` guard and would return 409
 * `host_runtime_disabled` for the user-facing user path. This test
 * pins the user path through real HTTP against the real backend:
 *
 *   1. **POST `/api/channels/:id/agents/:aid/start`** lands a
 *      `session_init` projection in DB exactly the same way the
 *      direct `runtimeHost.start` call did in B2.
 *   2. **POST `/api/channels/:id/messages`** writes the user
 *      message and triggers a live delivery — `conversation_inboxes`
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
import { SqliteAuthSessionsRepo } from '../../src/repos/auth-sessions-repo.js';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { HostClient, type RuntimeStatusResult } from '@silverhand/host';
import type { Driver, DriverSpawnContext, ParsedEvent } from '@silverhand/host/drivers';
import type { RuntimeKind } from '@silverhand/shared';
import { fixedConversationTitle } from '@silverhand/shared';
import { AuthSessionService } from '../../src/auth/session.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import {
  assertOutboundAdapterWired,
  bootDesktopSupervisedDaemon,
  bootDaemonWithSupervisor,
  bootG2Harness,
  waitFor,
  waitForAttachment,
  type DaemonWithSupervisorHandle,
  type DesktopSupervisedDaemonHandle,
  type G2Harness,
} from './g2-harness.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

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
    releaseProfile: 'native-steer',
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
async function seedRouteEnv(harness: G2Harness, suffix: string): Promise<RouteEnv> {
  const { db } = harness.backend.context;
  const now = Date.now();
  const workspaceId = `ws-g2-route-${suffix}`;
  const agentId = `agent-g2-route-${suffix}`;
  // Minted with the production generator, not a readable suffix
  // (#task:2021 P4-3): a delivery header renders this id as the stream's
  // absolute `target`, whose domain is exactly 16 base64url chars. The
  // run-distinguishing suffix stays on the channel's NAME below.
  const conversationId = randomBytes(12).toString('base64url');
  const sessionId = `g2-route-${suffix}-${now}`;
  const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
  mkdirSync(workspacePath, { recursive: true });

  db.prepare(
    `INSERT INTO workspaces
      (id, name, name_key, description,
       owner_agent_id, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    workspaceId,
    `g2-route-${suffix}-workspace`,
    `g2-route-${suffix}-workspace`,
    now,
    now,
  );
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
  // The channel's TITLE IS ITS ADDRESS since #task:2016 — key from the one
  // canonicalizer, never a hand-folded literal.
  const channelTitle = fixedConversationTitle(`g2-route-${suffix}-channel`);
  db.prepare(
    `INSERT INTO conversations
      (id, workspace_id, placement_kind, roster_policy,
       title, title_key, status, spawned_by_agent_id, closed_at, close_summary,
       pinned_at, created_at, updated_at)
      VALUES (?, ?, 'workspace', 'open', ?, ?, 'active', NULL, NULL, NULL,
              NULL, ?, ?)`,
  ).run(
    conversationId,
    workspaceId,
    channelTitle.title,
    channelTitle.key,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(conversationId, harness.userId, now);
  db.prepare(
    `INSERT INTO conversation_agents
      (conversation_id, agent_id, joined_at)
     VALUES (?, ?, ?)`,
  ).run(conversationId, agentId, now);

  // Mint a real bearer via the same `AuthSessionService` the
  // production `/auth/login` path uses, so HTTP requests carry the
  // canonical user-token bearer the route gates expect.
  const { userToken } = new AuthSessionService(new SqliteAuthSessionsRepo(db)).issueSession({
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
      ...CURRENT_DESKTOP_EPOCH_HEADERS,
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

  it('HTTP start → session_init projection; HTTP send → live delivery delivered_at; HTTP stop → runtime_exit (all via real routes)', async () => {
    harness = await bootG2Harness();
    const env = await seedRouteEnv(harness, 'happy');
    const { db } = harness.backend.context;

    // Seed one pending inbox row pre-start so the lifted route's
    // `runtimeHost.start` → `startDeliveryBacked` path has work to
    // do — the production daemon-spawn path uses `startup_delivery`
    // to drain the inbox in the same RPC that spawns. Use the message
    // repo so seq allocation and stream heads stay in sync before the
    // later route-level send inserts another message.
    const preStartMessage = new MessageRepo(db).insertForConversation({
      conversationId: env.conversationId,
      fromKind: 'user',
      fromUserId: harness.userId,
      content: 'pre-start startup_delivery',
    });
    new ConversationInboxRepo(db).enqueue(
      env.conversationId,
      env.agentId,
      preStartMessage.id,
    );

    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(env.sessionId),
    });

    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId);
    // #task:1612 — model creation-time realization on the real daemon
    // (the spawn path no longer provisions). The nodaemon arms skip this:
    // their routes fail on transport before touching the registry.
    await assertOutboundAdapterWired(harness.backend);

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
            `SELECT cli_session_id, observed_status AS status FROM agent_runtime_slots
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(env.conversationId, env.agentId);
        if (!row || row.cli_session_id !== env.sessionId) return null;
        if (row.status !== 'active') return null;
        return true;
      },
      { timeoutMs: 10_000, label: 'HTTP start → session_init projection' },
    );

    // ── Phase 2: HTTP POST messages → live delivery ─────────────────
    //
    // The lifted send-to-agent-backed route enters
    // `conversationMessageService.sendMessage` which calls
    // `runtimeHost.deliverMessage` per agent (best-effort). With
    // the daemon attached, deliverMessage's `live delivery` path runs:
    // claim pending inbox → submit live delivery batch → daemon writes
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
      {},
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
            `SELECT observed_status AS status, observed_pid AS pid, cli_session_id
               FROM agent_runtime_slots
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
    const env = await seedRouteEnv(harness, 'nodaemon');

    const { db } = harness.backend.context;
    const pendingMessage = new MessageRepo(db).insertForConversation({
      conversationId: env.conversationId,
      fromKind: 'user',
      fromUserId: harness.userId,
      content: 'must trigger transport',
    });
    new ConversationInboxRepo(db).enqueue(
      env.conversationId,
      env.agentId,
      pendingMessage.id,
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
    const env = await seedRouteEnv(harness, 'nodaemonstop');

    const res = await postJson(
      `${harness.serverUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/stop`,
      env.bearer,
      {},
    );

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'host_attach_pending' });
  });
});

describe('Daemon lifecycle isolation — public reset under Desktop supervisor', () => {
  let harness: G2Harness | null = null;
  let desktopDaemon: DesktopSupervisedDaemonHandle | null = null;
  let hostClient: HostClient | null = null;

  afterEach(async () => {
    await hostClient?.close().catch(() => undefined);
    hostClient = null;
    await desktopDaemon?.stop().catch(() => undefined);
    desktopDaemon = null;
    if (harness) {
      await harness.shutdown();
      harness = null;
    }
  });

  it('public clear-session resets only its runtime; daemon generation and sibling children stay live', async () => {
    harness = await bootG2Harness({ assertIsolation: true });
    const target = await seedRouteEnv(harness, 'isolation-target');
    const siblingA = await seedRouteEnv(harness, 'isolation-sibling-a');
    const siblingB = await seedRouteEnv(harness, 'isolation-sibling-b');
    const envs = [target, siblingA, siblingB];
    const inbox = new ConversationInboxRepo(harness.backend.context.db);
    const runtimeSlots = new RuntimeSlotRepo(harness.backend.context.db);

    for (const env of envs) {
      const message = new MessageRepo(harness.backend.context.db)
        .insertForConversation({
          conversationId: env.conversationId,
          fromKind: 'user',
          fromUserId: harness.userId,
          content: `boot ${env.agentId}`,
        });
      inbox.enqueue(env.conversationId, env.agentId, message.id);
    }

    desktopDaemon = await bootDesktopSupervisedDaemon(harness);
    const daemonPid = desktopDaemon.daemon.pid;
    hostClient = new HostClient({ socketPath: desktopDaemon.daemon.socketPath });
    await hostClient.connect();
    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId, 10_000);

    for (const env of envs) {
      const response = await postJson(
        `${harness.serverUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/start`,
        env.bearer,
        {},
      );
      expect(response.status).toBe(200);
    }

    const rowFor = (env: RouteEnv) => runtimeSlots.getConversation(
      env.conversationId,
      env.agentId,
    );

    const waitForRuntimeStatus = async (
      predicate: (snapshot: RuntimeStatusResult) => boolean,
      label: string,
    ): Promise<RuntimeStatusResult> => {
      const deadline = Date.now() + 10_000;
      let last: RuntimeStatusResult = { runtimes: [] };
      while (Date.now() < deadline) {
        last = await hostClient!.runtimeStatus();
        if (predicate(last)) return last;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(
        `${label} timed out: ${JSON.stringify({
          last,
          rows: envs.map(rowFor),
          events: harness!.events.slice(-20).map(event => event.frame.kind),
          daemonPid: desktopDaemon!.daemon.pid,
          generations: desktopDaemon!.generationChanges,
        })}`,
      );
    };
    const initial = await waitForRuntimeStatus(
      snapshot => envs.every(env =>
        snapshot.runtimes.some(runtime =>
          runtime.agent_id === env.agentId
          && runtime.pid !== null
          && runtime.phase === 'ready',
        ),
      ),
      'three fake runtime children ready',
    );
    const pidFor = (snapshot: RuntimeStatusResult, env: RouteEnv): number => {
      const pid = snapshot.runtimes.find(runtime => runtime.agent_id === env.agentId)?.pid;
      if (pid == null) throw new Error(`runtime pid missing for ${env.agentId}`);
      return pid;
    };
    const targetPid = pidFor(initial, target);
    const siblingAPid = pidFor(initial, siblingA);
    const siblingBPid = pidFor(initial, siblingB);

    const clear = await postJson(
      `${harness.serverUrl}/api/channels/${target.conversationId}/agents/${target.agentId}/clear-session`,
      target.bearer,
      {},
    );
    expect(clear.status).toBe(200);

    await waitFor(
      () => {
        const row = rowFor(target);
        return row?.observed_pid === null && row.cli_session_id === null
          ? row
          : null;
      },
      { timeoutMs: 10_000, label: 'target runtime clear projection' },
    );

    expect(desktopDaemon.daemon.pid).toBe(daemonPid);
    expect(desktopDaemon.generationChanges).toEqual([]);
    const afterClear = await hostClient.runtimeStatus();
    expect(
      afterClear.runtimes.find(runtime => runtime.agent_id === target.agentId),
    ).toMatchObject({ phase: 'exited', pid: null });
    expect(pidFor(afterClear, siblingA)).toBe(siblingAPid);
    expect(pidFor(afterClear, siblingB)).toBe(siblingBPid);

    for (const env of [siblingA, siblingB]) {
      const send = await postJson(
        `${harness.serverUrl}/api/channels/${env.conversationId}/messages`,
        env.bearer,
        { content: `still-live ${env.agentId}` },
      );
      expect(send.status).toBe(201);
      const messageId = (send.body.message as { id: string }).id;
      inbox.ensureDelivery(env.conversationId, env.agentId, messageId);
      await waitFor(
        () => !inbox.hasUndeliveredForPair(env.conversationId, env.agentId),
        { timeoutMs: 10_000, label: `sibling ${env.agentId} still receives` },
      );
    }

    const restart = await postJson(
      `${harness.serverUrl}/api/channels/${target.conversationId}/agents/${target.agentId}/start`,
      target.bearer,
      {},
    );
    expect(restart.status).toBe(200);
    const restarted = await waitForRuntimeStatus(
      snapshot => snapshot.runtimes.some(runtime =>
        runtime.agent_id === target.agentId
        && runtime.pid !== null
        && runtime.pid !== targetPid
        && runtime.phase === 'ready',
      ),
      'target clean-start after clear',
    );
    expect(pidFor(restarted, target)).not.toBe(targetPid);
    expect(desktopDaemon.daemon.pid).toBe(daemonPid);
    expect(desktopDaemon.generationChanges).toEqual([]);
  });

  it('pre-init, during-init, and running crashes stay scoped under the Desktop supervisor', async () => {
    harness = await bootG2Harness({ assertIsolation: true });
    const siblingA = await seedRouteEnv(harness, 'matrix-sibling-a');
    const siblingB = await seedRouteEnv(harness, 'matrix-sibling-b');
    const preInit = await seedRouteEnv(harness, 'matrix-preinit');
    const duringInit = await seedRouteEnv(harness, 'matrix-duringinit');
    const runningCrash = await seedRouteEnv(harness, 'matrix-runningcrash');
    const inbox = new ConversationInboxRepo(harness.backend.context.db);
    const seedPending = (env: RouteEnv): void => {
      const message = new MessageRepo(harness!.backend.context.db)
        .insertForConversation({
          conversationId: env.conversationId,
          fromKind: 'user',
          fromUserId: harness!.userId,
          content: `matrix boot ${env.agentId}`,
        });
      inbox.enqueue(env.conversationId, env.agentId, message.id);
    };
    for (const env of [siblingA, siblingB, preInit, duringInit, runningCrash]) {
      seedPending(env);
    }

    desktopDaemon = await bootDesktopSupervisedDaemon(harness, {
      shortWatchdogs: true,
    });
    const daemonPid = desktopDaemon.daemon.pid;
    hostClient = new HostClient({ socketPath: desktopDaemon.daemon.socketPath });
    await hostClient.connect();
    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId, 10_000);

    const start = async (env: RouteEnv): Promise<void> => {
      const response = await postJson(
        `${harness!.serverUrl}/api/channels/${env.conversationId}/agents/${env.agentId}/start`,
        env.bearer,
        {},
      );
      expect(response.status).toBe(200);
    };
    await start(siblingA);
    await start(siblingB);

    const waitForStatus = async (
      predicate: (snapshot: RuntimeStatusResult) => boolean,
      label: string,
    ): Promise<RuntimeStatusResult> => {
      const deadline = Date.now() + 10_000;
      let last: RuntimeStatusResult = { runtimes: [] };
      while (Date.now() < deadline) {
        last = await hostClient!.runtimeStatus();
        if (predicate(last)) return last;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
    };
    const pidFor = (snapshot: RuntimeStatusResult, env: RouteEnv): number => {
      const pid = snapshot.runtimes.find(runtime => runtime.agent_id === env.agentId)?.pid;
      if (pid == null) throw new Error(`runtime pid missing for ${env.agentId}`);
      return pid;
    };
    const siblingsReady = await waitForStatus(
      snapshot => [siblingA, siblingB].every(env =>
        snapshot.runtimes.some(runtime =>
          runtime.agent_id === env.agentId
          && runtime.pid !== null
          && runtime.phase === 'ready',
        ),
      ),
      'matrix siblings ready',
    );
    const siblingAPid = pidFor(siblingsReady, siblingA);
    const siblingBPid = pidFor(siblingsReady, siblingB);

    const assertSiblingTraffic = async (phase: string): Promise<void> => {
      expect(desktopDaemon!.daemon.pid).toBe(daemonPid);
      expect(desktopDaemon!.generationChanges).toEqual([]);
      const snapshot = await waitForStatus(
        status => [siblingA, siblingB].every(env =>
          status.runtimes.some(runtime =>
            runtime.agent_id === env.agentId && runtime.pid !== null,
          ),
        ),
        `${phase} siblings remain live`,
      );
      expect(pidFor(snapshot, siblingA)).toBe(siblingAPid);
      expect(pidFor(snapshot, siblingB)).toBe(siblingBPid);
      for (const env of [siblingA, siblingB]) {
        const send = await postJson(
          `${harness!.serverUrl}/api/channels/${env.conversationId}/messages`,
          env.bearer,
          { content: `${phase} sibling probe` },
        );
        expect(send.status).toBe(201);
        const messageId = (send.body.message as { id: string }).id;
        inbox.ensureDelivery(env.conversationId, env.agentId, messageId);
        await waitFor(
          () => !inbox.hasUndeliveredForPair(env.conversationId, env.agentId),
          { timeoutMs: 10_000, label: `${phase} sibling traffic ${env.agentId}` },
        );
      }
    };

    await start(preInit);
    await waitFor(
      () => harness!.events.some(event =>
        event.frame.kind === 'runtime_exit'
        && event.frame.agent_id === preInit.agentId,
      ),
      { timeoutMs: 10_000, label: 'pre-init child exit terminal' },
    );
    await assertSiblingTraffic('pre-init');

    await start(duringInit);
    await waitFor(
      () => harness!.events.some(event =>
        event.frame.kind === 'runtime_init_cooldown'
        && event.frame.agent_id === duringInit.agentId,
      ),
      { timeoutMs: 10_000, label: 'during-init retry then cooldown terminal' },
    );
    await assertSiblingTraffic('during-init');

    await start(runningCrash);
    await waitFor(
      () => harness!.events.some(event =>
        event.frame.kind === 'runtime_parsed_event'
        && event.frame.agent_id === runningCrash.agentId
        && event.frame.parsed.kind === 'session_init',
      ),
      { timeoutMs: 10_000, label: 'running crash reached session_init' },
    );
    await waitFor(
      () => harness!.events.some(event =>
        event.frame.kind === 'runtime_exit'
        && event.frame.agent_id === runningCrash.agentId,
      ),
      { timeoutMs: 10_000, label: 'running crash terminal exit' },
    );
    await assertSiblingTraffic('running');
  });
});
