/**
 * D4.b-2 — Standalone G2 runtime_start dispatch + session_init
 * projection e2e.
 *
 * **What this test pins (Cindy `_5NUY2CzOF9N80pM` boundary #3:
 * "B2/B3/B4 must pin backend-visible observable")**: a
 * `runtime_start` issued through the production
 * `ctx.runtimeHost.start(...)` → `ControlPlaneRuntimeHost` →
 * `OutboundRuntimeEventFanout.startDeliveryBacked` →
 * `HostWsServerController.sendCommand` pipeline really crosses the
 * outbound WS, lands in the real daemon `IntentDispatcher`, drives
 * the real `Supervisor` to spawn the fixture child, and the
 * resulting `session_init` parsed event makes it all the way back
 * to **backend-observable state**:
 *
 *   1. `conversation_agents.cli_session_id` = the sessionId the
 *      driver parsed out of the child's stdout (DB write via
 *      `StatusProjector.sessionInit`).
 *   2. `conversation_agents.status` = `'active'` (same projection).
 *   3. The wrapped sink captured a `runtime_parsed_event` frame
 *      whose `parsed.kind === 'session_init'` and whose
 *      `parsed.sessionId` matches the same value — i.e. the
 *      protocol object on the wire matches the DB write.
 *
 * **Cindy boundary lock recap**:
 *   - #1 real listener / WS / HostClient / dispatcher / fanout —
 *     `runDaemon` is the production daemon launcher; the only fake
 *     here is the runtime driver (a `Driver` stub whose
 *     `parseLine` interprets a sentinel stdout line as
 *     `session_init`). The fixture binary is the production
 *     `echo-runtime.cjs` script the host supervisor tests use.
 *   - #2 parity claim compares protocol objects only — we assert
 *     on the **normalized parsed event object** the schema produces
 *     (`{kind:'session_init', sessionId}`), not on transport bytes.
 *     Same `OutboundDaemonToServerEventFrameSchema` parse path the
 *     production `HostWsConnection.onMessage` runs.
 *   - #3 backend-visible observable pinned — DB row + ScopeEventBus
 *     event + captured frame (three independent observations of the
 *     same projection).
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: the daemon's Unix socket sits idle; no
 * `HostClient` connects to it. The entire test exercises the
 * server↔daemon outbound WS path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Driver, DriverSpawnContext, ParsedEvent } from '@silverhand/host/drivers';
import type { RuntimeKind } from '@silverhand/shared';
import { conversationSideScope } from '@silverhand/shared';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import {
  assertOutboundAdapterWired,
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

/**
 * The sentinel stdout line the fixture binary emits and the fake
 * driver interprets as `session_init`. Production drivers parse
 * runtime-specific protocol lines (e.g. claude's stream-json
 * `system.init` frame); the harness fakes this with a fixed
 * prefix-marker so the test stays driver-agnostic.
 */
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
      // emit the session_init sentinel right after READY so the
      // supervisor's stdout pump sees the line and routes it through
      // our `parseLine`.
      '--emit-line',
      `${SESSION_PREFIX}${sessionId}`,
      // accept startup_delivery writes on stdin without crashing —
      // they get echoed back as `STDIN:<...>` which `parseLine`
      // ignores.
      '--echo-stdin',
    ],
    applyEnv: env => ({ ...env }),
    // Minimal stream-json-shaped stdin encoder. Supervisor uses this
    // for the startup_delivery write; the fixture's `--echo-stdin`
    // just bounces it back as a STDIN: line.
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

describe('Standalone G2 — runtime_start dispatch + session_init projection', () => {
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

  it('runtimeHost.start triggers daemon spawn → session_init flows back through the real fanout → cli_session_id lands in conversation_agents', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;

    // Seed minimum DB rows for a (workspace, agent, conversation,
    // conversation_agents) triple owned by user 'local' (the
    // harness's seeded user). Membership rows are inserted
    // explicitly because the standalone backend boot does NOT
    // install the test-only fixture triggers from `openTestDb`.
    const now = Date.now();
    const workspaceId = 'ws-g2-b2';
    const agentId = 'agent-g2-b2';
    const conversationId = 'conv-g2-b2';
    const expectedSessionId = `g2-b2-session-${now}`;
    // Supervisor sets `cwd: spawnCtx.workspacePath` on the spawn —
    // an inexistent dir causes ENOENT before the binary runs and
    // the error surfaces as `runtime_start: child spawned without
    // a pid`. Use a real dir under the harness's temp tree so the
    // single `rmSync(tempDir)` teardown still covers it.
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-b2-workspace', now, now);
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
      'agent-g2-b2-name',
      harness.hostId,
      now,
      now,
      'Agent G2 B2',
      harness.userId,
    );
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(workspaceId, agentId, now);

    db.prepare(
      `INSERT INTO conversations
        (id, workspace_id, kind,
title, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
        VALUES (?, ?, 'channel', ?, 'active', NULL, NULL, NULL,
                NULL, ?, ?)`,
    ).run(conversationId, workspaceId, 'g2-b2-channel', now, now);
    db.prepare(
      `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(conversationId, harness.userId, now);
    db.prepare(
      `INSERT INTO conversation_agents
        (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
        VALUES (?, ?, NULL, NULL, 'idle', ?)`,
    ).run(conversationId, agentId, now);

    // Seed a single inbox row so `startDeliveryBacked` has work to
    // do (otherwise it returns false and `runtimeHost.start` throws
    // `host_runtime_disabled`).
    const messageId = 'msg-g2-b2';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(messageId, conversationId, harness.userId, 'hello, agent', now);
    const inboxRepo = new ConversationInboxRepo(db);
    inboxRepo.enqueue(conversationId, agentId, messageId);

    // Boot the in-process daemon with a real Supervisor wired to
    // the fake session_init driver + fixture binary.
    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(expectedSessionId),
    });

    // Wait for the daemon to attach to the backend (B1 invariant —
    // here we re-use it to make sure the test does not race the
    // outbound WS handshake).
    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId);
    // #task:1612 — model creation-time realization on the real daemon
    // (the spawn path no longer provisions).
    await assertOutboundAdapterWired(harness.backend);

    // Observable #3 (Cindy P1 follow-up `OvXzRQmTQ6dSw7nU`):
    // subscribe to the real `ScopeEventBus` BEFORE issuing the
    // intent so we catch the `agent_status` publish from
    // `StatusProjector.sessionInit`. This is the renderer-visible
    // half of the projection — DB writes alone don't prove the
    // event bus published, and a future regression that updates
    // the DB but skips `events.publish(...)` would silently break
    // remote-runtime UI updates without this assertion.
    const busEvents: Array<{ kind: string; payload: unknown }> = [];
    // Stage-2 P2: `agent_status` moved to the side-channel scope; capture it
    // there (compat `subscribe()` only carries message-stream `publish()`).
    const unsubscribe = harness.backend.context.events.subscribeScope(
      conversationSideScope(conversationId),
      event => {
        busEvents.push(event);
      },
    );

    try {
      // Production trigger: same call path the delivery-coordinator
      // takes in production. `start` → `startDeliveryBacked` claims
      // the pending inbox row, builds a `RuntimeStartParams` from
      // workspace/agent/conversation DB state, and dispatches
      // `runtime_start` over the outbound WS.
      await harness.backend.context.runtimeHost.start(conversationId, agentId);

      // Observable #1: the captured `runtime_parsed_event` frame
      // round-tripped through the real fanout. We assert on the
      // normalized object the schema parsed (Cindy boundary #2 —
      // protocol objects, not transport bytes).
      const captured = await waitFor(
        () =>
          harness!.events.find(
            e =>
              e.frame.kind === 'runtime_parsed_event' &&
              e.frame.parsed.kind === 'session_init' &&
              e.frame.parsed.sessionId === expectedSessionId,
          ) ?? null,
        { timeoutMs: 10_000, label: 'session_init parsed event' },
      );
      expect(captured.hostId).toBe(harness.hostId);
      expect(captured.frame.kind).toBe('runtime_parsed_event');
      if (captured.frame.kind !== 'runtime_parsed_event') {
        throw new Error('frame.kind narrowing failed');
      }
      expect(captured.frame.conversation_id).toBe(conversationId);
      expect(captured.frame.agent_id).toBe(agentId);
      expect(captured.frame.parsed).toEqual({
        kind: 'session_init',
        sessionId: expectedSessionId,
      });

      // Observable #2: the DB projection landed. This is the
      // load-bearing assertion for backend-visible state (Cindy
      // boundary #3) — without this row update the renderer /
      // future delivery paths can't know the runtime is live.
      const sessionRow = await waitFor(
        () => {
          const row = db
            .prepare<[string, string], { status: string; cli_session_id: string | null }>(
              `SELECT status, cli_session_id
                 FROM conversation_agents
                WHERE conversation_id = ? AND agent_id = ?`,
            )
            .get(conversationId, agentId);
          if (!row) return null;
          if (row.cli_session_id !== expectedSessionId) return null;
          return row;
        },
        { timeoutMs: 10_000, label: 'conversation_agents.cli_session_id projection' },
      );
      expect(sessionRow.status).toBe('active');
      expect(sessionRow.cli_session_id).toBe(expectedSessionId);

      // Observable #3 assertion: ScopeEventBus published the
      // renderer-visible `agent_status` event. Cindy P1: a
      // regression where the projector writes the DB but forgets
      // `events.publish(...)` would leave observation #2 green
      // while remote-runtime UI silently breaks. Pin payload
      // shape (`agent_id`, `status='active'`, `cli_session_id`)
      // explicitly so a partial publish (e.g. status without
      // cli_session_id) also fails loud.
      const agentStatusEvent = await waitFor(
        () => {
          const candidate = busEvents.find(e => {
            if (e.kind !== 'agent_status') return false;
            const payload = e.payload as
              | { agent_id?: unknown; status?: unknown; cli_session_id?: unknown }
              | null;
            if (!payload) return false;
            return (
              payload.agent_id === agentId &&
              payload.status === 'active' &&
              payload.cli_session_id === expectedSessionId
            );
          });
          return candidate ?? null;
        },
        { timeoutMs: 10_000, label: 'agent_status bus event' },
      );
      const payload = agentStatusEvent.payload as {
        agent_id: string;
        status: string;
        cli_session_id: string;
      };
      expect(payload.agent_id).toBe(agentId);
      expect(payload.status).toBe('active');
      expect(payload.cli_session_id).toBe(expectedSessionId);
    } finally {
      unsubscribe();
    }
  });
});
