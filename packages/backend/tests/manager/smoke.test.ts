import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManagerHarness,
  readStdinLog,
  type ManagerHarness,
} from '../utils/manager.js';

describe('ConversationManager smoke (mock-claude)', () => {
  let h: ManagerHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('start spawns mock-claude, observes session_init, marks active', async () => {
    h = await buildManagerHarness();
    h.setMockEnv({ MOCK_CLAUDE_INIT_SESSION_ID: 'cli-fixed-1' });

    const init = h.waitForEvent(
      e =>
        e.kind === 'agent_event' &&
        (e.payload as any)?.event?.kind === 'session_init',
    );
    await h.manager.start(h.sessionId, h.agentId);
    const ev = await init;
    expect((ev.payload as any).event.sessionId).toBe('cli-fixed-1');

    // DB row reflects active + cli_session_id
    const row = h.ctx.db
      .prepare<[string, string], { status: string; cli_session_id: string | null }>(
        `SELECT status, cli_session_id FROM conversation_agents
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(h.sessionId, h.agentId);
    expect(row?.status).toBe('active');
    expect(row?.cli_session_id).toBe('cli-fixed-1');
  });

  it('logs stdin writes — control_request lands when stop(hard) runs', async () => {
    h = await buildManagerHarness();

    const ready = h.waitForEvent(
      e =>
        e.kind === 'agent_event' &&
        (e.payload as any)?.event?.kind === 'session_init',
    );
    await h.manager.start(h.sessionId, h.agentId);
    await ready;

    const exited = h.waitForEvent(
      e => e.kind === 'agent_status' && (e.payload as any)?.status === 'idle',
    );
    await h.manager.stop(h.sessionId, h.agentId, 'hard');
    await exited;

    const lines = await readStdinLog(h.stdinLog);
    expect(lines.some(l => l.includes('"control_request"'))).toBe(true);
  });
});
