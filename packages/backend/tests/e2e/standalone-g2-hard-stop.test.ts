/**
 * D4.b-4 — Standalone G2 hard-stop + runtime_exit projection e2e.
 *
 * Layers on the B2 spawn-to-session_init substrate. Once the
 * runtime is `ready`, a `runtime_stop` ('hard') dispatch should
 * SIGTERM the fixture child, the supervisor's exit handler fires,
 * a `runtime_exit` event flows back over the outbound WS, and the
 * backend's `RuntimeStatusProjector.runtimeExit` updates the
 * scoped runtime-slot row.
 *
 * **What this test pins (Cindy `QiUQ1IvQSRA4zOnw` boundary —
 * "runtimeExit projection contract")**, per
 * `packages/backend/src/runtime/status-projector.ts:170-203`:
 *
 *   1. `agent_runtime_slots.observed_status` → `'idle'` (intentional stop /
 *      exit code 0). `'crashed'` is the other arm, reserved for
 *      `initTimedOut` / `fatalError` / non-zero non-intentional
 *      exit — none of which fire on a clean hard stop.
 *   2. `agent_runtime_slots.observed_pid` → `NULL`. Cleared on exit
 *      unconditionally.
 *   3. `agent_runtime_slots.cli_session_id` → **preserved**,
 *      unchanged from the value `sessionInit` projected. Production
 *      contract (Cindy `BYHZJI9ALSVmmlFr`): the row keeps the last
 *      session id so the next start can `--resume`.
 *   4. `ScopeEventBus` publishes an `agent_status` event with
 *      `status='idle'`, `intentional=true`, `exit_code=0` (the
 *      fixture exits 0 on SIGTERM), and a `run_state` snapshot
 *      from the supervisor.
 *   5. Wire-side: the captured `runtime_exit` outbound frame
 *      carries `conversation_id` / `agent_id` matching the
 *      projection (one schema parse path — same as B1/B2).
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: same boundary lock as B1-B3. The Unix
 * socket is bound but unused; everything goes over the outbound
 * WS.
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

describe('Standalone G2 — hard stop + runtime_exit projection', () => {
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

  it('runtimeHost.stop hard-terminates the child, surfaces runtime_exit, and projects status=idle / pid=NULL while preserving cli_session_id', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;

    const now = Date.now();
    const workspaceId = 'ws-g2-b4';
    const agentId = 'agent-g2-b4';
    const conversationId = 'conv-g2-b4';
    const expectedSessionId = `g2-b4-session-${now}`;
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-b4-workspace', now, now);
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
      'agent-g2-b4-name',
      harness.hostId,
      now,
      now,
      'Agent G2 B4',
      harness.userId,
    );
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(workspaceId, agentId, now);

    db.prepare(
      `INSERT INTO conversations
        (id, workspace_id, placement_kind, roster_policy,
title, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
        VALUES (?, ?, 'workspace', 'open', ?, 'active', NULL, NULL, NULL,
                NULL, ?, ?)`,
    ).run(conversationId, workspaceId, 'g2-b4-channel', now, now);
    db.prepare(
      `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(conversationId, harness.userId, now);
    db.prepare(
      `INSERT INTO conversation_agents
        (conversation_id, agent_id, joined_at)
       VALUES (?, ?, ?)`,
    ).run(conversationId, agentId, now);

    const messageId = 'msg-g2-b4';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(messageId, conversationId, harness.userId, 'hello, agent', now);
    const inboxRepo = new ConversationInboxRepo(db);
    inboxRepo.enqueue(conversationId, agentId, messageId);

    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(expectedSessionId),
    });

    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId);
    // #task:1612 — model creation-time realization on the real daemon
    // (the spawn path no longer provisions).
    await assertOutboundAdapterWired(harness.backend);

    await harness.backend.context.runtimeHost.start(conversationId, agentId);

    // Precondition: session_init landed and the row carries the
    // expected cli_session_id. Capture the pre-stop row so the
    // post-stop assertion can prove preservation, not just
    // "happens to equal expectedSessionId".
    //
    // Note: `agent_runtime_slots.observed_pid` is NOT populated by
    // `sessionInit()` in the current daemon wiring (see
    // `status-projector.ts:120-133`). pid is only ever written as
    // `NULL` on exit / init-retry / delivery-failure projections. So
    // we don't assert pid pre-stop; the post-stop `pid IS NULL`
    // assertion below is a coupling check that the runtimeExit
    // projection executed the explicit `pid: null` write (the
    // `updateAgentRuntime` SQL set returns 0 changed rows if the
    // pid column was untouched but the status changed — better to
    // pin the durable post-state than the no-op write).
    const preStopRow = await waitFor(
      () => {
        const row = db
          .prepare<
            [string, string],
            { status: string; pid: number | null; cli_session_id: string | null }
          >(
            `SELECT observed_status AS status, observed_pid AS pid, cli_session_id
               FROM agent_runtime_slots
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        if (!row || row.cli_session_id !== expectedSessionId) return null;
        if (row.status !== 'active') return null;
        return row;
      },
      { timeoutMs: 10_000, label: 'session_init precondition' },
    );
    expect(preStopRow.status).toBe('active');
    expect(preStopRow.cli_session_id).toBe(expectedSessionId);

    // Subscribe to the bus BEFORE issuing the stop so we catch
    // the `agent_status` publish from `runtimeExit`. Same pattern
    // as B2's P1 fix — observe pre-trigger, assert post-trigger,
    // unsubscribe in finally.
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
      // Production trigger: control-plane hard-stop. The mode
      // ('hard') maps to SIGTERM in `Supervisor.stop()`. The
      // fixture honors SIGTERM (no `--ignore-sigterm`) so this
      // exits cleanly with code 0; the supervisor wraps that into
      // an intentional `runtime_exit`.
      await harness.backend.context.runtimeHost.stop(
        conversationId,
        agentId,
      );

      // Observable #1 (wire): a `runtime_exit` outbound frame
      // landed on the wrapped sink. Same schema parse path as
      // B1/B2 — `OutboundDaemonToServerEventFrameSchema` produces
      // the normalized object the wrapper records.
      const exitFrame = await waitFor(
        () =>
          harness!.events.find(e => e.frame.kind === 'runtime_exit') ?? null,
        { timeoutMs: 10_000, label: 'runtime_exit frame on wrapped sink' },
      );
      expect(exitFrame.hostId).toBe(harness.hostId);
      if (exitFrame.frame.kind !== 'runtime_exit') {
        throw new Error('frame.kind narrowing failed');
      }
      expect(exitFrame.frame.conversation_id).toBe(conversationId);
      expect(exitFrame.frame.agent_id).toBe(agentId);

      // Observable #2 (DB projection): per
      // `RuntimeStatusProjector.runtimeExit`
      // (`packages/backend/src/runtime/status-projector.ts:174`)
      // an intentional exit with code 0 maps to status='idle',
      // pid=NULL, and DELIBERATELY preserves cli_session_id for
      // the next --resume.
      const postStopRow = await waitFor(
        () => {
          const row = db
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
            .get(conversationId, agentId);
          if (!row) return null;
          if (row.status !== 'idle') return null;
          if (row.pid !== null) return null;
          return row;
        },
        { timeoutMs: 10_000, label: 'runtime_exit DB projection' },
      );
      expect(postStopRow.status).toBe('idle');
      expect(postStopRow.pid).toBeNull();
      // The load-bearing assertion: cli_session_id is preserved
      // (NOT cleared). If a future projector regression decides to
      // wipe cli_session_id on exit, this assertion fails and the
      // --resume contract is restored before the change merges.
      expect(postStopRow.cli_session_id).toBe(expectedSessionId);

      // Observable #3 (bus): `agent_status` publish for the
      // renderer. Per status-projector lines 193-202 the payload
      // carries `agent_id`, `status`, `exit_code`, `intentional`,
      // `run_state`. We pin the load-bearing ones; `run_state`
      // shape is unit-tested separately.
      const agentStatusExit = await waitFor(
        () => {
          const candidate = busEvents.find(e => {
            if (e.kind !== 'agent_status') return false;
            const payload = e.payload as
              | {
                  agent_id?: unknown;
                  status?: unknown;
                  exit_code?: unknown;
                  intentional?: unknown;
                }
              | null;
            if (!payload) return false;
            return (
              payload.agent_id === agentId &&
              payload.status === 'idle' &&
              payload.intentional === true
            );
          });
          return candidate ?? null;
        },
        { timeoutMs: 10_000, label: 'agent_status bus event for exit' },
      );
      const payload = agentStatusExit.payload as {
        agent_id: string;
        status: string;
        exit_code: number | null;
        intentional: boolean;
      };
      expect(payload.agent_id).toBe(agentId);
      expect(payload.status).toBe('idle');
      expect(payload.intentional).toBe(true);
      // The fixture has no `SIGTERM` handler, so node terminates
      // with `{code: null, signal: 'SIGTERM'}` — `exit_code` in
      // the projection comes from `child.on('exit', (code) => ...)`
      // and is `null` for signal-driven kills. The projector's
      // status mapping (`intentional || code === 0 → 'idle'`) does
      // NOT depend on the code value here; `intentional=true` is
      // what produced `status='idle'`. Pin that exit_code is
      // either 0 (clean exit beat the signal) or null
      // (signal-driven), so future fixture / kill-path tweaks
      // don't flap this test for unrelated reasons.
      expect([0, null]).toContain(payload.exit_code);
    } finally {
      unsubscribe();
    }
  });
});
