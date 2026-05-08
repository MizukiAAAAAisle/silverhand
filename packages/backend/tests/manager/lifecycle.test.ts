import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function waitActivity(
  h: ManagerHarness,
  predicate: (payload: any) => boolean,
): Promise<any> {
  return h
    .waitForEvent(
      e => e.kind === 'agent_activity' && predicate(e.payload as any),
    )
    .then(e => e.payload as any);
}

async function waitForStdinLines(
  h: ManagerHarness,
  predicate: (lines: string[]) => boolean,
  timeoutMs = 2_000,
): Promise<string[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const lines = await readStdinLog(h.stdinLog);
    if (predicate(lines)) return lines;
    await new Promise(r => setTimeout(r, 10));
  }
  const lines = await readStdinLog(h.stdinLog);
  expect(lines).toSatisfy(predicate);
  return lines;
}

function dbStatus(
  h: ManagerHarness,
): { status: string; cli_session_id: string | null; pid: number | null } {
  return h.ctx.db
    .prepare<
      [string, string],
      { status: string; cli_session_id: string | null; pid: number | null }
    >(
      `SELECT status, cli_session_id, pid FROM conversation_agents
       WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(h.sessionId, h.agentId)!;
}

function insertUserMessage(
  h: ManagerHarness,
  id: string,
  content: string,
  seq = 1,
): void {
  h.ctx.db
    .prepare(
      `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
          from_user_id, content, metadata, seq, created_at)
       VALUES (?, ?, 'user', NULL, NULL, ?, NULL, ?, ?)`,
    )
    .run(id, h.sessionId, content, seq, Date.now());
}

function enqueuePendingUserMessage(
  h: ManagerHarness,
  id: string,
  content: string,
  seq = 1,
): void {
  insertUserMessage(h, id, content, seq);
  h.ctx.db
    .prepare(
      `INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id,
          delivered_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(h.sessionId, h.agentId, id, Date.now());
}

function insertSystemMessage(
  h: ManagerHarness,
  id: string,
  content: string,
  seq = 1,
): void {
  h.ctx.db
    .prepare(
      `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
          from_user_id, content, metadata, seq, created_at)
       VALUES (?, ?, 'system', NULL, NULL, ?, NULL, ?, ?)`,
    )
    .run(id, h.sessionId, content, seq, Date.now());
}

function insertAgentMessage(
  h: ManagerHarness,
  id: string,
  content: string,
  seq = 1,
): void {
  h.ctx.db
    .prepare(
      `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
          from_user_id, content, metadata, seq, created_at)
       VALUES (?, ?, 'agent', ?, NULL, ?, NULL, ?, ?)`,
    )
    .run(id, h.sessionId, h.agentId, content, seq, Date.now());
}

function liveHandle(h: ManagerHarness): unknown {
  return (h.manager as unknown as {
    handles: Map<string, unknown>;
  }).handles.get(`${h.sessionId}:${h.agentId}`);
}

function feedParsedEvent(h: ManagerHarness, event: unknown): void {
  const handle = liveHandle(h);
  expect(handle).toBeDefined();
  (h.manager as unknown as {
    handleParsedEvent(handle: unknown, event: unknown): void;
  }).handleParsedEvent(handle, event);
}

describe('ConversationManager.start', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('publishes status=starting before init, then status=active on init', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'start-kickoff-1', 'kickoff');
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
    enqueuePendingUserMessage(h, 'start-idempotent-1', 'kickoff');
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

  it('throws when conversation is closed', async () => {
    h = await buildManagerHarness();
    h.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
      .run(Date.now(), h.sessionId);
    await expect(h.manager.start(h.sessionId, h.agentId)).rejects.toThrow(
      /closed/,
    );
  });
});

describe('ConversationManager exit handling', () => {
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

describe('ConversationManager.stop', () => {
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

  // Regression: stop(hard) used to register SIGTERM/SIGKILL timers only
  // AFTER awaiting writeLine(control_request). If writeLine blocked on a
  // wedged stdin, the timers never armed and stop() hung forever (until the
  // 15s main-process watchdog force-quit the app). The fix arms timers first
  // and fires writeLine as fire-and-forget.
  it('SIGTERM fallback fires even when the CLI ignores control_request', async () => {
    h = await buildManagerHarness();
    h.manager.stopSigtermMs = 200;   // don't wait 5s in tests
    h.manager.stopSigkillMs = 500;
    h.setMockEnv({ MOCK_CLAUDE_IGNORE_INTERRUPT: '1' });

    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);

    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    // stop() must have resolved (child is dead), not hung.
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
    expect(dbStatus(h).pid).toBeNull();
    // The child was killed by a signal (SIGTERM), so DB status is idle
    // (intentionallyStopped = true suppresses crashed).
    expect(dbStatus(h).status).toBe('idle');
  });

  // Original regression: stop(hard) used to schedule SIGTERM/SIGKILL via
  // unref'd setTimeout and return synchronously, so callers had no way to
  // know when the spawn graph was gone. New contract: hard stop awaits the
  // child's `exit` event before resolving.
  it('hard stop does not resolve until the child has exited', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    const handle = (h.manager as unknown as {
      handles: Map<string, { child: { exitCode: number | null } }>;
    }).handles.get(`${h.sessionId}:${h.agentId}`);
    expect(handle?.child.exitCode).toBeNull();

    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    // After stop returns, the child must already be reaped. The handle
    // has been deleted from the map by the exit handler, so we check
    // via isRunning + DB pid clear.
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
    expect(dbStatus(h).pid).toBeNull();
    expect(dbStatus(h).status).toBe('idle');
  });
});

describe('ConversationManager.deliverMessage', () => {
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
        `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
            from_user_id, content, metadata, seq, created_at)
         VALUES (?, ?, 'user', NULL, NULL, ?, NULL, 1, ?)
         RETURNING id`,
      )
      .get('msg-pre-1', h.sessionId, 'queued while asleep', Date.now())!;

    await h.manager.deliverMessage(h.sessionId, h.agentId, msg.id);

    const pending = h.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversation_inboxes
         WHERE conversation_id = ? AND agent_id = ? AND delivered_at IS NULL`,
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
        `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
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
    expect(parsed.message.content[0].text).toContain('mcp__chat__send_message');
    expect(parsed.message.content[0].text).toContain(
      'Complete ALL your work before stopping',
    );
  });

  it('adds an explicit must-reply hint when a user @mentions the recipient', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-mention-1', '@mock ？还在工作吗');

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-mention-1');
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const live = lines.find(l => l.includes('还在工作吗'));
    expect(live).toBeDefined();
    const text = JSON.parse(live!).message.content[0].text;
    expect(text).toContain(
      '[user addressed you by name; a visible reply is expected.]',
    );
    expect(text).toContain('mcp__chat__send_message');
  });

  it('does not inject reply pressure for plain agent messages', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertAgentMessage(
      h,
      'msg-agent-plain-1',
      'I finished my implementation slice',
    );

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-agent-plain-1');
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const live = lines.find(l => l.includes('implementation slice'));
    expect(live).toBeDefined();
    const text = JSON.parse(live!).message.content[0].text;
    expect(text).toContain('This is an agent message not addressed to you');
    expect(text).toContain('No reply is needed unless');
    expect(text).toContain(
      "Do not acknowledge, summarize, or restate another agent's work",
    );
    expect(text).not.toContain('mcp__chat__send_message');
    expect(text).not.toContain('Respond as appropriate');
  });

  it('still requires a visible reply when an agent @mentions the recipient', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertAgentMessage(h, 'msg-agent-mention-1', '@mock please review this plan');

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-agent-mention-1');
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const live = lines.find(l => l.includes('please review this plan'));
    expect(live).toBeDefined();
    const text = JSON.parse(live!).message.content[0].text;
    expect(text).toContain(
      '[sender addressed you by name; a visible reply is expected.]',
    );
    expect(text).toContain('mcp__chat__send_message');
  });

  it('narrows user messages addressed to another agent to owner/blocker replies', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-other-agent-user-1', '@Alice please handle this');

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-other-agent-user-1');
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const live = lines.find(l => l.includes('@Alice please handle this'));
    expect(live).toBeDefined();
    const text = JSON.parse(live!).message.content[0].text;
    expect(text).toContain('The user message appears addressed to another agent');
    expect(text).toContain(
      'Do not call `mcp__chat__send_message` unless you own or were assigned',
    );
    expect(text).toContain('must flag a concrete blocker');
    expect(text).not.toContain('unique value to add');
    expect(text).not.toContain('visible reply is expected');
  });

  it('keeps system announcements informational unless they explicitly ask', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertSystemMessage(h, 'msg-system-1', '@mock joined the session');

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-system-1');
    await new Promise(r => setTimeout(r, 50));

    const lines = await readStdinLog(h.stdinLog);
    const live = lines.find(l => l.includes('joined the session'));
    expect(live).toBeDefined();
    const text = JSON.parse(live!).message.content[0].text;
    expect(text).toContain('System messages do not require a reply');
    expect(text).not.toContain('visible reply is expected');
  });

  it('repeats the reply instruction when flushing a gated delivery batch', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    feedParsedEvent(h, { kind: 'tool_call', name: 'Bash', input: {} });
    insertUserMessage(h, 'msg-busy-1', 'first busy message', 1);
    insertUserMessage(h, 'msg-busy-2', 'second busy message', 2);

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-busy-1');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-busy-2');
    feedParsedEvent(h, { kind: 'turn_end' });
    await new Promise(r => setTimeout(r, 80));

    const lines = await readStdinLog(h.stdinLog);
    const batch = lines.find(l => l.includes('2 new messages'));
    expect(batch).toBeDefined();
    const text = JSON.parse(batch!).message.content[0].text;
    expect(text).toContain('first busy message');
    expect(text).toContain('second busy message');
    expect(text).toContain('mcp__chat__send_message');
    expect(text).toContain('Complete ALL your work before stopping');
  });
});

describe('ConversationManager agent run activity', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('publishes thinking run state after a live delivery and resolves it on reply', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-1', 'think about this');

    const thinking = waitActivity(h, p => p.status === 'thinking');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-1');
    const run = await thinking;

    expect(run.agentId).toBe(h.agentId);
    expect(run.conversationId).toBe(h.sessionId);
    expect(typeof run.runId).toBe('string');
    expect(h.manager.getAgentRunStates(h.sessionId)).toHaveLength(1);

    const idle = waitActivity(
      h,
      p => p.status === 'idle' && p.terminalReason === 'replied',
    );
    h.manager.resolveRun(h.sessionId, h.agentId, 'replied', run.runId);
    await idle;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);
  });

  it('keeps the newer run when an old runId resolves late', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-old', 'first', 1);
    insertUserMessage(h, 'msg-run-new', 'second', 2);

    const firstP = waitActivity(h, p => p.status === 'thinking');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-old');
    const first = await firstP;

    const replacedP = waitActivity(
      h,
      p =>
        p.runId === first.runId &&
        p.status === 'idle' &&
        p.terminalReason === 'replaced',
    );
    const secondP = waitActivity(
      h,
      p => p.status === 'thinking' && p.runId !== first.runId,
    );
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-new');
    const second = await secondP;
    await replacedP;

    h.manager.resolveRun(h.sessionId, h.agentId, 'replied', first.runId);
    expect(h.manager.getAgentRunStates(h.sessionId)[0]?.runId).toBe(second.runId);
  });

  it('preserves the current direct-mode run when steering an active agent', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-direct-1', 'first', 1);
    insertUserMessage(h, 'msg-run-direct-2', 'steer', 2);

    const handle = liveHandle(h) as {
      driver: { busyDeliveryMode: 'gated' | 'direct' | 'none' };
    };
    handle.driver.busyDeliveryMode = 'direct';

    const firstP = waitActivity(h, p => p.status === 'thinking');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-direct-1');
    const first = await firstP;

    feedParsedEvent(h, { kind: 'tool_call', name: 'Read', input: {} });
    expect(h.manager.getAgentRunStates(h.sessionId)[0]?.toolCallCounts).toEqual({
      Read: 1,
    });

    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-direct-2');
    const state = h.manager.getAgentRunStates(h.sessionId)[0]!;
    expect(state.runId).toBe(first.runId);
    expect(state.status).toBe('thinking');
    expect(state.toolCallCounts).toEqual({ Read: 1 });
  });

  it('clears a thinking run as failed when hard stop is requested', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-stop', 'please work');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-stop');

    const failed = waitActivity(
      h,
      p => p.status === 'failed' && p.terminalReason === 'stopped',
    );
    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    await failed;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);
  });

  it('clears a thinking run as failed on runtime crash', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({
      MOCK_CLAUDE_EXIT_CODE: '7',
      MOCK_CLAUDE_EXIT_AFTER_INIT_MS: '50',
    });
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-crash', 'crash while working');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-crash');

    const failed = waitActivity(
      h,
      p => p.status === 'failed' && p.terminalReason === 'crashed',
    );
    await failed;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);
  });

  it('clears a thinking run as idle when a turn ends without a chat reply', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-turn-end', 'finish without sending');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-turn-end');

    const idle = waitActivity(
      h,
      p => p.status === 'idle' && p.terminalReason === 'turn_ended',
    );
    feedParsedEvent(h, { kind: 'turn_end' });
    await idle;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);
  });

  it('defers turn_end cleanup until compaction reaches a safe boundary', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-compact-turn-end', 'compact then finish');
    await h.manager.deliverMessage(
      h.sessionId,
      h.agentId,
      'msg-run-compact-turn-end',
    );

    feedParsedEvent(h, { kind: 'compaction_started' });
    const compacting = h.manager.getAgentRunStates(h.sessionId)[0]!;
    expect(compacting.compacting).toBe(true);
    expect(compacting.compactingSince).toEqual(expect.any(Number));
    expect(compacting.compactionStale).toBe(false);
    feedParsedEvent(h, { kind: 'turn_end' });
    expect(h.manager.getAgentRunStates(h.sessionId)).toHaveLength(1);

    const idle = waitActivity(
      h,
      p => p.status === 'idle' && p.terminalReason === 'turn_ended',
    );
    feedParsedEvent(h, { kind: 'compaction_finished' });
    await idle;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);
  });

  it('materializes a new run from raw activity after a turn_end cleared the previous run', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-rematerialize', 'finish then keep working');

    const firstP = waitActivity(h, p => p.status === 'thinking');
    await h.manager.deliverMessage(
      h.sessionId,
      h.agentId,
      'msg-run-rematerialize',
    );
    const first = await firstP;

    const idle = waitActivity(
      h,
      p =>
        p.runId === first.runId &&
        p.status === 'idle' &&
        p.terminalReason === 'turn_ended',
    );
    feedParsedEvent(h, { kind: 'turn_end' });
    await idle;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);

    const rematerializedP = waitActivity(
      h,
      p => p.status === 'thinking' && p.runId !== first.runId,
    );
    feedParsedEvent(h, { kind: 'thinking', text: '' });
    const rematerialized = await rematerializedP;
    expect(h.manager.getAgentRunStates(h.sessionId)[0]?.runId).toBe(
      rematerialized.runId,
    );

    const toolP = waitActivity(
      h,
      p =>
        p.runId === rematerialized.runId &&
        p.status === 'tool_running' &&
        p.toolCallCounts?.Bash === 1,
    );
    feedParsedEvent(h, { kind: 'tool_call', name: 'Bash', input: {} });
    await toolP;

    const secondIdle = waitActivity(
      h,
      p =>
        p.runId === rematerialized.runId &&
        p.status === 'idle' &&
        p.terminalReason === 'turn_ended',
    );
    feedParsedEvent(h, { kind: 'turn_end' });
    await secondIdle;
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);

    const outputP = waitActivity(
      h,
      p => p.status === 'thinking' && p.runId !== rematerialized.runId,
    );
    feedParsedEvent(h, { kind: 'tool_output', name: 'Bash' });
    const outputRun = await outputP;
    expect(h.manager.getAgentRunStates(h.sessionId)[0]?.runId).toBe(
      outputRun.runId,
    );
  });

  it('turns fatal Codex resume errors into a crashed status and clears stale cli_session_id', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    expect(dbStatus(h).cli_session_id).not.toBeNull();

    insertUserMessage(h, 'msg-run-thread-missing', 'resume missing thread');
    await h.manager.deliverMessage(
      h.sessionId,
      h.agentId,
      'msg-run-thread-missing',
    );

    const failed = waitActivity(
      h,
      p => p.status === 'failed' && p.terminalReason === 'crashed',
    );
    const crashed = h.waitForEvent(
      e =>
        e.kind === 'agent_status' &&
        (e.payload as any)?.status === 'crashed' &&
        (e.payload as any)?.reason === 'thread_not_found',
    );
    feedParsedEvent(h, {
      kind: 'error',
      message: 'thread not found: thread-stale',
      code: 'thread_not_found',
      fatal: true,
    });

    await crashed;
    await failed;
    expect(dbStatus(h)).toMatchObject({
      status: 'crashed',
      cli_session_id: null,
      pid: null,
    });
    expect(h.manager.getAgentRunStates(h.sessionId)).toEqual([]);
  });

  it('heartbeat updates updatedAt without changing lastActivityAt', async () => {
    h = await buildManagerHarness();
    h.manager.activityHeartbeatMs = 30;
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-heartbeat', 'long work');

    const thinkingP = waitActivity(h, p => p.status === 'thinking');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-heartbeat');
    const thinking = await thinkingP;

    const heartbeat = await waitActivity(
      h,
      p => p.runId === thinking.runId && p.updatedAt > thinking.updatedAt,
    );
    expect(heartbeat.lastActivityAt).toBe(thinking.lastActivityAt);
  });

  it('accumulates thinking/text deltas as a latest-window activitySnippet', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-snippet', 'long work');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-snippet');

    feedParsedEvent(h, { kind: 'thinking', text: 'raw ' });
    feedParsedEvent(h, { kind: 'thinking', text: 'reasoning' });
    feedParsedEvent(h, { kind: 'thinking', text: ' token' });
    expect(h.manager.getAgentRunStates(h.sessionId)[0]?.activitySnippet).toBe(
      'raw reasoning token',
    );

    const text =
      'visible answer delta with enough text to exceed the activity snippet limit '.repeat(2);
    feedParsedEvent(h, { kind: 'text', text });
    feedParsedEvent(h, { kind: 'text', text: 'tail' });

    const state = h.manager.getAgentRunStates(h.sessionId)[0]!;
    expect(state.activitySnippet).toBe(
      `${text}tail`.replace(/\s+/g, ' ').trim().slice(-200),
    );
  });

  it('records per-run toolCallCounts in first-seen order with repeats counted', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-tools', 'use tools');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-tools');

    feedParsedEvent(h, { kind: 'tool_call', name: 'Bash', input: {} });
    feedParsedEvent(h, { kind: 'tool_call', name: 'Read', input: {} });
    feedParsedEvent(h, { kind: 'tool_call', name: 'Bash', input: {} });
    feedParsedEvent(h, { kind: 'tool_call', name: 'mcp__chat__send_message', input: {} });

    const state = h.manager.getAgentRunStates(h.sessionId)[0]!;
    expect(state.status).toBe('tool_running');
    expect(state.detail).toBe('mcp__chat__send_message');
    expect(state.toolCallCounts).toEqual({ Bash: 2, Read: 1 });
  });

  it('sanitizes large tool_call inputs before raw agent_event broadcast', async () => {
    h = await buildManagerHarness();
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    insertUserMessage(h, 'msg-run-raw-tool', 'write a large file');
    await h.manager.deliverMessage(h.sessionId, h.agentId, 'msg-run-raw-tool');

    const largeContent = 'x'.repeat(5_000);
    const toolEvent = {
      kind: 'tool_call',
      name: 'Write',
      input: {
        file_path: 'src/large.ts',
        content: largeContent,
        nested: { old_string: largeContent },
        chunks: Array.from({ length: 25 }, (_, i) => `${i}:${largeContent}`),
      },
    };
    const rawEventP = h.waitForEvent(
      e =>
        e.kind === 'agent_event' &&
        (e.payload as any)?.event?.kind === 'tool_call' &&
        (e.payload as any)?.event?.name === 'Write',
    );
    const activityP = waitActivity(
      h,
      p => p.status === 'tool_running' && p.toolCallCounts?.Write === 1,
    );

    feedParsedEvent(h, toolEvent);

    const raw = (await rawEventP).payload as any;
    const input = raw.event.input;
    expect(input.file_path).toBe('src/large.ts');
    expect(input.content).not.toBe(largeContent);
    expect(input.content.length).toBeLessThan(600);
    expect(input.content).toContain('<truncated 4500 chars>');
    expect(input.nested.old_string).toContain('<truncated 4500 chars>');
    expect(input.chunks).toHaveLength(21);
    expect(input.chunks.at(-1)).toEqual({ __truncatedItems: 5 });
    expect((toolEvent.input as any).content).toBe(largeContent);
    await activityP;
  });
});

describe('ConversationManager inbox drain on init', () => {
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
          `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
              from_user_id, content, metadata, seq, created_at)
           VALUES (?, ?, 'user', NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(id, h.sessionId, `queued-${id}`, seq, Date.now());
      h.ctx.db
        .prepare(
          `INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id,
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
    expect(text).toContain('mcp__chat__send_message');
    expect(text).toContain('Complete ALL your work before stopping');

    // Both inbox rows are now delivered_at = some timestamp
    const remaining = h.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversation_inboxes
         WHERE conversation_id = ? AND agent_id = ? AND delivered_at IS NULL`,
      )
      .get(h.sessionId, h.agentId);
    expect(remaining?.c).toBe(0);
  });
});

describe('ConversationManager.reconcileOnBoot', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('flips orphaned starting/active conversation_agents rows back to idle (preserves cli_session_id)', async () => {
    h = await buildManagerHarness();
    h.ctx.db
      .prepare(
        `UPDATE conversation_agents
         SET status = 'active', pid = 99999, cli_session_id = 'cli-stale'
         WHERE conversation_id = ? AND agent_id = ?`,
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

  // Regression: previous reconcile silently set pid=null without
  // checking if the recorded pid was still alive. Combined with the
  // before-quit shutdown bug (a), it meant orphan agents from a prior
  // boot would survive forever, and a fresh start() would spawn a
  // duplicate that fought the orphan for shared state (codex thread).
  it('SIGKILLs an orphan whose pid is still alive', async () => {
    h = await buildManagerHarness();
    // Spawn a sleeper we own and can reap. `node -e "setInterval(...)"`
    // gives us a pid that's definitely alive and won't die on its own
    // before reconcile runs.
    const { spawn } = await import('node:child_process');
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    // Wait until the kernel has actually wired up the pid before we
    // poke it (spawn is synchronous in returning a handle but the
    // child fork happens off the main thread).
    await new Promise<void>(r => orphan.once('spawn', r));
    const orphanPid = orphan.pid!;
    expect(orphanPid).toBeGreaterThan(0);

    h.ctx.db
      .prepare(
        `UPDATE conversation_agents SET status = 'starting', pid = ?
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(orphanPid, h.sessionId, h.agentId);

    const exited = new Promise<void>(r => orphan.once('exit', () => r()));
    h.manager.reconcileOnBoot();
    await exited;
    expect(orphan.signalCode).toBe('SIGKILL');
    expect(dbStatus(h).status).toBe('idle');
    expect(dbStatus(h).pid).toBeNull();
  });

  it('silently flips status when the recorded pid is already dead', async () => {
    h = await buildManagerHarness();
    h.ctx.db
      .prepare(
        `UPDATE conversation_agents SET status = 'starting', pid = 999999
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(h.sessionId, h.agentId);
    // Should NOT throw on ESRCH from the probe.
    const harness = h;
    expect(() => harness.manager.reconcileOnBoot()).not.toThrow();
    expect(dbStatus(h).status).toBe('idle');
    expect(dbStatus(h).pid).toBeNull();
  });
});

describe('ConversationManager init watchdog', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('defers Claude init watchdog on empty-inbox spawn until the first real stdin write', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({
      MOCK_CLAUDE_NO_INIT: '1',
      MOCK_CLAUDE_PROTOCOL_EVENT_DELAY_MS: '20',
    });
    h.manager.initWatchdogMs = 80;
    h.manager.initMaxRetries = 0;

    let timedOut = false;
    h.on(e => {
      if (e.kind === 'agent_init_timeout') timedOut = true;
    });

    const active = h.waitForEvent(
      e =>
        e.kind === 'agent_status' &&
        (e.payload as any).status === 'active' &&
        (e.payload as any).reason === 'awaiting_first_message',
    );
    await h.manager.start(h.sessionId, h.agentId);
    await active;

    await new Promise(r => setTimeout(r, 160));
    const armed = dbStatus(h);
    expect(timedOut).toBe(false);
    expect(armed.status).toBe('active');
    expect(armed.pid).toBeGreaterThan(0);
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(true);

    insertUserMessage(h, 'deferred-first-message-1', 'first real message');
    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    const crashed = waitStatus(h, 'crashed');
    await h.manager.deliverMessage(
      h.sessionId,
      h.agentId,
      'deferred-first-message-1',
    );
    const ev = await timeout;
    expect((ev.payload as any).reason).toBe('silence');
    await crashed;
    expect(dbStatus(h).status).toBe('crashed');
  });

  it('hard-stops a deferred Claude armed process as idle, not crashed', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 80;

    let timedOut = false;
    h.on(e => {
      if (e.kind === 'agent_init_timeout') timedOut = true;
    });

    const active = h.waitForEvent(
      e =>
        e.kind === 'agent_status' &&
        (e.payload as any).status === 'active' &&
        (e.payload as any).reason === 'awaiting_first_message',
    );
    await h.manager.start(h.sessionId, h.agentId);
    await active;
    expect(dbStatus(h).status).toBe('active');

    const idle = waitStatus(h, 'idle');
    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    await idle;
    await new Promise(r => setTimeout(r, 120));

    expect(timedOut).toBe(false);
    expect(dbStatus(h).status).toBe('idle');
    expect(dbStatus(h).pid).toBeNull();
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
  });

  it('marks a deferred Claude armed process crashed on unexpected SIGKILL', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 80;

    const active = h.waitForEvent(
      e =>
        e.kind === 'agent_status' &&
        (e.payload as any).status === 'active' &&
        (e.payload as any).reason === 'awaiting_first_message',
    );
    await h.manager.start(h.sessionId, h.agentId);
    await active;

    const handle = liveHandle(h) as {
      child: { kill(signal: NodeJS.Signals): boolean };
    };
    const crashed = waitStatus(h, 'crashed');
    handle.child.kill('SIGKILL');
    const ev = await crashed;

    expect((ev as any).payload.signal).toBe('SIGKILL');
    expect(dbStatus(h).status).toBe('crashed');
    expect(dbStatus(h).pid).toBeNull();
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
  });

  it('keeps pre-init Claude inbox rows pending when init fails so restart replays them', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-replay-1', 'replay after failed init');
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 1_500;
    h.manager.initMaxRetries = 0;

    await h.manager.start(h.sessionId, h.agentId);
    await waitForStdinLines(
      h,
      lines =>
        lines.filter(l => l.includes('replay after failed init')).length === 1,
    );
    await waitStatus(h, 'crashed');

    const afterFailure = h.ctx.db
      .prepare<[string, string], { delivered_at: number | null }>(
        `SELECT delivered_at FROM conversation_inboxes
         WHERE conversation_id = ? AND message_id = ?`,
      )
      .get(h.sessionId, 'watchdog-replay-1')!;
    expect(afterFailure.delivered_at).toBeNull();

    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: undefined });
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    await waitForStdinLines(
      h,
      lines =>
        lines.filter(l => l.includes('replay after failed init')).length === 2,
    );

    const afterReplay = h.ctx.db
      .prepare<[string, string], { delivered_at: number | null }>(
        `SELECT delivered_at FROM conversation_inboxes
         WHERE conversation_id = ? AND message_id = ?`,
      )
      .get(h.sessionId, 'watchdog-replay-1')!;
    expect(afterReplay.delivered_at).toBeTypeOf('number');
  });

  it('fires when session_init never arrives → publishes init_timeout + crashes the agent', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-kickoff-1', 'kickoff');
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 150;
    h.manager.initMaxRetries = 0;

    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    const crashed = waitStatus(h, 'crashed');

    await h.manager.start(h.sessionId, h.agentId);
    const ev = await timeout;
    expect((ev.payload as any).agent_id).toBe(h.agentId);
    expect((ev.payload as any).reason).toBe('silence');
    expect((ev.payload as any).timeout_ms).toBe(150);

    const exit = await crashed;
    expect((exit as any).payload.reason).toBe('init_timeout');
    expect((exit as any).payload.timeout_reason).toBe('silence');
    expect(dbStatus(h).status).toBe('crashed');
    expect(dbStatus(h).pid).toBeNull();
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
  });

  it('does NOT fire when session_init lands in time', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-healthy-1', 'kickoff');
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
    enqueuePendingUserMessage(h, 'watchdog-hard-stop-1', 'kickoff');
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 200;

    let timedOut = false;
    h.on(e => {
      if (e.kind === 'agent_init_timeout') timedOut = true;
    });

    await h.manager.start(h.sessionId, h.agentId);
    // Stop before the watchdog window expires. stop(hard) now awaits
    // child exit, so subscribe to the idle status BEFORE calling stop —
    // otherwise the exit event fires inside stop() and waitStatus
    // misses it.
    const idle = waitStatus(h, 'idle');
    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    await idle;
    // Wait past the original window — confirm timer didn't survive stop.
    await new Promise(r => setTimeout(r, 300));

    expect(timedOut).toBe(false);
    // Intentional stop → idle, NOT crashed.
    expect(dbStatus(h).status).toBe('idle');
  });

  it('raw stderr bytes refresh liveness silence, but pre-protocol cap still fires', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-stderr-1', 'kickoff');
    h.setMockEnv({
      MOCK_CLAUDE_NO_INIT: '1',
      MOCK_CLAUDE_STDERR_INTERVAL_MS: '10',
    });
    h.manager.initLivenessSilenceMs = 500;
    h.manager.initPreProtocolCapMs = 360;
    h.manager.initPostProtocolMs = 1_000;
    h.manager.initMaxRetries = 0;

    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    const crashed = waitStatus(h, 'crashed');

    await h.manager.start(h.sessionId, h.agentId);
    const ev = await timeout;
    expect((ev.payload as any).reason).toBe('pre_protocol_cap');
    expect((ev.payload as any).timeout_ms).toBe(360);
    const exit = await crashed;
    expect((exit as any).payload.timeout_reason).toBe('pre_protocol_cap');
  });

  it('after a protocol frame, post-protocol session timeout replaces liveness timeout', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-protocol-1', 'kickoff');
    h.setMockEnv({
      MOCK_CLAUDE_NO_INIT: '1',
      MOCK_CLAUDE_PROTOCOL_EVENT_DELAY_MS: '200',
    });
    h.manager.initLivenessSilenceMs = 1_000;
    h.manager.initPreProtocolCapMs = 1_000;
    h.manager.initPostProtocolMs = 120;
    h.manager.initMaxRetries = 0;

    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    const crashed = waitStatus(h, 'crashed');

    await h.manager.start(h.sessionId, h.agentId);
    const ev = await timeout;
    expect((ev.payload as any).reason).toBe('post_protocol');
    expect((ev.payload as any).timeout_ms).toBe(120);
    const exit = await crashed;
    expect((exit as any).payload.timeout_reason).toBe('post_protocol');
  });

  it('retries one transient init timeout without publishing crashed in between', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-retry-1', 'kickoff');
    const spawnCountFile = join(h.silverhandDir, 'spawn-count.txt');
    h.setMockEnv({
      MOCK_CLAUDE_FAIL_FIRST_INITS: '1',
      MOCK_CLAUDE_SPAWN_COUNT_FILE: spawnCountFile,
    });
    h.manager.initLivenessSilenceMs = 1_000;
    h.manager.initPreProtocolCapMs = 1_000;
    h.manager.initPostProtocolMs = 1_000;
    h.manager.initMaxRetries = 1;

    const statuses: string[] = [];
    const timeouts: any[] = [];
    h.on(e => {
      if (e.kind === 'agent_status') statuses.push((e.payload as any).status);
      if (e.kind === 'agent_init_timeout') timeouts.push(e.payload as any);
    });

    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    await h.manager.start(h.sessionId, h.agentId);
    await timeout;
    expect(readFileSync(spawnCountFile, 'utf-8')).toBe('1');
    await waitStatus(h, 'active');

    expect(statuses).not.toContain('crashed');
    expect(statuses.filter(s => s === 'starting').length).toBeGreaterThanOrEqual(2);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].retrying).toBe(true);
    expect(readFileSync(spawnCountFile, 'utf-8')).toBe('2');
    expect(dbStatus(h).status).toBe('active');
  });

  it('suppresses new starts during in-memory init cooldown after repeated failures', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-cooldown-1', 'kickoff');
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initLivenessSilenceMs = 100;
    h.manager.initPreProtocolCapMs = 1_000;
    h.manager.initPostProtocolMs = 1_000;
    h.manager.initMaxRetries = 1;
    h.manager.initFailureCooldownThreshold = 3;
    h.manager.initFailureCooldownMs = 1_000;

    await h.manager.start(h.sessionId, h.agentId);
    await waitStatus(h, 'crashed');

    enqueuePendingUserMessage(h, 'watchdog-cooldown-2', 'kickoff again', 2);
    await h.manager.start(h.sessionId, h.agentId);
    const crashedAfterThreshold = await waitStatus(h, 'crashed');
    expect((crashedAfterThreshold as any).payload.reason).toBe('init_timeout');
    expect((crashedAfterThreshold as any).payload.cooldown_until).toBeTypeOf('number');

    const cooldown = h.waitForEvent(
      e =>
        e.kind === 'agent_status' &&
        (e.payload as any).status === 'crashed' &&
        (e.payload as any).reason === 'init_cooldown',
    );
    await h.manager.start(h.sessionId, h.agentId);
    await cooldown;
    expect(h.manager.isRunning(h.sessionId, h.agentId)).toBe(false);
  });

  // Regression: resuming a thread preloads cli_session_id from DB. Before
  // the fix, the dedup in handleParsedEvent compared cliSessionId to the
  // event's id and short-circuited the first init's side effects (status
  // flip, drainInbox, watchdog clear) because they matched. The row then
  // sat in `starting` forever and the UI rendered "connecting".
  it('flips status to active on first init even when cli_session_id is preloaded (resume)', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-resume-active-1', 'kickoff');
    h.ctx.db
      .prepare(
        `UPDATE conversation_agents SET cli_session_id = ?
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run('cli-resumed-1', h.sessionId, h.agentId);
    // Mock emits an init with the SAME id the resumed CLI would.
    h.setMockEnv({ MOCK_CLAUDE_INIT_SESSION_ID: 'cli-resumed-1' });
    h.manager.initWatchdogMs = 1_000;

    await h.manager.start(h.sessionId, h.agentId);
    await waitStatus(h, 'active');

    expect(dbStatus(h).status).toBe('active');
    expect(dbStatus(h).cli_session_id).toBe('cli-resumed-1');
  });

  // Regression: the watchdog used `cliSessionId !== null` as "init has
  // landed" — true by accident on every resume since cliSessionId is
  // preloaded. A wedged resumed CLI then escaped the watchdog and the
  // process was left running with status stuck at `starting`.
  it('still fires when a resumed CLI with kickoff inbox never re-emits init', async () => {
    h = await buildManagerHarness();
    enqueuePendingUserMessage(h, 'watchdog-resume-timeout-1', 'kickoff');
    h.ctx.db
      .prepare(
        `UPDATE conversation_agents SET cli_session_id = ?
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run('cli-resumed-2', h.sessionId, h.agentId);
    h.setMockEnv({ MOCK_CLAUDE_NO_INIT: '1' });
    h.manager.initWatchdogMs = 150;

    const timeout = h.waitForEvent(e => e.kind === 'agent_init_timeout');
    const crashed = waitStatus(h, 'crashed');

    await h.manager.start(h.sessionId, h.agentId);
    await timeout;
    await crashed;
    expect(dbStatus(h).status).toBe('crashed');
  });
});

describe('ConversationManager activity log', () => {
  let h: ManagerHarness | null = null;
  let logDir: string;

  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('writes JSONL to logDir and flushes terminal entry after closeActivityLog', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'silverhand-actlog-test-'));
    h = await buildManagerHarness({ logDir });

    // Seed a pending inbox item so hasKickoffInbox=true → startRun fires on spawn
    // and a run state exists for resolveRun to publish the terminal event.
    const msgId = 'actlog-test-msg-1';
    h.ctx.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, from_kind, from_agent_id,
            from_user_id, content, metadata, seq, created_at)
         VALUES (?, ?, 'user', NULL, NULL, ?, NULL, 1, ?)`,
      )
      .run(msgId, h.sessionId, 'hello', Date.now());
    h.ctx.db
      .prepare(
        `INSERT INTO conversation_inboxes (conversation_id, agent_id, message_id,
            delivered_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(h.sessionId, h.agentId, msgId, Date.now());

    // agent exits cleanly → resolveRun emits idle terminal event → JSONL line written
    h.setMockEnv({ MOCK_CLAUDE_EXIT_AFTER_INIT_MS: '50' });
    await h.manager.start(h.sessionId, h.agentId);
    await waitInit(h);
    await waitStatus(h, 'idle');
    // small grace so the terminal activity event is written before we close the stream
    await new Promise(r => setTimeout(r, 50));

    await h.manager.closeActivityLog();

    // exactly one agent-activity-*.log file should be in logDir
    const files = readdirSync(logDir).filter(f => f.startsWith('agent-activity-'));
    expect(files.length).toBe(1);

    // read all JSONL lines
    const lines = readFileSync(join(logDir, files[0]!), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l));

    expect(lines.length).toBeGreaterThan(0);

    // at least one line should have a terminal status (idle) with terminalReason
    const terminal = lines.find(
      (l: any) => l.status === 'idle' && l.terminalReason !== undefined,
    );
    expect(terminal).toBeDefined();
    expect(terminal.conversationId).toBe(h.sessionId);
    expect(terminal.agentId).toBe(h.agentId);
    expect(typeof terminal.runId).toBe('string');
    expect(typeof terminal.lastActivityAt).toBe('number');
  });
});
