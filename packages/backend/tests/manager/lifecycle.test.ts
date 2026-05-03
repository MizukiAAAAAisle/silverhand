import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManagerHarness,
  readStdinLog,
  type ManagerHarness,
} from '../utils/manager.js';

function waitInit(h: ManagerHarness): Promise<void> {
  return h
    .waitForEvent(
      e =>
        e.kind === 'agent_event' &&
        (e.payload as any)?.event?.kind === 'session_init',
    )
    .then(() => undefined);
}

function waitStatus(
  h: ManagerHarness,
  status: 'starting' | 'active' | 'idle' | 'crashed',
): Promise<unknown> {
  return h.waitForEvent(
    e =>
      e.kind === 'agent_status' && (e.payload as any)?.status === status,
  );
}

function dbStatus(
  h: ManagerHarness,
): { status: string; cli_session_id: string | null; pid: number | null } {
  return h.ctx.db
    .prepare<
      [string, string],
      { status: string; cli_session_id: string | null; pid: number | null }
    >(
      `SELECT status, cli_session_id, pid FROM session_agents
       WHERE session_id = ? AND agent_id = ?`,
    )
    .get(h.sessionId, h.agentId)!;
}

describe('SessionManager.start', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('publishes status=starting before init, then status=active on init', async () => {
    h = await buildManagerHarness();
    const seen: string[] = [];
    h.on(e => {
      if (e.kind === 'agent_status') seen.push((e.payload as any).status);
    });
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    // small grace for the active event to flush
    await new Promise(r => setTimeout(r, 50));
    expect(seen).toEqual(['starting', 'active']);
  });

  it('records the spawned PID and clears it on exit', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({ MOCK_CLAUDE_EXIT_AFTER_INIT_MS: '50' });
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    const live = dbStatus(h);
    expect(live.pid).toBeGreaterThan(0);
    expect(live.status).toBe('active');

    await waitStatus(h, 'idle');
    const after = dbStatus(h);
    expect(after.pid).toBeNull();
    expect(after.status).toBe('idle');
  });

  it('is idempotent — second start while running is a no-op', async () => {
    h = await buildManagerHarness();
    let starts = 0;
    h.on(e => {
      if (e.kind === 'agent_status' && (e.payload as any).status === 'starting') {
        starts++;
      }
    });
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    await h.manager.start(h.sessionId, h.agentId);
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(true);
    expect(starts).toBe(1);
  });

  it('throws when session is closed', async () => {
    h = await buildManagerHarness();
    h.ctx.db
      .prepare(`UPDATE sessions SET closed_at = ? WHERE id = ?`)
      .run(Date.now(), h.sessionId);
    await expect(h.manager.start(h.sessionId, h.agentId)).rejects.toThrow(
      /closed/,
    );
  });
});

describe('SessionManager exit handling', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('non-zero exit (without intentional stop) → status=crashed', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({
      MOCK_CLAUDE_EXIT_CODE: '7',
      MOCK_CLAUDE_EXIT_AFTER_INIT_MS: '20',
    });
    await h.manager.start(h.sessionId, h.agentId);
    const ev = await waitStatus(h, 'crashed');
    expect((ev as any).payload.exit_code).toBe(7);
    expect(dbStatus(h).status).toBe('crashed');
  });

  it('clean exit (code 0) → status=idle', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({
      MOCK_CLAUDE_EXIT_CODE: '0',
      MOCK_CLAUDE_EXIT_AFTER_INIT_MS: '20',
    });
    await h.manager.start(h.sessionId, h.agentId);
    await waitStatus(h, 'idle');
    expect(dbStatus(h).status).toBe('idle');
  });
});

describe('SessionManager.stop', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('hard: writes control_request to stdin; mock exits → status=idle (intentional)', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);

    const exited = waitStatus(h, 'idle');
    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    await exited;

    const lines = await readStdinLog(h.stdinLog);
    const control = lines.find(l => l.includes('"control_request"'));
    expect(control).toBeDefined();
    expect(JSON.parse(control!).request.subtype).toBe('interrupt');
  });

  it('soft: writes a user message (directive) and does NOT exit', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);

    await h.manager.stop(h.sessionId, h.agentId, 'soft', 'pause please');
    // give mock a moment to log the line
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const userMsg = lines.find(l => l.includes('pause please'));
    expect(userMsg).toBeDefined();
    const parsed = JSON.parse(userMsg!);
    expect(parsed.type).toBe('user');
    expect(parsed.message.content[0].text).toBe('pause please');

    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(true);
  });

  it('stop on a not-running pair is a silent no-op', async () => {
    h = await buildManagerHarness();
    await expect(
      h.manager.stop(h.sessionId, h.agentId, 'hard'),
    ).resolves.toBeUndefined();
  });

  it('stopAll terminates every running handle', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(true);

    const exited = waitStatus(h, 'idle');
    await h.manager.stopAll();
    await exited;
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
  });
});

describe('SessionManager.deliverMessage', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('agent NOT running → enqueues to inbox, does NOT throw', async () => {
    h = await buildManagerHarness();
    // insert a message row to deliver
    const msg = h.ctx.db
      .prepare<[string, string, string, number], { id: string }>(
        `INSERT INTO messages (id, session_id, from_kind, from_agent_id,
            from_user_id, content, metadata, seq, created_at)
         VALUES (?, ?, 'user', NULL, NULL, ?, NULL, 1, ?)
         RETURNING id`,
      )
      .get('msg-pre-1', h.sessionId, 'queued while asleep', Date.now())!;

    await h.manager.deliverMessage(h.sessionId, h.agentId, msg.id);

    const pending = h.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM agent_inboxes
         WHERE session_id = ? AND agent_id = ? AND delivered_at IS NULL`,
      )
      .get(h.sessionId, h.agentId);
    expect(pending?.c).toBe(1);
  });

  it('agent running → writes user message to stdin (gated, but boundary safe at idle)', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);

    h.ctx.db
      .prepare(
        `INSERT INTO messages (id, session_id, from_kind, from_agent_id,
            from_user_id, content, metadata, seq, created_at)
         VALUES (?, ?, 'user', NULL, NULL, ?, NULL, 1, ?)`,
      )
      .run('msg-live-1', h.sessionId, 'live ping', Date.now());

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-live-1');
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const live = lines.find(l => l.includes('live ping'));
    expect(live).toBeDefined();
    const parsed = JSON.parse(live!);
    expect(parsed.type).toBe('user');
    expect(parsed.message.content[0].text).toContain('live ping');
    expect(parsed.message.content[0].text).toContain('New message from user');
  });
});

describe('SessionManager inbox drain on init', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('on session_init, pending inbox items are written as ONE combined user message + marked delivered', async () => {
    h = await buildManagerHarness();
    // Pre-seed two queued messages
    const ids = ['m1', 'm2'];
    let seq = 0;
    for (const id of ids) {
      seq++;
      h.ctx.db
        .prepare(
          `INSERT INTO messages (id, session_id, from_kind, from_agent_id,
              from_user_id, content, metadata, seq, created_at)
           VALUES (?, ?, 'user', NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(id, h.sessionId, `queued-${id}`, seq, Date.now());
      h.ctx.db
        .prepare(
          `INSERT INTO agent_inboxes (session_id, agent_id, message_id,
              delivered_at, created_at)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(h.sessionId, h.agentId, id, Date.now());
    }

    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    // Drain runs after init; allow it to finish.
    await new Promise(r => setTimeout(r, 80));

    const lines = await readStdinLog(h.stdinLog);
    const drainLine = lines.find(l => l.includes('queued-m1'));
    expect(drainLine).toBeDefined();
    const parsed = JSON.parse(drainLine!);
    expect(parsed.type).toBe('user');
    const text = parsed.message.content[0].text;
    expect(text).toContain('queued-m1');
    expect(text).toContain('queued-m2');
    expect(text).toContain('2 messages waiting');

    // Both inbox rows are now delivered_at = some timestamp
    const remaining = h.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM agent_inboxes
         WHERE session_id = ? AND agent_id = ? AND delivered_at IS NULL`,
      )
      .get(h.sessionId, h.agentId);
    expect(remaining?.c).toBe(0);
  });
});

describe('SessionManager.reconcileOnBoot', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('flips orphaned starting/active session_agents rows back to idle (preserves cli_session_id)', async () => {
    h = await buildManagerHarness();
    h.ctx.db
      .prepare(
        `UPDATE session_agents
         SET status = 'active', pid = 99999, cli_session_id = 'cli-stale'
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(h.sessionId, h.agentId);

    h.manager.reconcileOnBoot();

    const row = dbStatus(h);
    expect(row.status).toBe('idle');
    expect(row.pid).toBeNull();
    expect(row.cli_session_id).toBe('cli-stale');
  });

  it('is a no-op when no stale rows exist', () => {
    // Just verify it doesn't throw on the bootstrapped harness state
    // (session_agent has status='idle' from addAgent).
    return buildManagerHarness().then(async harness => {
      h = harness;
      const before = dbStatus(h);
      h.manager.reconcileOnBoot();
      expect(dbStatus(h)).toEqual(before);
    });
  });
});

describe('SessionManager init watchdog', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('fires when session_init never arrives → publishes init_timeout + crashes the agent', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 150;

    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    const crashed = waitStatus(h, 'crashed');

    await h.manager.start(h.sessionId, h.agentId);
    const ev = await timeout;
    expect((ev.payload as any).agent_id).toBe(h.agentId);
    expect((ev.payload as any).elapsed_ms).toBe(150);

    const exit = await crashed;
    expect((exit as any).payload.reason).toBe('init_timeout');
    expect(dbStatus(h).status).toBe('crashed');
    expect(dbStatus(h).pid).toBeNull();
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
  });

  it('does NOT fire when session_init lands in time', async () => {
    h = await buildManagerHarness();
    // Pick a window comfortably above mock-claude's spawn + init time
    // (~100ms in CI) so a healthy startup doesn't race the timer.
    h.manager.initWatchdogMs = 1_000;

    let timedOut = false;
    h.on(e => {
      if (e.kind === 'agent_init_timeout') timedOut = true;
    });

    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    // Wait past the watchdog window — if it weren't cleared, it would
    // fire here.
    await new Promise(r => setTimeout(r, 1_200));

    expect(timedOut).toBe(false);
    expect(dbStatus(h).status).toBe('active');
  });

  it('hard-stop before init clears the watchdog (no spurious init_timeout)', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 200;

    let timedOut = false;
    h.on(e => {
      if (e.kind === 'agent_init_timeout') timedOut = true;
    });

    await h.manager.start(h.sessionId, h.agentId);
    // Stop before the watchdog window expires.
    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    await waitStatus(h, 'idle');
    // Wait past the original window — confirm timer didn't survive stop.
    await new Promise(r => setTimeout(r, 300));

    expect(timedOut).toBe(false);
    // Intentional stop → idle, NOT crashed.
    expect(dbStatus(h).status).toBe('idle');
  });
});
