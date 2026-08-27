/**
 * D4.b-5 — Standalone G2 unintentional crash recovery e2e.
 *
 * Layers on the B2 spawn-to-session_init substrate. After
 * `session_init` lands the fixture voluntarily exits with a
 * non-zero code WITHOUT the backend ever issuing a stop. The
 * supervisor's `child.on('exit', ...)` handler fires, emits
 * `runtime_exit` with `intentional=false` and `code !== 0`, and
 * the backend's `RuntimeStatusProjector.runtimeExit` maps that to
 * `status='crashed'` (per the projector's
 * `initTimedOut || fatalError ? 'crashed' : intentional || code === 0
 * ? 'idle' : 'crashed'` ladder).
 *
 * **What this test pins**:
 *
 *   1. **status → 'crashed'** — the "otherwise" arm of the
 *      projector's status mapping, exercised by `intentional=false
 *      AND code !== 0`. This is the arm B4 deliberately did NOT
 *      cover (B4 was the intentional-stop arm); without B5, a
 *      regression that swapped the mapping (e.g. defaulted to
 *      `'idle'` for non-zero unintentional exits) would slip past.
 *   2. **pid → NULL** — same `pid: null` write as B4.
 *   3. **cli_session_id PRESERVED** — same `--resume` contract
 *      Cindy locked in `BYHZJI9ALSVmmlFr`. Crashes don't drop the
 *      session id any more than intentional stops do; the next
 *      `runtimeHost.start` could `--resume` it.
 *   4. **ScopeEventBus** publishes `agent_status` with
 *      `intentional=false`, `status='crashed'`, `exit_code=1`.
 *   5. **Reconnect determinism (Cindy boundary #4: "no wall-clock
 *      backoff betting")** — the entire path completes within the
 *      harness's `waitFor` deadline using the deterministic
 *      `OutboundDaemonClient` backoff configured at boot
 *      (`{minDelayMs: 25, maxDelayMs: 100, factor: 2,
 *      jitterRatio: 0}` — see `g2-harness.ts`'s
 *      `bootHarnessDaemon` / `bootDaemonWithSupervisor`). No
 *      `setTimeout(...)` in the test bets on real-time backoff
 *      windows; all waits are bounded `waitFor` polls keyed on
 *      durable observables. If a future regression reintroduces
 *      wall-clock-based backoff (e.g. a 5s minimum delay), the
 *      bounded waits would expire deterministically rather than
 *      flapping intermittently.
 *
 * **Why this is "kill -9 recovery" even though there's no
 * `process.kill(pid, 'SIGKILL')` call**: the supervisor cannot
 * distinguish between an external SIGKILL and a voluntary
 * non-zero exit at the projection layer — both produce
 * `intentional=false AND code !== 0` (signal vs code is encoded
 * separately on the wire, but the status mapping cares about the
 * combined predicate). The fixture-driven crash is the
 * deterministic version: an external `kill -9` from the test
 * process would need to find the supervisor's child PID through a
 * private map (no public accessor) and the timing would race the
 * supervisor's own exit handler. The crash semantic is identical
 * either way.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: same boundary lock as B1-B4.
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

/**
 * Crash-after-session_init driver: emits the sentinel line and
 * then the fixture exits with a non-zero code 250ms later. The
 * `--sleep 250` window is long enough for the session_init
 * projection to land before the crash so the test can assert the
 * pre-crash and post-crash row deltas are both real.
 */
function makeCrashingDriver(sessionId: string): Driver {
  return {
    kind: 'claude',
    binary: FIXTURE,
    kickoffMode: 'self_inits',
    releaseProfile: 'native-steer',
    // #task:2210: session-init-only fake driver -- no input_lifecycle proof, so
    // settle at the stdin write (pre-#2210 behavior); lifecycle-start would never admit.
    admissionPolicy: 'write-success',
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
      '--sleep',
      '250',
      '--exit-code',
      '1',
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

describe('Standalone G2 — unintentional crash recovery + crashed projection', () => {
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

  it('a fixture child that crashes (non-zero exit, no stop issued) projects to status=crashed, pid=NULL, cli_session_id preserved', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;

    const now = Date.now();
    const workspaceId = 'ws-g2-b5';
    const agentId = 'agent-g2-b5';
    // Production-shaped (#task:2021 P4-3): a delivery header renders this id as
    // the stream's absolute `target`, so it must be spellable — 16 base64url
    // chars, exactly what `conversations.id` is minted as.
    const conversationId = 'g2b5CrashRecover';
    const expectedSessionId = `g2-b5-session-${now}`;
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, name_key, description,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-b5-workspace', 'g2-b5-workspace', now, now);
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
      'agent-g2-b5-name',
      harness.hostId,
      now,
      now,
      'Agent G2 B5',
      harness.userId,
    );
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(workspaceId, agentId, now);
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
      'g2-b5-channel',
      // Its title IS its address (#task:2016); this literal folds to itself.
      'g2-b5-channel',
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

    const messageId = 'msg-g2-b5';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(messageId, conversationId, harness.userId, 'hello, agent', now);
    new ConversationInboxRepo(db).enqueue(conversationId, agentId, messageId);

    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeCrashingDriver(expectedSessionId),
    });

    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId);
    // #task:1612 — model creation-time realization on the real daemon
    // (the spawn path no longer provisions).
    await assertOutboundAdapterWired(harness.backend);

    // Subscribe to the bus BEFORE the start so we catch BOTH
    // status events (sessionInit → active, then runtimeExit →
    // crashed) on the same handler. Pre-start subscribe is the
    // same pattern as B2 P1.
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
      // Start: spawns the fixture, which emits session_init then
      // voluntarily exits 1 after 250ms (no stop call from the
      // backend — the supervisor sees the exit as unintentional).
      await harness.backend.context.runtimeHost.start(conversationId, agentId);

      // Precondition: session_init projection lands first. We
      // assert this strictly so the post-crash row delta is
      // measured against a known good baseline.
      await waitFor(
        () => {
          const row = db
            .prepare<[string, string], { cli_session_id: string | null }>(
              `SELECT cli_session_id FROM agent_runtime_slots
                WHERE conversation_id = ? AND agent_id = ?`,
            )
            .get(conversationId, agentId);
          return row && row.cli_session_id === expectedSessionId ? true : null;
        },
        { timeoutMs: 10_000, label: 'session_init precondition' },
      );

      // Wire-side observable: a `runtime_exit` frame lands on the
      // wrapped sink. Same schema parse path as B1-B4.
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

      // DB projection (load-bearing — the 'crashed' arm of the
      // status mapping). This is the assertion B4 deliberately did
      // NOT cover; a regression that swapped the mapping (e.g.
      // defaulted non-zero unintentional exits to 'idle') would
      // turn this red while B4 stayed green.
      const postCrashRow = await waitFor(
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
          if (row.status !== 'crashed') return null;
          return row;
        },
        { timeoutMs: 10_000, label: 'runtime_exit crash DB projection' },
      );
      expect(postCrashRow.status).toBe('crashed');
      expect(postCrashRow.pid).toBeNull();
      // cli_session_id is preserved even on crash — same
      // --resume contract as B4 (Cindy `BYHZJI9ALSVmmlFr`).
      expect(postCrashRow.cli_session_id).toBe(expectedSessionId);

      // Bus event with `intentional=false` + `exit_code=1`. Two
      // `agent_status` events are published in this scenario
      // (sessionInit's `active` then runtimeExit's `crashed`); we
      // pick the crashed one explicitly to avoid the active arm.
      const agentStatusCrash = await waitFor(
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
              payload.status === 'crashed' &&
              payload.intentional === false
            );
          });
          return candidate ?? null;
        },
        { timeoutMs: 10_000, label: 'agent_status bus event for crash' },
      );
      const payload = agentStatusCrash.payload as {
        agent_id: string;
        status: string;
        exit_code: number | null;
        intentional: boolean;
      };
      expect(payload.status).toBe('crashed');
      expect(payload.intentional).toBe(false);
      // Fixture exits with code 1 on `--exit-code 1`. This is the
      // explicit non-zero value the projector used to compute
      // 'crashed' via the "otherwise" arm.
      expect(payload.exit_code).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});
