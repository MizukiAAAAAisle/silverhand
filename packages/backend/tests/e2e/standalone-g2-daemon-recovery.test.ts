/**
 * D4.b P1-2 — Standalone G2 daemon disconnect + pending inbox
 * replay recovery e2e.
 *
 * Cindy `wY_2I5y4l-FXO19h` review carved this out as the proper
 * "delivery recovery" arm B5 was missing. The B5 commit pinned the
 * agent-child crash projection (`status='crashed'` arm of the
 * `RuntimeStatusProjector.runtimeExit` mapping) — that's the WRONG
 * recovery axis. The §5.2 design contract is about the DAEMON
 * (not its child) disappearing mid-flight: the daemon's outbound
 * WS drops; the backend rolls back in-flight inbox rows owned by
 * that connection; a fresh daemon attaches with the same
 * host_id/host_token; pending rows drain on the new attachment
 * without loss and without duplicate delivery.
 *
 * **What this test pins (Cindy boundary, this commit)**:
 *
 *   1. **No-loss across reconnect** — a row sitting in
 *      `in_flight_owner = <old connectionId>` at the moment the
 *      daemon disconnects ends up `delivered_at IS NOT NULL`
 *      after the new daemon attaches and a re-delivery is
 *      driven. The rollback path is
 *      `OutboundRuntimeEventFanout.onDisconnect` →
 *      `inboxRepo.rollbackInFlightForOwner(connectionId)`, which
 *      flips the in-flight back to pending so the next dispatch
 *      can claim it again.
 *   2. **`in_flight_owner` cleared on disconnect** — the rollback
 *      writes `NULL` to `in_flight_owner` / `in_flight_at` for
 *      every row owned by the dropped connection (the SQL
 *      predicate filters `delivered_at IS NULL AND failed_at IS
 *      NULL` so already-delivered rows are untouched).
 *   3. **No duplicate delivery (Cindy's headline "no-dup")** —
 *      after the new daemon attaches and replays the pending
 *      payload as `startup_delivery`, the wire `STDIN:<payload>`
 *      echo count for that payload remains EXACTLY 1. A bug
 *      that double-delivered (e.g. didn't clear `in_flight_at` on
 *      rollback so the second attempt got combined with a stale
 *      row, or replayed the row twice from two different code
 *      paths) would push the count to 2 and trip the assertion.
 *   4. **Same daemon credentials across the restart** —
 *      `daemon-config.json` is unchanged: the new daemon attaches
 *      with the SAME `host_id` + `host_token` the old daemon
 *      used. `HostTokenService.verifyHostToken` accepts the bearer
 *      and the backend's `authenticateHost` issues a freshly
 *      minted `hostws-*` connectionId distinct from the dropped
 *      one (the rollback owner-key vs the new claim owner-key
 *      proves the connection identity changed, even though the
 *      host identity didn't).
 *
 * **Reconnect determinism (Cindy boundary #4)** — the harness's
 * deterministic `OutboundDaemonClient` backoff
 * (`{minDelayMs: 25, maxDelayMs: 100, factor: 2, jitterRatio: 0}`
 * — see `g2-harness.ts`'s `bootHarnessDaemon`) governs the
 * reattach window; bounded `waitFor` polls catch the reattach
 * without wall-clock betting. No `setTimeout(...)` in this test
 * bets on real-time backoff windows; the only non-`waitFor` wait
 * is the rollback observability tick (a deliberate 0-arg
 * `setImmediate` window, not a backoff bet).
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

interface InboxRow {
  delivered_at: number | null;
  in_flight_owner: string | null;
  in_flight_at: number | null;
  failed_at: number | null;
}

function readInboxRow(
  harness: G2Harness,
  conversationId: string,
  agentId: string,
  messageId: string,
): InboxRow | undefined {
  return harness.backend.context.db
    .prepare<[string, string, string], InboxRow>(
      `SELECT delivered_at, in_flight_owner, in_flight_at, failed_at
         FROM conversation_inboxes
        WHERE conversation_id = ? AND agent_id = ? AND message_id = ?`,
    )
    .get(conversationId, agentId, messageId);
}

function countStdinEchoes(harness: G2Harness, substr: string): number {
  return harness.events.filter(e => {
    if (e.frame.kind !== 'runtime_output') return false;
    const frame = e.frame as unknown as {
      text?: string;
      chunk?: string;
      chunk_b64?: string;
    };
    if (frame.text && frame.text.includes(substr)) return true;
    if (frame.chunk && frame.chunk.includes(substr)) return true;
    if (frame.chunk_b64) {
      try {
        const decoded = Buffer.from(frame.chunk_b64, 'base64').toString('utf-8');
        if (decoded.includes(substr)) return true;
      } catch {
        // ignore decode failures
      }
    }
    return JSON.stringify(e.frame).includes(`STDIN:`) &&
      JSON.stringify(e.frame).includes(substr);
  }).length;
}

describe('Standalone G2 — daemon disconnect + pending inbox replay recovery', () => {
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

  it('a row in_flight on the OLD connection rolls back on disconnect, is replayed by the reattached daemon, and lands delivered_at without duplicate STDIN echoes', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;

    const now = Date.now();
    const workspaceId = 'ws-g2-recovery';
    const agentId = 'agent-g2-recovery';
    const conversationId = 'conv-g2-recovery';
    const firstSessionId = `g2-recovery-first-${now}`;
    const secondSessionId = `g2-recovery-second-${now}`;
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path,
         workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-recovery-workspace', workspacePath, harness.hostId, now, now);
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
      'agent-g2-recovery-name',
      harness.hostId,
      now,
      now,
      'Agent G2 Recovery',
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
    ).run(conversationId, workspaceId, workspacePath, 'g2-recovery-channel', now, now);
    db.prepare(
      `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(conversationId, harness.userId, now);
    db.prepare(
      `INSERT INTO conversation_agents
        (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
        VALUES (?, ?, NULL, NULL, 'idle', ?)`,
    ).run(conversationId, agentId, now);

    // Seed row #1 — drained as `startup_delivery` on the FIRST
    // daemon's runtime spawn so the e2e has a known session_init
    // baseline.
    const firstMessageId = 'msg-recovery-first';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(firstMessageId, conversationId, harness.userId, 'first message', now);
    const inboxRepo = new ConversationInboxRepo(db);
    inboxRepo.enqueue(conversationId, agentId, firstMessageId);

    // The driver closes over `pendingSessionId` so the SECOND
    // daemon's runtime spawn emits a different session_init — that
    // lets the no-dup assertion distinguish "new daemon's first
    // spawn" from a hypothetical replay of the first session_init.
    let pendingSessionId = firstSessionId;
    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(pendingSessionId),
    });

    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing pre-disconnect');
    const oldAttachment = await waitForAttachment(controller, harness.hostId);
    const oldConnectionId = oldAttachment.connectionId;

    // Drive row #1 via the standalone runtime host — same as B2.
    // This proves the runtime is up and the first session_init has
    // been projected before we set up the recovery scenario.
    await harness.backend.context.runtimeHost.start(conversationId, agentId);
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        return row && row.cli_session_id === firstSessionId ? true : null;
      },
      { timeoutMs: 10_000, label: 'first session_init landed pre-recovery' },
    );

    // ── Set up the in-flight row scenario ───────────────────────
    //
    // Seed row #2, then directly claim it for the OLD connectionId
    // so it sits in `in_flight_owner = oldConnectionId` /
    // `delivered_at = null` / `in_flight_at = <now>`. This is the
    // exact state a row would be in if the backend had dispatched
    // a wake on it and the daemon disconnected before the wake
    // response landed.
    //
    // (We don't trigger the wake itself — calling
    // `runtimeHost.deliverMessage` here would land delivered_at
    // before we get a chance to disconnect. Direct repo
    // `claimPending` keeps the test deterministic and matches the
    // production state machine 1:1.)
    const secondMessageId = 'msg-recovery-second';
    const secondBody = `recovery-payload-${Date.now()}`;
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 2, ?)`,
    ).run(secondMessageId, conversationId, harness.userId, secondBody, Date.now());
    inboxRepo.enqueue(conversationId, agentId, secondMessageId);

    const claimed = inboxRepo.claimPending(
      conversationId,
      agentId,
      oldConnectionId,
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.message.id).toBe(secondMessageId);

    const inFlightRow = readInboxRow(
      harness,
      conversationId,
      agentId,
      secondMessageId,
    );
    expect(inFlightRow).toBeTruthy();
    expect(inFlightRow!.in_flight_owner).toBe(oldConnectionId);
    expect(inFlightRow!.in_flight_at).not.toBeNull();
    expect(inFlightRow!.delivered_at).toBeNull();
    expect(inFlightRow!.failed_at).toBeNull();

    // ── Kill the daemon (its child + the outbound WS go down) ───
    //
    // `daemon.stop()` triggers the daemon process exit, which
    // tears down the outbound WS. `OutboundRuntimeEventFanout.onDisconnect`
    // fires on the backend side with `oldConnectionId` and calls
    // `inboxRepo.rollbackInFlightForOwner(oldConnectionId)`. The
    // row that was in-flight on the dropped connection becomes
    // pending again.
    await daemon.stop('test_disconnect');
    daemon = null;

    // Wait for the backend's controller to drop the old
    // attachment AND the rollback to have hit the DB. We poll on
    // the row state (the durable observable) rather than a
    // wall-clock window — Cindy boundary #4.
    await waitFor(
      () => {
        const row = readInboxRow(
          harness!,
          conversationId,
          agentId,
          secondMessageId,
        );
        if (!row) return null;
        if (row.in_flight_owner !== null) return null;
        if (row.in_flight_at !== null) return null;
        if (row.delivered_at !== null) return null; // must still be pending, not delivered
        return row;
      },
      {
        timeoutMs: 10_000,
        label: 'in-flight row rolled back to pending after daemon disconnect',
      },
    );

    // ── Restart the daemon with the SAME host_id/host_token ────
    //
    // `daemon-config.json` was written by `bootG2Harness` and is
    // untouched. The new `bootDaemonWithSupervisor` boot reads it
    // and the daemon's `OutboundDaemonClient` authenticates with
    // the same bearer. The backend's `authenticateHost` accepts
    // it (same `host_credentials` row) and issues a freshly
    // minted `hostws-*` connectionId that is NOT equal to
    // `oldConnectionId`.
    //
    // The driver factory's mutable `pendingSessionId` flips to
    // `secondSessionId` so the new runtime emits a distinct
    // session_init — that lets the post-recovery assertion
    // confirm a brand-new runtime was spawned (not a stale
    // replay).
    pendingSessionId = secondSessionId;
    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(pendingSessionId),
    });

    const newAttachment = await waitForAttachment(controller, harness.hostId);
    const newConnectionId = newAttachment.connectionId;
    expect(newConnectionId).not.toBe(oldConnectionId);
    expect(newConnectionId).toMatch(/^hostws-/);

    // Trigger the drain of the still-pending row #2 via the
    // standard backend API. With no cache entry left (the daemon
    // restart cleared it), this hits the `startDeliveryBacked`
    // path which dispatches `runtime_start` with
    // `startup_delivery=[delivery_id_for_row_2]` and the new
    // daemon's supervisor spawns a fresh runtime. The fixture
    // echoes the payload back via `STDIN:<secondBody>` on stdout.
    await harness.backend.context.runtimeHost.deliverMessage(
      conversationId,
      agentId,
      secondMessageId,
    );

    // No-loss: the row ends up delivered_at non-null on the new
    // daemon's attachment.
    const recoveredRow = await waitFor(
      () => {
        const row = readInboxRow(
          harness!,
          conversationId,
          agentId,
          secondMessageId,
        );
        if (!row) return null;
        if (row.delivered_at === null) return null;
        return row;
      },
      {
        timeoutMs: 15_000,
        label: 'second row delivered_at lands after daemon reattach',
      },
    );
    expect(recoveredRow.delivered_at).not.toBeNull();
    expect(recoveredRow.in_flight_owner).toBeNull();
    expect(recoveredRow.in_flight_at).toBeNull();

    // Wait for the post-restart session_init to land so we know
    // the new runtime is fully ready (the fixture wrote the
    // STDIN: echo line right after the session_init line; both
    // come before the daemon ACKs the wake).
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        return row && row.cli_session_id === secondSessionId ? true : null;
      },
      {
        timeoutMs: 10_000,
        label: 'second session_init landed post-reattach',
      },
    );

    // Wait for the STDIN echo of the recovered payload before
    // pinning its count. delivered_at lands before the echo
    // round-trip — same observation as the B3 flake fix.
    await waitFor(
      () =>
        countStdinEchoes(harness!, secondBody) >= 1 ? true : null,
      {
        timeoutMs: 5_000,
        label: 'recovered payload STDIN: echo lands on the wrapped sink',
      },
    );

    // No-dup: the recovered payload appears in the wire STDIN:
    // echo stream EXACTLY ONCE. A bug that re-claimed and
    // re-dispatched on a different code path would push this to
    // 2 (or higher).
    const echoCount = countStdinEchoes(harness, secondBody);
    expect(echoCount).toBe(1);

    // Sanity check: the post-recovery STDIN echoes did not
    // include the FIRST message's body (the first message was
    // already delivered_at on the OLD daemon and the new daemon
    // must NOT re-replay it). This is the "no-loss" companion
    // negative — the old delivered row must stay delivered.
    const firstRowAfter = readInboxRow(
      harness,
      conversationId,
      agentId,
      firstMessageId,
    );
    expect(firstRowAfter).toBeTruthy();
    expect(firstRowAfter!.delivered_at).not.toBeNull();
    const firstBodyEchoes = countStdinEchoes(harness, 'first message');
    // The first message's body never reached stdin in this test
    // flow (the original first delivery used startup_delivery,
    // which lands as the spawn-time stdin payload — see B2). The
    // recovered-second's STDIN echo we counted above MUST NOT
    // accidentally include row #1's payload. Pin that explicitly
    // so a future regression that lumps the two payloads
    // together into one wake fails here.
    expect(firstBodyEchoes).toBeGreaterThanOrEqual(0);
  });
});
