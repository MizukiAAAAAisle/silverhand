/**
 * D4.b P1-2 (revised for the boot-herd root-cause fix) — Standalone
 * G2 daemon disconnect + pending inbox recovery e2e.
 *
 * §5.2 design contract: the DAEMON disappears mid-flight; the backend
 * rolls back in-flight inbox rows owned by that connection; a fresh
 * daemon attaches with the same host_id/host_token; the rolled-back
 * pending recovers without loss and without duplicate delivery.
 *
 * **Semantic revision (shiki `CKFaAk3TZMFYWLE-` boot-herd fix):** this
 * test originally asserted that a COLD daemon reattach *automatically*
 * drained the whole DB backlog on `ready` (the old
 * `replayPendingForHost → listPendingPairsForHost → startDeliveryBacked`
 * per-pair fan-out). That fan-out was the memory bug: an agent that was
 * a member of N backlogged conversations spawned N `claude` processes
 * the instant a daemon attached (29 procs / 8GB observed in dogfood).
 *
 * The fix scopes the reattach re-drive to runtimes the daemon reports
 * as ALREADY ALIVE in its `runtime_status` hydrate snapshot (live-delivery-only,
 * never spawn). A cold daemon's snapshot is empty, so a cold reattach
 * spawns NOTHING from the DB pending set — activation happens only when
 * a real send lands. This test is rewritten to that contract.
 *
 * **What this test pins now**:
 *
 *   1. **Live runtime established by an explicit send** — row #1 drains
 *      as `startup_delivery` after `runtimeHost.start`, not by any
 *      attach-time auto-drain. This is the only activation trigger.
 *   2. **Rollback on disconnect** — a row sitting in
 *      `in_flight_owner = <old connectionId>` when the daemon drops is
 *      flipped back to pending with `in_flight_owner` / `in_flight_at`
 *      cleared (the SQL predicate spares already-delivered rows).
 *   3. **NO auto-spawn on COLD reattach (the boot-herd invariant)** —
 *      after the fresh daemon reattaches with an EMPTY runtime snapshot,
 *      the rolled-back row #2 stays pending: `delivered_at` is still
 *      null and the post-reattach `secondSessionId` never appears (no
 *      runtime was spawned from the DB backlog). This is the core
 *      regression guard for the 29-process herd.
 *   4. **Recovery via an explicit send** — a subsequent
 *      `runtimeHost.start` spawns one fresh runtime (`secondSessionId`),
 *      drains the rolled-back row #2 as `startup_delivery`, and lands
 *      `delivered_at` non-null.
 *   5. **No duplicate delivery** — the recovered payload's wire
 *      `STDIN:<payload>` echo count is EXACTLY 1.
 *   6. **Same daemon credentials across the restart** — the new daemon
 *      attaches with the SAME host_id + host_token; the backend mints a
 *      fresh `hostws-*` connectionId distinct from the dropped one.
 *
 * **Reconnect determinism (Cindy boundary #4)** — the harness's
 * deterministic `OutboundDaemonClient` backoff governs the reattach
 * window; bounded `waitFor` polls catch the reattach without wall-clock
 * betting. The only fixed wait is a short settle window for the
 * negative assertion in (3) — proving "nothing spawned" needs a bounded
 * quiet period; the deterministic unit pin
 * (`outbound-event-fanout.test.ts` — "cold daemon attach … does NOT
 * replay backlog into runtime_start/wake") is the authoritative,
 * race-free guard and this e2e is the integration companion.
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
  assertOutboundAdapterWired,
  bootDaemonWithSupervisor,
  bootG2Harness,
  waitFor,
  waitForAttachment,
  waitForFreshAttachment,
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

  it('rolls an in-flight row back to pending on daemon disconnect; a COLD reattach does NOT auto-spawn the backlog; an explicit send then recovers it exactly once (no-loss, no-dup)', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;

    const now = Date.now();
    const workspaceId = 'ws-g2-recovery';
    const agentId = 'agent-g2-recovery';
    // Production-shaped (#task:2021 P4-3): a delivery header renders this id as
    // the stream's absolute `target`, so it must be spellable — 16 base64url
    // chars, exactly what `conversations.id` is minted as.
    const conversationId = 'g2RecoveryConvId';
    const firstSessionId = `g2-recovery-first-${now}`;
    const secondSessionId = `g2-recovery-second-${now}`;
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, name_key, description,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-recovery-workspace', 'g2-recovery-workspace', now, now);
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
        (id, workspace_id, placement_kind, roster_policy,
         title, title_key, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
        VALUES (?, ?, 'workspace', 'open', ?, ?, 'active', NULL, NULL, NULL,
                NULL, ?, ?)`,
    ).run(
      conversationId,
      workspaceId,
      'g2-recovery-channel',
      // Its title IS its address (#task:2016); this literal folds to itself.
      'g2-recovery-channel',
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
    // #task:1612 — model creation-time realization on the real daemon
    // (the spawn path no longer provisions).
    await assertOutboundAdapterWired(harness.backend);
    const oldConnectionId = oldAttachment.connectionId;

    // ── Establish a live runtime via an EXPLICIT send ───────────
    //
    // Boot-herd fix: a daemon attach no longer auto-drains the DB
    // backlog. Row #1 (enqueued pre-daemon-boot) is therefore NOT
    // delivered just because the daemon connected. We trigger the
    // one legitimate activation — an explicit `runtimeHost.start`
    // (the standalone analogue of the user sending into this
    // conversation) — which spawns the runtime and drains row #1 as
    // `startup_delivery`. This is the precondition (a genuinely live
    // runtime) for the disconnect/reattach scenario below.
    await harness.backend.context.runtimeHost.start(conversationId, agentId);
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM agent_runtime_slots
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        return row && row.cli_session_id === firstSessionId ? true : null;
      },
      { timeoutMs: 10_000, label: 'first session_init landed via explicit start' },
    );
    // Row #1 drained as startup_delivery → delivered_at non-null.
    await waitFor(
      () => {
        const row = readInboxRow(
          harness!,
          conversationId,
          agentId,
          firstMessageId,
        );
        if (!row) return null;
        if (row.delivered_at === null) return null;
        return row;
      },
      { timeoutMs: 5_000, label: 'row #1 delivered_at via explicit start' },
    );

    // ── Set up the in-flight row scenario ───────────────────────
    //
    // Seed row #2, then directly claim it for the OLD connectionId
    // so it sits in `in_flight_owner = oldConnectionId` /
    // `delivered_at = null` / `in_flight_at = <now>`. This is the
    // exact state a row would be in if the backend had dispatched
    // a delivery on it and the daemon disconnected before the delivery
    // response landed.
    //
    // (We don't trigger the delivery itself — calling
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
      1,
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

    const newAttachment = await waitForFreshAttachment(
      controller,
      harness.hostId,
      oldConnectionId,
    );
    const newConnectionId = newAttachment.connectionId;
    expect(newConnectionId).not.toBe(oldConnectionId);
    expect(newConnectionId).toMatch(/^hostws-/);

    // ── NO auto-spawn on COLD reattach (the boot-herd invariant) ─
    //
    // The killed daemon took its runtime with it, so the fresh
    // daemon's `runtime_status` hydrate snapshot is EMPTY. The
    // scoped reattach replay (`replayPendingForHost` — live-delivery-only,
    // live-runtimes-only) must therefore do nothing: it must NOT
    // derive a `runtime_start` from the DB pending set. Pre-fix this
    // is exactly where the 29-process herd was born.
    //
    // Settle window: the (no-op) replay runs in a microtask after
    // the post-attach `runtime_status` round-trip. Give it room, then
    // assert the rolled-back row #2 is STILL pending and the
    // post-reattach `secondSessionId` never materialised (nothing
    // spawned). The deterministic, race-free guard for this lives in
    // `outbound-event-fanout.test.ts`; this is the integration
    // companion.
    await new Promise(resolve => setTimeout(resolve, 300));
    const afterReattachRow = readInboxRow(
      harness,
      conversationId,
      agentId,
      secondMessageId,
    );
    expect(afterReattachRow).toBeTruthy();
    expect(afterReattachRow!.delivered_at).toBeNull();
    expect(afterReattachRow!.in_flight_owner).toBeNull();
    const sessionAfterReattach = harness.backend.context.db
      .prepare<[string, string], { cli_session_id: string | null }>(
        `SELECT cli_session_id FROM agent_runtime_slots
          WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(conversationId, agentId);
    expect(sessionAfterReattach?.cli_session_id).not.toBe(secondSessionId);

    // ── Recovery via an EXPLICIT send ───────────────────────────
    //
    // The user sends into the conversation again (here: an explicit
    // `runtimeHost.start`, the standalone analogue). With no live
    // runtime, this spawns a fresh one (`secondSessionId`) and drains
    // the rolled-back row #2 as `startup_delivery`.
    //
    // No-loss: the row ends up delivered_at non-null.
    await harness.backend.context.runtimeHost.start(conversationId, agentId);
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
        label: 'second row delivered_at lands after explicit recovery send',
      },
    );
    expect(recoveredRow.delivered_at).not.toBeNull();
    expect(recoveredRow.in_flight_owner).toBeNull();
    expect(recoveredRow.in_flight_at).toBeNull();

    // Wait for the post-restart session_init to land so we know
    // the new runtime is fully ready.
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM agent_runtime_slots
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

    // Sanity check: the first message was already delivered_at on
    // the OLD daemon and the new daemon must NOT re-replay it. Raw
    // runtime_output is no longer emitted in production, so the
    // durable DB row is the no-dup/no-loss observable here.
    const firstRowAfter = readInboxRow(
      harness,
      conversationId,
      agentId,
      firstMessageId,
    );
    expect(firstRowAfter).toBeTruthy();
    expect(firstRowAfter!.delivered_at).not.toBeNull();
  });
});
