/**
 * D4.b-6 — Standalone G2 backend restart + persistent attach
 * recovery e2e.
 *
 * Layers on B2: spawn the runtime, let `session_init` land, then
 * close the backend cleanly and bring up a NEW backend against
 * the same on-disk state (DB, silverhand dir, host_id,
 * host_token). The daemon — which is still alive across the
 * restart — drops its outbound WS when the old backend closes,
 * polls `daemon-config.json` for the new `server_url`, and
 * reattaches to the new backend. The new backend recovers the
 * host attachment without re-issuing the token or re-claiming
 * the host id.
 *
 * **What this test pins (Cindy boundary #5: "persistent temp
 * data dir + same host token/claim state")**:
 *
 *   1. **Persistent on-disk state**: the second backend boots
 *      against the SAME `dbPath` / `silverhandDir`. The DB row
 *      for the host and its issued token are still there —
 *      `HostTokenService.verifyHostToken` accepts the daemon's
 *      bearer without going through `claimOrCreateLocal` /
 *      `issueHostToken` again.
 *   2. **New connection id, same host id**: after reattach,
 *      `controller.getAttachment(hostId)` returns a non-null
 *      snapshot whose `connectionId` is freshly minted (server-
 *      generated `hostws-*`, different from the pre-restart
 *      connectionId). The hostId itself is unchanged.
 *   3. **Live runtime command after restart**: a new
 *      `runtimeHost.start(...)` triggered after reattach lands a
 *      fresh `session_init` projection in DB. The post-restart
 *      backend talks to the same daemon over a freshly minted
 *      attachment — proving the full e2e path is restored, not
 *      just the heartbeat.
 *   4. **Wire-side parity post-restart**: the second `ready`
 *      frame the wrapper captures is structurally identical to
 *      the first (same B1 schema parse path). The wrapper sink
 *      survives the restart because `restartBackend` plumbs the
 *      same `events` / `disconnects` arrays into the new
 *      backend's `wrapWithStrictRecording` factory.
 *   5. **Reconnect determinism (Cindy boundary #4)**: same
 *      deterministic `OutboundDaemonClient` backoff
 *      (`{minDelayMs: 25, maxDelayMs: 100, factor: 2,
 *      jitterRatio: 0}`) governs the reattach window; bounded
 *      `waitFor` polls catch the reattach without wall-clock
 *      betting.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: same as B1-B5. The Unix socket is bound
 * but unused; the entire test is the outbound WS path.
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

describe('Standalone G2 — backend restart + persistent attach recovery', () => {
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

  it('after backend.close + restart, daemon reattaches using same host_id/host_token and a fresh runtime_start works end-to-end', async () => {
    harness = await bootG2Harness();
    const { db } = harness.backend.context;
    const hostIdBefore = harness.hostId;
    const hostTokenBefore = harness.hostToken;

    const now = Date.now();
    const workspaceId = 'ws-g2-b6';
    const agentId = 'agent-g2-b6';
    const conversationId = 'conv-g2-b6';
    const sessionIdFirst = `g2-b6-session-first-${now}`;
    const workspacePath = join(harness.silverhandDir, 'workspaces', workspaceId);
    mkdirSync(workspacePath, { recursive: true });

    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path,
         workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'g2-b6-workspace', workspacePath, harness.hostId, now, now);
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
      'agent-g2-b6-name',
      harness.hostId,
      now,
      now,
      'Agent G2 B6',
      harness.userId,
    );
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(workspaceId, agentId, now);
    db.prepare(
      `INSERT INTO conversations
        (id, workspace_id, workspace_path, kind,
title, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
        VALUES (?, ?, ?, 'channel', ?, 'active', NULL, NULL, NULL,
                NULL, ?, ?)`,
    ).run(conversationId, workspaceId, workspacePath, 'g2-b6-channel', now, now);
    db.prepare(
      `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(conversationId, harness.userId, now);
    db.prepare(
      `INSERT INTO conversation_agents
        (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
        VALUES (?, ?, NULL, NULL, 'idle', ?)`,
    ).run(conversationId, agentId, now);

    const firstMessageId = 'msg-g2-b6-first';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
    ).run(firstMessageId, conversationId, harness.userId, 'first message', now);
    new ConversationInboxRepo(db).enqueue(conversationId, agentId, firstMessageId);

    // The daemon is built ONCE and stays alive across the
    // backend restart. The driver factory closes over a mutable
    // `pendingSessionId` so the second start uses a fresh
    // session id (mirrors a real cli `--resume` that would mint
    // a new session on a clean spawn).
    let pendingSessionId = sessionIdFirst;
    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeSessionInitDriver(pendingSessionId),
    });

    const controller1 = harness.backend.context.hostWsController?.();
    if (!controller1) throw new Error('controller missing pre-restart');
    const attached1 = await waitForAttachment(controller1, hostIdBefore);
    const connectionIdBefore = attached1.connectionId;
    const serverUrlBefore = harness.serverUrl;

    await harness.backend.context.runtimeHost.start(conversationId, agentId);
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        return row && row.cli_session_id === sessionIdFirst ? true : null;
      },
      { timeoutMs: 10_000, label: 'first session_init projection' },
    );

    // Snapshot host_credentials DB state pre-restart so the
    // assertion can prove `restartBackend` did NOT re-issue a new
    // token. `HostTokenService.issueHostToken` always inserts a
    // new row in `host_credentials`; a re-issue would increment
    // the count.
    const credentialRowsBefore = harness.backend.context.db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count FROM host_credentials WHERE host_id = ?`,
      )
      .get(hostIdBefore)?.count;
    expect(credentialRowsBefore).toBe(1);

    // ── Backend restart ─────────────────────────────────────────
    //
    // `restartBackend` closes the current backend (releases the
    // port), boots a fresh one against the same dbPath +
    // silverhandDir, and rewrites daemon-config.json with the new
    // bound port. The daemon's OutboundDaemonClient sees the
    // config swap on its next 50ms poll and reconnects to the
    // new URL using the SAME host_id / host_token.
    await harness.restartBackend();
    const serverUrlAfter = harness.serverUrl;
    expect(serverUrlAfter).not.toBe(serverUrlBefore);
    // Token survives the restart — same value on the harness, and
    // host_credentials row count is unchanged (no new INSERT).
    expect(harness.hostToken).toBe(hostTokenBefore);
    const credentialRowsAfter = harness.backend.context.db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count FROM host_credentials WHERE host_id = ?`,
      )
      .get(hostIdBefore)?.count;
    expect(credentialRowsAfter).toBe(credentialRowsBefore);

    // ── Reattach (Cindy boundary #4: deterministic) ─────────────
    //
    // The new backend's controller initially reports no
    // attachment for `hostIdBefore`; we wait for the daemon to
    // reconnect on its config-poll cadence (50ms) and the new
    // backend's authenticateHost path to register a fresh
    // connection. New connectionId proves it's a NEW attachment.
    //
    // **D4.c C9-2** — use `waitForFreshAttachment` with the explicit
    // pre-restart connectionId rather than `waitForAttachment`'s
    // "any non-null" predicate. This makes the wait predicate
    // semantically precise: we are waiting for a fresh `hostws-*`
    // connectionId distinct from the pre-restart one, not for "any
    // non-null entry". Defensive harness cleanup; not a fix for any
    // proven product race.
    const controller2 = harness.backend.context.hostWsController?.();
    if (!controller2) throw new Error('controller missing post-restart');
    const attached2 = await waitForFreshAttachment(
      controller2,
      hostIdBefore,
      connectionIdBefore,
    );
    expect(attached2.hostId).toBe(hostIdBefore);
    expect(attached2.connectionId).toMatch(/^hostws-/);
    expect(attached2.connectionId).not.toBe(connectionIdBefore);

    // ── E2E sanity post-restart: a second runtime_start works ───
    //
    // The original runtime is still spawned (the daemon never
    // restarted); the supervisor sees the original handle and
    // delivers to that runtime rather than respawning. To prove the
    // post-restart backend can ALSO dispatch a brand-new spawn,
    // first stop the existing runtime, then seed a fresh inbox
    // message + start. The new session_init projection lands in
    // DB via the post-restart backend's fanout.
    await harness.backend.context.runtimeHost.stop(
      conversationId,
      agentId,
    );
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<
            [string, string],
            { status: string; pid: number | null }
          >(
            `SELECT status, pid FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        if (!row) return null;
        if (row.status !== 'idle') return null;
        if (row.pid !== null) return null;
        return true;
      },
      { timeoutMs: 10_000, label: 'post-restart stop projection' },
    );

    const sessionIdSecond = `g2-b6-session-second-${Date.now()}`;
    pendingSessionId = sessionIdSecond;
    const secondMessageId = 'msg-g2-b6-second';
    harness.backend.context.db
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, from_kind, from_agent_id, from_user_id,
           content, metadata, seq, created_at)
          VALUES (?, ?, 'user', NULL, ?, ?, NULL, 2, ?)`,
      )
      .run(secondMessageId, conversationId, harness.userId, 'second message', Date.now());
    new ConversationInboxRepo(harness.backend.context.db).enqueue(
      conversationId,
      agentId,
      secondMessageId,
    );

    await harness.backend.context.runtimeHost.start(conversationId, agentId);
    await waitFor(
      () => {
        const row = harness!.backend.context.db
          .prepare<[string, string], { cli_session_id: string | null }>(
            `SELECT cli_session_id FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId);
        return row && row.cli_session_id === sessionIdSecond ? true : null;
      },
      {
        timeoutMs: 10_000,
        label: 'post-restart second session_init projection',
        // D4.c C9-2 (Cindy `mWQVcAFMbuzFfd3U`): an intermittent
        // flake on this waitFor was observed under suite-load on
        // earlier branch tips; reproduction attempts post-C9-1
        // across 12 isolated + 5 full-suite runs did not surface
        // it again, so the root cause was not directly captured.
        // Leave this `onTimeout` diagnostic in place permanently
        // so the next occurrence (in CI or local) attaches the
        // observable state to the thrown error message — DB row,
        // controller attachment connectionId, fanout state slot
        // count for this (host, cid, aid) — without requiring a
        // re-run to gather evidence.
        onTimeout: () => {
          const dbRow = harness?.backend.context.db
            .prepare<
              [string, string],
              { cli_session_id: string | null; status: string; pid: number | null }
            >(
              `SELECT cli_session_id, status, pid FROM conversation_agents
                WHERE conversation_id = ? AND agent_id = ?`,
            )
            .get(conversationId, agentId);
          const controllerNow = harness?.backend.context.hostWsController?.();
          const attachmentNow =
            controllerNow?.getAttachment(hostIdBefore) ?? null;
          return {
            expectedSessionId: sessionIdSecond,
            dbRow: dbRow ?? null,
            attachmentNow,
            activeConnections: controllerNow?.activeConnectionCount() ?? null,
            connectionIdMatchesPostRestart:
              attachmentNow?.connectionId === attached2.connectionId,
          };
        },
      },
    );
    // Final assertion: the post-restart backend's
    // conversation_agents row now carries the second session id.
    // Proves the entire path (outbound dispatch, daemon supervisor,
    // fanout, projection) is fully operational on the new backend.
    const finalRow = harness.backend.context.db
      .prepare<
        [string, string],
        { status: string; cli_session_id: string | null }
      >(
        `SELECT status, cli_session_id FROM conversation_agents
          WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(conversationId, agentId);
    expect(finalRow).toBeTruthy();
    expect(finalRow!.status).toBe('active');
    expect(finalRow!.cli_session_id).toBe(sessionIdSecond);
  });
});
