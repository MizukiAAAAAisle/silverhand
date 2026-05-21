/**
 * Unit tests for `RunStateCache` — projection of daemon runtime state
 * into backend memory. Cindy `KMJFmcS4hf_tJ5hj` boundary 3: the cache
 * is passive (no event emission, no DB writes, no SSE). Tests here
 * exercise only state-store semantics; SSE / DB / inbox interactions
 * live in `RuntimeEventHandler` tests.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeStateDto } from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';

const DAEMON_A = 'pid:111@1000';
const DAEMON_B = 'pid:222@2000';
const CONV = 'conv-1';
const AGENT_X = 'agent-x';
const AGENT_Y = 'agent-y';

function dto(
  conversation: string,
  agent: string,
  patch: Partial<RuntimeStateDto> = {},
): RuntimeStateDto {
  return {
    conversation_id: conversation,
    agent_id: agent,
    pid: 9001,
    phase: 'ready',
    run_state: null,
    started_at: 1700000000000,
    ...patch,
  };
}

function runState(patch: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: 'run-1',
    agentId: AGENT_X,
    conversationId: CONV,
    status: 'thinking',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    lastActivityAt: 1700000000000,
    ...patch,
  };
}

describe('RunStateCache: applyRuntimeStatus (hydrate)', () => {
  it('upserts entries from a daemon snapshot and stamps daemonInstanceKey', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(
      DAEMON_A,
      [dto(CONV, AGENT_X), dto(CONV, AGENT_Y, { phase: 'startup_pending' })],
      1700000001000,
    );
    expect(cache.daemonInstanceKey).toBe(DAEMON_A);
    expect(cache.list().length).toBe(2);

    const x = cache.get(CONV, AGENT_X)!;
    expect(x.phase).toBe('ready');
    expect(x.daemonInstanceKey).toBe(DAEMON_A);
    expect(x.updatedAt).toBe(1700000001000);

    const y = cache.get(CONV, AGENT_Y)!;
    expect(y.phase).toBe('startup_pending');
  });

  it('removes entries the snapshot omits (daemon no longer tracks them)', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X), dto(CONV, AGENT_Y)]);
    expect(cache.list().length).toBe(2);
    // Second snapshot drops AGENT_Y.
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    expect(cache.get(CONV, AGENT_Y)).toBeUndefined();
    expect(cache.list().length).toBe(1);
  });

  it('wipes all entries when daemon instance key changes (daemon swap)', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X), dto(CONV, AGENT_Y)]);
    // New daemon, only knows AGENT_X. Both AGENT_Y from old daemon
    // AND the AGENT_X from old daemon must vanish before the new
    // AGENT_X is written — i.e. wipe first, apply second.
    cache.applyRuntimeStatus(DAEMON_B, [dto(CONV, AGENT_X, { pid: 4321 })]);
    expect(cache.daemonInstanceKey).toBe(DAEMON_B);
    expect(cache.get(CONV, AGENT_Y)).toBeUndefined();
    const x = cache.get(CONV, AGENT_X)!;
    expect(x.daemonInstanceKey).toBe(DAEMON_B);
    expect(x.pid).toBe(4321);
  });
});

describe('RunStateCache: applyRuntimeState (state event)', () => {
  it('stores the AgentRunState verbatim (full replace, not merge)', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    // Daemon ships a state that explicitly omits compactionStale.
    cache.applyRuntimeState(
      DAEMON_A,
      CONV,
      AGENT_X,
      runState({ status: 'tool_running', detail: 'bash' }),
      1700000002000,
    );
    const entry = cache.get(CONV, AGENT_X)!;
    expect(entry.runState?.status).toBe('tool_running');
    expect(entry.runState?.detail).toBe('bash');
    expect(entry.runState?.compactionStale).toBeUndefined();
    expect(entry.updatedAt).toBe(1700000002000);
    // Preserves phase/pid/startedAt from prior hydrate.
    expect(entry.phase).toBe('ready');
    expect(entry.pid).toBe(9001);
  });

  it('creates a skeleton entry when no prior hydrate exists, defaulting phase=ready', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeState(DAEMON_A, CONV, AGENT_X, runState());
    const entry = cache.get(CONV, AGENT_X)!;
    expect(entry.phase).toBe('ready');
    expect(entry.pid).toBeNull();
    expect(entry.runState?.runId).toBe('run-1');
  });

  it('drops events from a stale daemon key once a different one is latched', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    // Event from a DIFFERENT daemon must be ignored.
    cache.applyRuntimeState(
      DAEMON_B,
      CONV,
      AGENT_X,
      runState({ status: 'failed', terminalReason: 'crashed' }),
    );
    const entry = cache.get(CONV, AGENT_X)!;
    expect(entry.runState).toBeNull();
    expect(entry.daemonInstanceKey).toBe(DAEMON_A);
  });
});

describe('RunStateCache: applyPhase + applyRuntimeExit', () => {
  it('applyPhase merges only the phase field on existing entries', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    cache.applyRuntimeState(DAEMON_A, CONV, AGENT_X, runState());
    cache.applyPhase(DAEMON_A, CONV, AGENT_X, 'draining', 1700000003000);
    const entry = cache.get(CONV, AGENT_X)!;
    expect(entry.phase).toBe('draining');
    expect(entry.runState?.runId).toBe('run-1');
    expect(entry.pid).toBe(9001);
  });

  it('applyPhase creates a skeleton when no prior entry exists', () => {
    const cache = new RunStateCache();
    cache.applyPhase(DAEMON_A, CONV, AGENT_X, 'spawning');
    const entry = cache.get(CONV, AGENT_X)!;
    expect(entry.phase).toBe('spawning');
    expect(entry.runState).toBeNull();
    expect(entry.pid).toBeNull();
  });

  it('applyRuntimeExit forces phase=exited and preserves runState', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    cache.applyRuntimeState(
      DAEMON_A,
      CONV,
      AGENT_X,
      runState({ status: 'failed', terminalReason: 'crashed' }),
    );
    const next = cache.applyRuntimeExit(DAEMON_A, CONV, AGENT_X)!;
    expect(next.phase).toBe('exited');
    expect(next.runState?.terminalReason).toBe('crashed');
  });

  it('applyRuntimeExit creates a skeleton entry when none existed', () => {
    const cache = new RunStateCache();
    const next = cache.applyRuntimeExit(DAEMON_A, CONV, AGENT_X)!;
    expect(next.phase).toBe('exited');
    expect(next.runState).toBeNull();
  });

  it('drops phase/exit events from a mismatched daemon key', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    cache.applyPhase(DAEMON_B, CONV, AGENT_X, 'draining');
    expect(cache.get(CONV, AGENT_X)!.phase).toBe('ready');
    expect(cache.applyRuntimeExit(DAEMON_B, CONV, AGENT_X)).toBeNull();
  });
});

describe('RunStateCache: clear / clearAll', () => {
  it('clear removes a single entry, leaves daemon key intact', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X), dto(CONV, AGENT_Y)]);
    cache.clear(CONV, AGENT_X);
    expect(cache.get(CONV, AGENT_X)).toBeUndefined();
    expect(cache.get(CONV, AGENT_Y)).toBeDefined();
    expect(cache.daemonInstanceKey).toBe(DAEMON_A);
  });

  it('clearAll wipes entries AND resets daemon key (forces next snapshot to latch)', () => {
    const cache = new RunStateCache();
    cache.applyRuntimeStatus(DAEMON_A, [dto(CONV, AGENT_X)]);
    cache.clearAll();
    expect(cache.list()).toEqual([]);
    expect(cache.daemonInstanceKey).toBeNull();
    // Next apply latches a fresh daemon key without needing a swap.
    cache.applyRuntimeStatus(DAEMON_B, [dto(CONV, AGENT_X)]);
    expect(cache.daemonInstanceKey).toBe(DAEMON_B);
  });
});
