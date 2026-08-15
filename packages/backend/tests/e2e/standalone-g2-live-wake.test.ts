/**
 * D4.b-3 — Standalone G2 live-deliver + inbox delivery marker e2e.
 *
 * Builds on B2's spawn-to-session_init substrate. Once the runtime
 * is `ready`, a new inbox row triggers `runtime_deliver` on the live
 * handle (the WRITE / `admitted` arm, not a fresh spawn), the daemon
 * writes the message to the child's stdin via
 * `driver.encodeStdinMessage`, and the backend records the inbox row
 * as delivered on the async `runtime_delivery_consumed` ack.
 *
 * **What this test pins (Cindy `Pe0E7hK0du-S_vYC` boundary
 * tightening — "查 DB 行 (`delivered_at` / `in_flight_owner` /
 * dedupe)，不只 assert deliver result")**:
 *
 *   1. **Delivery marker projection** — after a live deliver,
 *      `conversation_inboxes.delivered_at` for the new inbox row
 *      flips from `NULL` to a real timestamp, AND `in_flight_owner`
 *      / `in_flight_at` are cleared. This is the durable observable
 *      that proves the deliver ack (`runtime_delivery_consumed`)
 *      reached the backend's `inboxAck.markDelivered(...)` sink (not
 *      just the daemon's stdin write).
 *   2. **Dedupe** — calling `deliverMessage(...)` a second time for
 *      the same inbox row is a no-op:
 *        - `delivered_at` is unchanged (no rewrite, no race
 *          re-claim).
 *        - `delivered_at` / in-flight fields stay unchanged across
 *          the duplicate deliver attempt (the dedupe guard fired at
 *          the `delivery.deliveredAt !== null` short-circuit in
 *          `OutboundRuntimeEventFanout.deliverMessage`).
 *   3. **deliver takes the live-runtime WRITE arm, not a spawn** —
 *      the session_init projection from B2's spawn is still the
 *      latest one; no new `session_init` parsed event lands after the
 *      deliver (i.e. the runtime was NOT re-spawned).
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: same as B1/B2 — daemon's Unix socket isn't
 * connected to; the entire test is the outbound WS path.
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
  type DaemonWithSupervisorHandle,
  type G2Harness,
} from './g2-harness.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../host/tests/_fixtures/echo-runtime.cjs',
);

const SESSION_PREFIX = '__G2_SESSION_INIT__:';

/**
 * Same driver shape as B2: `kickoffMode: 'self_inits'` means the
 * supervisor's `deliver()` consumed ack (`runtime_delivery_consumed`)
 * flows straight back to `markDelivered(...)` (no
 * `requires_first_message` B3 gate). Tests
 * for the `requires_first_message` claude-style gate live elsewhere
 * (`packages/host/tests/supervisor.test.ts` covers it at the
 * supervisor unit level; D4 e2e doesn't re-derive that contract).
 */
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
  id: number;
  delivered_at: number | null;
  in_flight_owner: string | null;
  in_flight_at: number | null;
}

describe('Standalone G2 — live deliver + inbox delivery marker', () => {
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

  it('a second inbox row for an already-ready runtime takes the live-deliver (WRITE) path, flips delivered_at, and is dedupe-safe on re-deliver', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;

    const now = Date.now();
    const workspaceId = 'ws-g2-b3';
    const agentId = 'agent-g2-b3';
    // Production-shaped (#task:2021 P4-3): a delivery header renders this id as
    // the stream's absolute `target`, so it must be spellable — 16 base64url
    // chars, exactly what `conversations.id` is minted as.
    const conversationId = 'g2b3LiveWakeConv';
    const expectedSessionId = `g2-b3-session-${now}`;
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-b3-workspace', now, now);
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
      'agent-g2-b3-name',
      harness.hostId,
      now,
      now,
      'Agent G2 B3',
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
      'g2-b3-channel',
      // Its title IS its address (#task:2016); this literal folds to itself.
      'g2-b3-channel',
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

    // First message: spawns the runtime via startup_delivery (B2 path).
    const firstMessageId = 'msg-g2-b3-first';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(firstMessageId, conversationId, harness.userId, 'hello, agent', now);
    const inboxRepo = new ConversationInboxRepo(db);
    inboxRepo.enqueue(conversationId, agentId, firstMessageId);

    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(expectedSessionId),
    });

    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');
    await waitForAttachment(controller, harness.hostId);
    // #task:1612 — model creation-time realization on the real daemon
    // (the spawn path no longer provisions).
    await assertOutboundAdapterWired(harness.backend);

    // Spawn the runtime + wait for session_init to land in DB (this
    // is exactly the B2 happy path; we re-use it as the precondition
    // for the live-deliver assertion below). After this, phase=ready in
    // the backend's per-host cache, so the next inbox row takes the
    // `runtime_deliver` WRITE arm, not a fresh spawn.
    await harness.backend.context.runtimeHost.start(conversationId, agentId);
    await waitFor(
      () => {
        const row = db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM agent_runtime_slots
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        if (!row || row.cli_session_id !== expectedSessionId) return null;
        return true;
      },
      { timeoutMs: 10_000, label: 'session_init projection (precondition)' },
    );
    // Record the count of session_init events at this point so the
    // post-deliver assertion can prove the runtime was NOT respawned
    // (a respawn would emit a new session_init).
    const sessionInitsBeforeDeliver = harness.events.filter(
      e =>
        e.frame.kind === 'runtime_parsed_event' &&
        e.frame.parsed.kind === 'session_init',
    ).length;

    // Second message — this is the live-deliver test substrate. We
    // also seed the body so the deliver's stdin write contains a
    // unique substring we can grep for in the fixture's STDIN:
    // echo (proves the live deliver actually reached the runtime).
    const secondMessageId = 'msg-g2-b3-second';
    const secondBody = `live-deliver-payload-${now}`;
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 2, ?)`,
    ).run(secondMessageId, conversationId, harness.userId, secondBody, now);

    // First deliver call: enqueues + triggers the live WRITE arm.
    await harness.backend.context.runtimeHost.deliverMessage(
      conversationId,
      agentId,
      secondMessageId,
    );

    // Observable #1 (load-bearing — Cindy P1 boundary): the inbox
    // row's `delivered_at` flips from NULL to a real timestamp via
    // `inboxAck.markDelivered(...)` on the async `runtime_delivery_consumed`
    // ack. Also verify `in_flight_owner` / `in_flight_at` were cleared by
    // the same `markDelivered` write — a stale in-flight lease
    // would prevent later replays from claiming the row.
    const deliveredRow = await waitFor(
      () => {
        const row = db
          .prepare<[string, string, string], InboxRow>(
            `SELECT id, delivered_at, in_flight_owner, in_flight_at
               FROM conversation_inboxes
              WHERE conversation_id = ? AND agent_id = ? AND message_id = ?`,
          )
          .get(conversationId, agentId, secondMessageId);
        if (!row) return null;
        if (row.delivered_at === null) return null;
        return row;
      },
      { timeoutMs: 10_000, label: 'inbox delivered_at projection (live deliver)' },
    );
    expect(deliveredRow.delivered_at).toBeGreaterThan(0);
    expect(deliveredRow.delivered_at).toBeLessThanOrEqual(Date.now());
    expect(deliveredRow.in_flight_owner).toBeNull();
    expect(deliveredRow.in_flight_at).toBeNull();
    const deliveredAtAfterFirst = deliveredRow.delivered_at;

    // Observable #2: dedupe. Calling deliverMessage again for the
    // same inbox row hits the `delivery.deliveredAt !== null`
    // short-circuit at the top of
    // `OutboundRuntimeEventFanout.deliverMessage` and returns without
    // dispatching a second `runtime_deliver`. Two durable checks:
    //   (a) the DB row's `delivered_at` is unchanged (no rewrite).
    //   (b) `in_flight_owner` / `in_flight_at` stay null (no
    //       transient re-claim that could race a parallel start).
    await harness.backend.context.runtimeHost.deliverMessage(
      conversationId,
      agentId,
      secondMessageId,
    );
    // Give the system a tick window to actually have sent a
    // duplicate if the dedupe had silently failed. We're proving a
    // negative — there's no positive event to wait for — so a
    // short polling window is the honest way to express "we waited
    // and nothing happened".
    await new Promise(resolve => setTimeout(resolve, 250));

    const reCheckRow = db
      .prepare<[string, string, string], InboxRow>(
        `SELECT id, delivered_at, in_flight_owner, in_flight_at
           FROM conversation_inboxes
          WHERE conversation_id = ? AND agent_id = ? AND message_id = ?`,
      )
      .get(conversationId, agentId, secondMessageId);
    expect(reCheckRow).toBeTruthy();
    expect(reCheckRow!.delivered_at).toBe(deliveredAtAfterFirst);
    expect(reCheckRow!.in_flight_owner).toBeNull();
    expect(reCheckRow!.in_flight_at).toBeNull();

    // Observable #3: the live deliver did NOT respawn the runtime — a
    // respawn would emit a fresh session_init parsed event. The
    // count of session_init events recorded since boot is the same
    // before and after the deliver, so the runtime kept its existing
    // process / cli_session_id and the deliver went through the
    // ready WRITE arm (not the SPAWN arm).
    const sessionInitsAfterDeliver = harness.events.filter(
      e =>
        e.frame.kind === 'runtime_parsed_event' &&
        e.frame.parsed.kind === 'session_init',
    ).length;
    expect(sessionInitsAfterDeliver).toBe(sessionInitsBeforeDeliver);
  });
});
