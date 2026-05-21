/**
 * Behavior tests for `DaemonAgentRuntimeHost`.
 *
 * # Sub-commit 2b-ii scope split (status per method)
 *
 * Implemented (covered by behavior tests below):
 *   - `getAgentRunStates` — cache projection
 *   - `resolveRun` — cache.resolveRun + SSE `agent_activity`
 *   - `resolveConversationRuns` — cache.resolveConversationRuns + SSE
 *   - `stop` with `mode='hard'` — `bridge.runtimeStop({mode:'hard'})`
 *   - `stop` with `mode='soft'` — driver-encode + ship via bridge
 *   - `stopAll` — `bridge.runtimeStopAll`
 *   - `closeActivityLog` — `bridge.runtimeCloseActivityLog`
 *   - `reconcileOnBoot` — daemon snapshot-aware diff
 *   - `clearSession` — bridge first, DB tx + audit + SSE
 *
 * Still throws (covered by scaffolding-error tests below):
 *   - `start`, `deliverMessage`
 *
 * Cindy `0G5uJBydO_4qt_2r` pin: the throw is the contract, NOT a silent
 * no-op. Tests assert each throw names the env var, the offending
 * method, the rollback recipe, and surfaces "ConversationManager" as
 * the canonical fallback. Live methods must not piggy-back the throw
 * path — their tests assert real delegation.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  HostClient,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogResult,
  RuntimeStatusResult,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
} from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import type { Database } from 'better-sqlite3';
import { DaemonAgentRuntimeHost } from '../../src/runtime/daemon-agent-runtime-host.js';
import { RuntimeBridge } from '../../src/runtime/bridge.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { RuntimeEventHandler } from '../../src/runtime/event-handler.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import type { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationRepo as RealConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import type { BackendLogger } from '../../src/context.js';
import { openTestDb, makeTempSilverhandDir } from '../utils/db.js';

interface ClientOverrides {
  runtimeStop?: (
    params: RuntimeStopParams,
  ) => Promise<RuntimeStopResult> | RuntimeStopResult;
  runtimeStopAll?: () =>
    | Promise<RuntimeStopAllResult>
    | RuntimeStopAllResult;
  runtimeCloseActivityLog?: () =>
    | Promise<RuntimeCloseActivityLogResult>
    | RuntimeCloseActivityLogResult;
  runtimeStatus?: () => Promise<RuntimeStatusResult> | RuntimeStatusResult;
  runtimeClearSession?: (params: {
    conversation_id: string;
    agent_id: string;
  }) =>
    | Promise<RuntimeClearSessionResult>
    | RuntimeClearSessionResult;
  subscribe?: HostClient['subscribe'];
}

const noopLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Minimal stub used by tests that don't exercise reconcileOnBoot /
// clearSession / soft-stop — the type checker insists on the
// ConversationRepo / AgentRepo / MessageRepo / Database shapes, but
// the methods involved are never invoked. Cast through `unknown` keeps
// each stub surface narrow.
const noopConversationRepo = {
  listLiveStatusAgents: () => [],
  updateAgentRuntime: () => null,
  get: () => null,
  getAgent: () => null,
} as unknown as ConversationRepo;

const noopAgentRepo = {
  get: () => null,
} as unknown as AgentRepo;

const noopMessageRepo = {
  insertForConversation: () => {
    throw new Error('noopMessageRepo.insertForConversation invoked');
  },
} as unknown as MessageRepo;

// `db.transaction(fn)` returns a function that, when called, invokes
// `fn` and returns its result. The real better-sqlite3 wraps in a
// SQLite transaction; for tests that never reach the tx body the stub
// is just an identity wrapper.
const noopDb = {
  transaction: <T>(fn: () => T) => () => fn(),
} as unknown as Database;

function makeFakeClient(overrides: ClientOverrides = {}): HostClient {
  // Methods absent from `overrides` are unreachable in the tests below
  // (the live methods explicitly delegate to bridge.runtimeStop /
  // .runtimeStopAll / .runtimeCloseActivityLog only). We supply rejecting
  // stubs so any accidental delegation surfaces loudly as an unexpected
  // resolution.
  const reject = () =>
    Promise.reject(new Error('unmocked host client method'));
  return {
    ping: reject,
    subscribe: overrides.subscribe ?? (() => () => {}),
    onReconnect: () => () => {},
    runtimeStart: reject,
    runtimeStop: overrides.runtimeStop
      ? async (params: RuntimeStopParams) => overrides.runtimeStop!(params)
      : reject,
    runtimeWake: reject,
    runtimeStatus: overrides.runtimeStatus
      ? async () => overrides.runtimeStatus!()
      : reject,
    runtimeClearSession: overrides.runtimeClearSession
      ? async (params: { conversation_id: string; agent_id: string }) =>
          overrides.runtimeClearSession!(params)
      : reject,
    runtimeStopAll: overrides.runtimeStopAll
      ? async () => overrides.runtimeStopAll!()
      : reject,
    runtimeCloseActivityLog: overrides.runtimeCloseActivityLog
      ? async () => overrides.runtimeCloseActivityLog!()
      : reject,
    runtimeOutputPause: reject,
    runtimeOutputResume: reject,
    close: () => Promise.resolve(),
    connect: () => Promise.resolve(),
  } as unknown as HostClient;
}

interface HostFixture {
  host: DaemonAgentRuntimeHost;
  cache: RunStateCache;
  bridge: RuntimeBridge;
  events: { publishes: Array<{ conversationId: string; kind: string; payload: unknown }> };
  publisher: EventPublisher;
}

function makeHost(
  clientOverrides: ClientOverrides = {},
  conversations: ConversationRepo = noopConversationRepo,
  extraDeps: {
    agents?: AgentRepo;
    messages?: MessageRepo;
    db?: Database;
  } = {},
): HostFixture {
  const client = makeFakeClient(clientOverrides);
  const bridge = new RuntimeBridge(client, { get: () => null });
  const cache = new RunStateCache();
  const events: HostFixture['events'] = { publishes: [] };
  const publisher: EventPublisher = {
    publish: (conversationId, payload) => {
      events.publishes.push({
        conversationId,
        kind: payload.kind,
        payload: payload.payload,
      });
    },
  };
  const eventHandler = new RuntimeEventHandler({
    client,
    bridge,
    cache,
    events: publisher,
    inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
  });
  const host = new DaemonAgentRuntimeHost({
    client,
    bridge,
    cache,
    eventHandler,
    events: publisher,
    conversations,
    agents: extraDeps.agents ?? noopAgentRepo,
    messages: extraDeps.messages ?? noopMessageRepo,
    db: extraDeps.db ?? noopDb,
    logger: noopLogger,
  });
  return { host, cache, bridge, events, publisher };
}

const DAEMON_KEY = 'pid:111@1000';
const CONV = 'conv-1';
const AGENT_X = 'agent-x';
const AGENT_Y = 'agent-y';

function fakeRunState(patch: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: 'r-1',
    agentId: AGENT_X,
    conversationId: CONV,
    status: 'thinking',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    lastActivityAt: 1700000000000,
    ...patch,
  };
}

const ROLLBACK_RECIPE = 'SILVERHAND_RUNTIME_HOST=legacy';

function assertScaffoldingError(err: unknown, method: string): void {
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message).toContain('SILVERHAND_RUNTIME_HOST=daemon');
  expect(message).toContain(`${method}(`);
  expect(message).toContain('not yet implemented');
  expect(message).toContain(ROLLBACK_RECIPE);
  // The canonical fallback should be named so the operator knows
  // legacy mode is the supported path, not just a workaround.
  expect(message).toMatch(/ConversationManager/);
}

describe('DaemonAgentRuntimeHost — read methods', () => {
  it('getAgentRunStates returns every (conv, *) entry with an active runState', () => {
    const { host, cache } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-x', agentId: AGENT_X }),
        started_at: 1700000000000,
      },
      {
        conversation_id: CONV,
        agent_id: AGENT_Y,
        pid: 2,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-y', agentId: AGENT_Y }),
        started_at: 1700000000000,
      },
      {
        conversation_id: 'conv-other',
        agent_id: AGENT_X,
        pid: 3,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-other', conversationId: 'conv-other' }),
        started_at: 1700000000000,
      },
    ]);
    const states = host.getAgentRunStates(CONV);
    const ids = states.map(s => s.runId).sort();
    expect(ids).toEqual(['r-x', 'r-y']);
  });

  it('getAgentRunStates omits entries whose runState is null', () => {
    const { host, cache } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'startup_pending',
        run_state: null, // not yet emitted runtime_state
        started_at: 1700000000000,
      },
    ]);
    expect(host.getAgentRunStates(CONV)).toEqual([]);
  });

  it('getAgentRunStates returns [] when no entries match the conversation', () => {
    const { host } = makeHost();
    expect(host.getAgentRunStates(CONV)).toEqual([]);
  });
});

describe('DaemonAgentRuntimeHost — resolveRun', () => {
  it('publishes terminal agent_activity and clears cache runState', () => {
    const { host, cache, events } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-1' }),
        started_at: 1700000000000,
      },
    ]);
    host.resolveRun(CONV, AGENT_X, 'replied');
    expect(events.publishes.length).toBe(1);
    expect(events.publishes[0]!.conversationId).toBe(CONV);
    expect(events.publishes[0]!.kind).toBe('agent_activity');
    const terminal = events.publishes[0]!.payload as AgentRunState;
    expect(terminal.status).toBe('idle');
    expect(terminal.terminalReason).toBe('replied');
    expect(terminal.runId).toBe('r-1');
    // cache runState cleared
    expect(cache.get(CONV, AGENT_X)?.runState).toBeNull();
  });

  it('publishes failed status for crash-class terminal reasons', () => {
    const { host, cache, events } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState(),
        started_at: 1700000000000,
      },
    ]);
    host.resolveRun(CONV, AGENT_X, 'crashed');
    const terminal = events.publishes[0]!.payload as AgentRunState;
    expect(terminal.status).toBe('failed');
    expect(terminal.terminalReason).toBe('crashed');
  });

  it('is a no-op (no publish) when entry has no active run', () => {
    const { host, cache, events } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: null,
        started_at: 1700000000000,
      },
    ]);
    host.resolveRun(CONV, AGENT_X, 'replied');
    expect(events.publishes).toEqual([]);
  });

  it('is a no-op when expectedRunId disagrees with the active run', () => {
    const { host, cache, events } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-current' }),
        started_at: 1700000000000,
      },
    ]);
    host.resolveRun(CONV, AGENT_X, 'replied', 'r-stale');
    expect(events.publishes).toEqual([]);
    // cache untouched
    expect(cache.get(CONV, AGENT_X)?.runState?.runId).toBe('r-current');
  });
});

describe('DaemonAgentRuntimeHost — resolveConversationRuns', () => {
  it('publishes one agent_activity per active runState in the conversation', () => {
    const { host, cache, events } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-x', agentId: AGENT_X }),
        started_at: 1700000000000,
      },
      {
        conversation_id: CONV,
        agent_id: AGENT_Y,
        pid: 2,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-y', agentId: AGENT_Y }),
        started_at: 1700000000000,
      },
      {
        conversation_id: 'conv-other',
        agent_id: AGENT_X,
        pid: 3,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-other', conversationId: 'conv-other' }),
        started_at: 1700000000000,
      },
    ]);
    host.resolveConversationRuns(CONV);
    expect(events.publishes.length).toBe(2);
    const reasons = events.publishes.map(
      e => (e.payload as AgentRunState).terminalReason,
    );
    expect(reasons).toEqual(['conversation_closed', 'conversation_closed']);
    // Other-conv entry untouched.
    expect(cache.get('conv-other', AGENT_X)?.runState?.runId).toBe('r-other');
  });

  it('honors the optional reason override', () => {
    const { host, cache, events } = makeHost();
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState({ runId: 'r-x' }),
        started_at: 1700000000000,
      },
    ]);
    host.resolveConversationRuns(CONV, 'crashed');
    expect(events.publishes.length).toBe(1);
    const terminal = events.publishes[0]!.payload as AgentRunState;
    expect(terminal.terminalReason).toBe('crashed');
    expect(terminal.status).toBe('failed');
  });

  it('publishes nothing when no entries have an active run', () => {
    const { host, events } = makeHost();
    host.resolveConversationRuns(CONV);
    expect(events.publishes).toEqual([]);
  });
});

describe('DaemonAgentRuntimeHost — stop (hard)', () => {
  it('delegates to bridge.runtimeStop with mode=hard', async () => {
    const runtimeStop = vi.fn(
      async (_params: RuntimeStopParams): Promise<RuntimeStopResult> => ({
        mode: 'hard',
        stopped: true,
        exit_code: 0,
      }),
    );
    const { host } = makeHost({ runtimeStop });
    await host.stop(CONV, AGENT_X, 'hard');
    expect(runtimeStop).toHaveBeenCalledTimes(1);
    expect(runtimeStop).toHaveBeenCalledWith({
      conversation_id: CONV,
      agent_id: AGENT_X,
      mode: 'hard',
    });
  });

  it('defaults mode to hard when omitted', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => ({
        mode: 'hard',
        stopped: false,
        exit_code: null,
      }),
    );
    const { host } = makeHost({ runtimeStop });
    await host.stop(CONV, AGENT_X);
    expect(runtimeStop).toHaveBeenCalledWith({
      conversation_id: CONV,
      agent_id: AGENT_X,
      mode: 'hard',
    });
  });

  it('propagates bridge errors (does NOT swallow)', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => {
        throw new Error('daemon disconnected');
      },
    );
    const { host } = makeHost({ runtimeStop });
    await expect(host.stop(CONV, AGENT_X, 'hard')).rejects.toThrow(
      'daemon disconnected',
    );
  });

  it('does NOT touch the cache directly (event-handler owns the exit projection)', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => ({
        mode: 'hard',
        stopped: true,
        exit_code: 0,
      }),
    );
    const { host, cache } = makeHost({ runtimeStop });
    cache.applyRuntimeStatus(DAEMON_KEY, [
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        pid: 1,
        phase: 'ready',
        run_state: fakeRunState(),
        started_at: 1700000000000,
      },
    ]);
    await host.stop(CONV, AGENT_X, 'hard');
    // Cache entry still present + phase unchanged — the trailing
    // runtime_exit event (delivered via RuntimeEventHandler) is what
    // moves it to 'exited', not this stop call.
    expect(cache.get(CONV, AGENT_X)?.phase).toBe('ready');
  });
});

// ── stop (soft) ─────────────────────────────────────────────────────
//
// Slice 3: soft stop composes the directive stream-json line via the
// agent's driver, ships it inside `runtime_stop({mode:'soft',
// soft_directive: line})`. The cache is NOT mutated (event handler
// owns the exit projection — same as hard stop). Failure modes:
//
//   * driver returns `null` from encodeStdinMessage (e.g. cursor /
//     codex oneShot drivers) → throw synchronously, do NOT call
//     bridge.
//   * agent row missing → throw synchronously, do NOT call bridge.
//   * `directive_delivered=false` from daemon → log warn, do NOT throw
//     (CM's soft path is best-effort).

function makeAgentRepoStub(
  agents: Array<{ id: string; name: string; runtime: 'claude' | 'cursor' }>,
): AgentRepo {
  const byId = new Map(agents.map(a => [a.id, a]));
  return {
    get: (id: string) => byId.get(id) ?? null,
  } as unknown as AgentRepo;
}

function makeConvRepoStub(
  rows: Array<{
    conversation_id: string;
    agent_id: string;
    cli_session_id: string | null;
  }>,
): ConversationRepo {
  const byKey = new Map(rows.map(r => [`${r.conversation_id}|${r.agent_id}`, r]));
  return {
    listLiveStatusAgents: () => [],
    updateAgentRuntime: () => null,
    get: () => null,
    getAgent: (cid: string, aid: string) => byKey.get(`${cid}|${aid}`) ?? null,
  } as unknown as ConversationRepo;
}

describe('DaemonAgentRuntimeHost — stop (soft)', () => {
  it('encodes directive via driver + ships via bridge with soft_directive', async () => {
    const runtimeStop = vi.fn(
      async (_params: RuntimeStopParams): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    const agents = makeAgentRepoStub([
      { id: AGENT_X, name: 'alice', runtime: 'claude' },
    ]);
    const conversations = makeConvRepoStub([
      {
        conversation_id: CONV,
        agent_id: AGENT_X,
        cli_session_id: 'sess-abc',
      },
    ]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    await host.stop(CONV, AGENT_X, 'soft', 'pause and wait');

    expect(runtimeStop).toHaveBeenCalledTimes(1);
    const call = runtimeStop.mock.calls[0]![0];
    expect(call.conversation_id).toBe(CONV);
    expect(call.agent_id).toBe(AGENT_X);
    expect(call.mode).toBe('soft');
    // The directive line must be a JSON-encoded claude stream-json
    // user message carrying the directive verbatim + the current
    // cli_session_id from the DB row.
    const decoded = JSON.parse((call as { soft_directive: string }).soft_directive);
    expect(decoded.type).toBe('user');
    expect(decoded.message.content[0].text).toBe('pause and wait');
    expect(decoded.session_id).toBe('sess-abc');
  });

  it('uses default directive when softDirective omitted', async () => {
    const runtimeStop = vi.fn(
      async (_params: RuntimeStopParams): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    const agents = makeAgentRepoStub([
      { id: AGENT_X, name: 'alice', runtime: 'claude' },
    ]);
    const conversations = makeConvRepoStub([
      { conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null },
    ]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    await host.stop(CONV, AGENT_X, 'soft');
    const decoded = JSON.parse(
      (runtimeStop.mock.calls[0]![0] as { soft_directive: string }).soft_directive,
    );
    // Default phrasing must mention "course correction" so CM-parity
    // tests don't drift.
    expect(decoded.message.content[0].text).toMatch(/course correction/);
    // No cli_session_id present in the row → no session_id field
    // on the encoded line.
    expect(decoded.session_id).toBeUndefined();
  });

  it('throws without calling bridge when driver does not accept stdin (oneShot)', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    const agents = makeAgentRepoStub([
      { id: AGENT_X, name: 'cursor-bot', runtime: 'cursor' },
    ]);
    const conversations = makeConvRepoStub([
      { conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null },
    ]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    await expect(host.stop(CONV, AGENT_X, 'soft')).rejects.toThrow(
      /does not accept stdin soft directives/,
    );
    expect(runtimeStop).not.toHaveBeenCalled();
  });

  it('throws without calling bridge when agent row missing', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    // Empty agents stub → host.stop will throw "agent not found".
    const { host } = makeHost(
      { runtimeStop },
      makeConvRepoStub([]),
      { agents: makeAgentRepoStub([]) },
    );
    await expect(host.stop(CONV, AGENT_X, 'soft')).rejects.toThrow(/not found/);
    expect(runtimeStop).not.toHaveBeenCalled();
  });

  it('logs warn (does NOT throw) when daemon reports directive_delivered=false', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: false,
        reason: 'not_running',
      }),
    );
    const warned: Array<{ obj: unknown; msg: string }> = [];
    const agents = makeAgentRepoStub([
      { id: AGENT_X, name: 'alice', runtime: 'claude' },
    ]);
    const conversations = makeConvRepoStub([
      { conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null },
    ]);
    const client = makeFakeClient({ runtimeStop });
    const bridge = new RuntimeBridge(client, { get: () => null });
    const cache = new RunStateCache();
    const events: HostFixture['events'] = { publishes: [] };
    const publisher: EventPublisher = {
      publish: (cid, payload) =>
        events.publishes.push({
          conversationId: cid,
          kind: payload.kind,
          payload: payload.payload,
        }),
    };
    const eventHandler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: publisher,
      inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
    });
    const customLogger: BackendLogger = {
      ...noopLogger,
      warn: (obj: unknown, msg: string) => warned.push({ obj, msg }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const host = new DaemonAgentRuntimeHost({
      client,
      bridge,
      cache,
      eventHandler,
      events: publisher,
      conversations,
      agents,
      messages: noopMessageRepo,
      db: noopDb,
      logger: customLogger,
    });
    await host.stop(CONV, AGENT_X, 'soft', 'pause now');
    expect(warned.length).toBe(1);
    expect(warned[0]!.msg).toMatch(/soft stop directive not delivered/);
    expect(warned[0]!.obj).toMatchObject({
      mode: 'daemon',
      conv_id: CONV,
      agent_id: AGENT_X,
      reason: 'not_running',
    });
  });

  it('propagates bridge errors (does NOT swallow)', async () => {
    const runtimeStop = vi.fn(async (): Promise<RuntimeStopResult> => {
      throw new Error('daemon disconnected');
    });
    const agents = makeAgentRepoStub([
      { id: AGENT_X, name: 'alice', runtime: 'claude' },
    ]);
    const conversations = makeConvRepoStub([
      { conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null },
    ]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    await expect(host.stop(CONV, AGENT_X, 'soft')).rejects.toThrow(
      'daemon disconnected',
    );
  });
});

describe('DaemonAgentRuntimeHost — stopAll / closeActivityLog', () => {
  it('stopAll delegates to bridge.runtimeStopAll', async () => {
    const runtimeStopAll = vi.fn(
      async (): Promise<RuntimeStopAllResult> => ({ stopped_count: 3 }),
    );
    const { host } = makeHost({ runtimeStopAll });
    await host.stopAll();
    expect(runtimeStopAll).toHaveBeenCalledTimes(1);
  });

  it('stopAll propagates bridge errors', async () => {
    const runtimeStopAll = vi.fn(async (): Promise<RuntimeStopAllResult> => {
      throw new Error('daemon timeout');
    });
    const { host } = makeHost({ runtimeStopAll });
    await expect(host.stopAll()).rejects.toThrow('daemon timeout');
  });

  it('closeActivityLog delegates to bridge.runtimeCloseActivityLog', async () => {
    const runtimeCloseActivityLog = vi.fn(
      async (): Promise<RuntimeCloseActivityLogResult> => ({ flushed: true }),
    );
    const { host } = makeHost({ runtimeCloseActivityLog });
    await host.closeActivityLog();
    expect(runtimeCloseActivityLog).toHaveBeenCalledTimes(1);
  });

  it('closeActivityLog propagates bridge errors', async () => {
    const runtimeCloseActivityLog = vi.fn(
      async (): Promise<RuntimeCloseActivityLogResult> => {
        throw new Error('daemon disconnected');
      },
    );
    const { host } = makeHost({ runtimeCloseActivityLog });
    await expect(host.closeActivityLog()).rejects.toThrow('daemon disconnected');
  });
});

describe('DaemonAgentRuntimeHost — not-yet-implemented (2b-ii scaffold)', () => {
  it('start() throws with rollback recipe', async () => {
    const { host } = makeHost();
    let err: unknown;
    await host.start(CONV, AGENT_X).catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'start');
  });

  it('deliverMessage() throws — does NOT silently mark delivered', async () => {
    // Cindy `0G5uJBydO_4qt_2r`: "不能假装 delivered、也不能改变 markDelivered
    // 时点." The throw is the contract: no inbox row state is mutated.
    const { host } = makeHost();
    let err: unknown;
    await host.deliverMessage(CONV, AGENT_X, 'msg-1').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'deliverMessage');
  });
});

describe('DaemonAgentRuntimeHost — constructor', () => {
  it('accepts the deps shape without throwing', () => {
    const client = makeFakeClient();
    const bridge = new RuntimeBridge(client, { get: () => null });
    const cache = new RunStateCache();
    const events: EventPublisher = { publish: () => {} };
    const eventHandler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events,
      inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
    });
    expect(
      () =>
        new DaemonAgentRuntimeHost({
          client,
          bridge,
          cache,
          eventHandler,
          events,
          conversations: noopConversationRepo,
          agents: noopAgentRepo,
          messages: noopMessageRepo,
          db: noopDb,
          logger: noopLogger,
        }),
    ).not.toThrow();
  });
});

// ── reconcileOnBoot ─────────────────────────────────────────────────
//
// Boot recovery (Cindy `5Yrv3roymWkCPxo1` watchlist #3 — snapshot-aware).
// Three cases pin the contract:
//
//   1. Snapshot returned by daemon = ground truth. DB rows whose
//      (conv, agent) appear in the snapshot are left alone (daemon is
//      supervising). Rows absent from the snapshot are cleared to
//      `idle` (`pid=null`, `cli_session_id` preserved). A matching
//      `agent_status` SSE fires per cleared row so renderers drop
//      stale spinners immediately.
//   2. Empty DB → no-op (nothing to diff).
//   3. Hydrate failure → SKIP the diff. Daemon might be temporarily
//      unreachable; clearing rows here would spuriously flip live
//      agents to idle. Logged as a warning.

interface ReconcileFixture {
  silverhandDir: string;
  workspacesRoot: string;
  cleanup: () => void;
  conversations: ConversationRepo;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  insertChannelWithAgent(
    workspaceName: string,
    agentName: string,
  ): { channelId: string; agentId: string };
}

function makeReconcileFixture(): ReconcileFixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const { silverhandDir, workspacesRoot, cleanup } = makeTempSilverhandDir();
  const conversations = new RealConversationRepo(db);
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  let n = 0;
  return {
    silverhandDir,
    workspacesRoot,
    cleanup,
    conversations,
    agents,
    workspaces,
    insertChannelWithAgent(workspaceName, agentName) {
      n += 1;
      const ws = workspaces.insert({
        name: workspaceName,
        description: null,
        workspacePath: `${workspacesRoot}/${workspaceName}-${n}`,
        workspaceHostId: localHostId,
      });
      const agent = agents.create(
        { name: agentName, runtime: 'claude', host_id: localHostId },
        localHostId,
        viewerUserId,
      );
      const channel = conversations.insertChannel({
        workspaceId: ws.id,
        workspacePath: ws.workspace_path,
        title: workspaceName,
        spawnedByAgentId: null,
      });
      conversations.addAgent(channel.id, agent.id);
      return { channelId: channel.id, agentId: agent.id };
    },
  };
}

function readyFrame(daemonPid: number, startedAt: number) {
  return {
    event: 'ready' as const,
    daemon_pid: daemonPid,
    daemon_version: 'test',
    started_at: startedAt,
    socket_path: '/tmp/fake.sock',
  };
}

describe('DaemonAgentRuntimeHost — reconcileOnBoot', () => {
  it('clears DB rows whose (conv, agent) is absent from the daemon snapshot', async () => {
    const fix = makeReconcileFixture();
    try {
      const alive = fix.insertChannelWithAgent('ws-alive', 'alive');
      const stale = fix.insertChannelWithAgent('ws-stale', 'stale');
      fix.conversations.updateAgentRuntime(alive.channelId, alive.agentId, {
        status: 'active',
        pid: 1111,
      });
      fix.conversations.updateAgentRuntime(stale.channelId, stale.agentId, {
        status: 'starting',
        pid: 2222,
      });

      // Snapshot: daemon knows about the alive pair only.
      const runtimeStatus = vi.fn(
        async (): Promise<RuntimeStatusResult> => ({
          runtimes: [
            {
              conversation_id: alive.channelId,
              agent_id: alive.agentId,
              pid: 1111,
              phase: 'ready',
              run_state: null,
              started_at: 1700000000000,
            },
          ],
        }),
      );
      // Subscribe stub — feed a `ready` event so cache latches a
      // daemon key; otherwise hydrateSafely falls back to "unknown@...".
      const subscribe: HostClient['subscribe'] = sink => {
        sink(readyFrame(1, 1));
        return () => {};
      };

      const { host, events } = makeHost(
        { runtimeStatus, subscribe },
        fix.conversations,
      );
      await host.reconcileOnBoot();

      // Alive row untouched.
      const aliveAfter = fix.conversations.getAgent(
        alive.channelId,
        alive.agentId,
      );
      expect(aliveAfter?.status).toBe('active');
      expect(aliveAfter?.pid).toBe(1111);

      // Stale row flipped to idle + pid cleared.
      const staleAfter = fix.conversations.getAgent(
        stale.channelId,
        stale.agentId,
      );
      expect(staleAfter?.status).toBe('idle');
      expect(staleAfter?.pid).toBeNull();

      // SSE published for the cleared row only.
      const idlePublishes = events.publishes.filter(
        e => e.kind === 'agent_status',
      );
      expect(idlePublishes.length).toBe(1);
      expect(idlePublishes[0]!.conversationId).toBe(stale.channelId);
      expect(idlePublishes[0]!.payload).toMatchObject({
        agent_id: stale.agentId,
        status: 'idle',
        pid: null,
        reason: 'reconcile_stale',
      });

      expect(runtimeStatus).toHaveBeenCalled();
    } finally {
      fix.cleanup();
    }
  });

  it('is a no-op when DB has no live (starting/active) rows', async () => {
    const fix = makeReconcileFixture();
    try {
      const runtimeStatus = vi.fn(
        async (): Promise<RuntimeStatusResult> => ({ runtimes: [] }),
      );
      const subscribe: HostClient['subscribe'] = sink => {
        sink(readyFrame(1, 1));
        return () => {};
      };
      const { host, events } = makeHost(
        { runtimeStatus, subscribe },
        fix.conversations,
      );
      await host.reconcileOnBoot();
      expect(runtimeStatus).toHaveBeenCalled();
      expect(events.publishes).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('skips the DB diff when hydrate failed (does NOT clobber live rows)', async () => {
    const fix = makeReconcileFixture();
    try {
      // Seed a row that WOULD be cleared if we ran the diff.
      const seed = fix.insertChannelWithAgent('ws-x', 'agent-x');
      fix.conversations.updateAgentRuntime(seed.channelId, seed.agentId, {
        status: 'active',
        pid: 9999,
      });

      // Make hydrate fail by throwing from runtimeStatus.
      const runtimeStatus = vi.fn(async (): Promise<RuntimeStatusResult> => {
        throw new Error('daemon unreachable');
      });
      // No `ready` event → no daemon-instance key from that path either.
      const subscribe: HostClient['subscribe'] = () => () => {};

      const { host, cache, events } = makeHost(
        { runtimeStatus, subscribe },
        fix.conversations,
      );
      await host.reconcileOnBoot();

      // Cache empty + no daemon key latched.
      expect(cache.daemonInstanceKey).toBeNull();
      // DB untouched.
      const after = fix.conversations.getAgent(seed.channelId, seed.agentId);
      expect(after?.status).toBe('active');
      expect(after?.pid).toBe(9999);
      // No agent_status publishes.
      expect(
        events.publishes.filter(e => e.kind === 'agent_status'),
      ).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });
});

// ── clearSession ────────────────────────────────────────────────────
//
// Slice 3 (Cindy `5Yrv3roymWkCPxo1` watchlist #2): bridge BEFORE DB.
// Pinned guarantees:
//
//   1. Validation throws synchronously (missing conv / agent /
//      membership) — bridge NOT called.
//   2. `bridge.clearRuntimeSession` runs first. Transport / internal
//      errors propagate; DB is NOT touched (Cindy `BYHZJI9ALSVmmlFr`).
//   3. After bridge ack, DB tx clears `cli_session_id` AND inserts an
//      audit row atomically (one tx, both succeed or both roll back).
//   4. Audit only inserted when `wasRunning || prevCliSessionId !==
//      null` (matches CM `shouldAudit`).
//   5. `wasRunning` derived from the cache view (phase !== 'exited'),
//      NOT from the bridge `{cleared}` flag.
//   6. SSE: `agent_status` always; `message` only when audit landed.

interface ClearSessionFixture {
  silverhandDir: string;
  cleanup: () => void;
  conversations: ConversationRepo;
  agents: AgentRepo;
  messages: MessageRepo;
  db: Database;
  channelId: string;
  agentId: string;
  /** The session id seeded on the row at fixture creation time. */
  initialCliSessionId: string | null;
  countMessages(): number;
  /** Reads the latest message row from the conversation. */
  lastMessage(): {
    content: string;
    from_kind: string;
    metadata: Record<string, unknown> | null;
  } | null;
}

function makeClearSessionFixture(
  opts: { initialCliSessionId?: string | null } = {},
): ClearSessionFixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const { silverhandDir, workspacesRoot, cleanup } = makeTempSilverhandDir();
  const conversations = new RealConversationRepo(db);
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const messages = new MessageRepo(db);

  const ws = workspaces.insert({
    name: 'ws-clear',
    description: null,
    workspacePath: `${workspacesRoot}/ws-clear`,
    workspaceHostId: localHostId,
  });
  const agent = agents.create(
    { name: 'agent-clear', runtime: 'claude', host_id: localHostId },
    localHostId,
    viewerUserId,
  );
  const channel = conversations.insertChannel({
    workspaceId: ws.id,
    workspacePath: ws.workspace_path,
    title: 'ws-clear',
    spawnedByAgentId: null,
  });
  conversations.addAgent(channel.id, agent.id);
  const initialCliSessionId =
    opts.initialCliSessionId === undefined
      ? 'sess-deadbeef-abc123'
      : opts.initialCliSessionId;
  if (initialCliSessionId !== null) {
    conversations.updateAgentRuntime(channel.id, agent.id, {
      cliSessionId: initialCliSessionId,
    });
  }

  return {
    silverhandDir,
    cleanup,
    conversations,
    agents,
    messages,
    db,
    channelId: channel.id,
    agentId: agent.id,
    initialCliSessionId,
    countMessages: () =>
      (db
        .prepare<[string], { c: number }>(
          'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?',
        )
        .get(channel.id)?.c ?? 0) as number,
    lastMessage: () => {
      const row = db
        .prepare<
          [string],
          {
            content: string;
            from_kind: string;
            metadata: string | null;
          }
        >(
          `SELECT content, from_kind, metadata
             FROM messages WHERE conversation_id = ?
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(channel.id);
      if (!row) return null;
      return {
        content: row.content,
        from_kind: row.from_kind,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      };
    },
  };
}

describe('DaemonAgentRuntimeHost — clearSession', () => {
  it('validation throws (missing conversation) WITHOUT touching bridge or DB', async () => {
    const fix = makeClearSessionFixture();
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }),
      );
      const { host } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      await expect(
        host.clearSession('conv-nope', fix.agentId, 'alice'),
      ).rejects.toThrow(/conversation .* not found/);
      expect(runtimeClearSession).not.toHaveBeenCalled();
      // Row untouched.
      const after = fix.conversations.getAgent(fix.channelId, fix.agentId);
      expect(after?.cli_session_id).toBe(fix.initialCliSessionId);
      expect(fix.countMessages()).toBe(0);
    } finally {
      fix.cleanup();
    }
  });

  it('calls bridge.clearRuntimeSession BEFORE writing to DB (order pinned)', async () => {
    const fix = makeClearSessionFixture();
    try {
      const callOrder: string[] = [];
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => {
          callOrder.push('bridge');
          // Snapshot the DB at the moment the bridge is invoked —
          // cli_session_id MUST still be the seeded value (the tx has
          // not run yet).
          const snap = fix.conversations.getAgent(fix.channelId, fix.agentId);
          callOrder.push(`db-during-bridge=${snap?.cli_session_id ?? 'null'}`);
          return { cleared: true };
        },
      );
      const { host } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      const result = await host.clearSession(
        fix.channelId,
        fix.agentId,
        'alice',
      );
      expect(callOrder[0]).toBe('bridge');
      expect(callOrder[1]).toBe(`db-during-bridge=${fix.initialCliSessionId}`);
      // After call returns, DB is cleared.
      const after = fix.conversations.getAgent(fix.channelId, fix.agentId);
      expect(after?.cli_session_id).toBeNull();
      expect(result.prevCliSessionId).toBe(fix.initialCliSessionId);
    } finally {
      fix.cleanup();
    }
  });

  it('transport error from bridge propagates; DB is NOT touched', async () => {
    const fix = makeClearSessionFixture();
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => {
          throw new Error('daemon transport error');
        },
      );
      const { host, events } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      await expect(
        host.clearSession(fix.channelId, fix.agentId, 'alice'),
      ).rejects.toThrow('daemon transport error');
      expect(runtimeClearSession).toHaveBeenCalledTimes(1);
      // DB row untouched.
      const after = fix.conversations.getAgent(fix.channelId, fix.agentId);
      expect(after?.cli_session_id).toBe(fix.initialCliSessionId);
      // No audit row.
      expect(fix.countMessages()).toBe(0);
      // No SSE either.
      expect(events.publishes).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('writes audit + publishes agent_status + message when prevCliSessionId was set', async () => {
    const fix = makeClearSessionFixture();
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }),
      );
      const { host, events } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      const result = await host.clearSession(
        fix.channelId,
        fix.agentId,
        'alice',
      );

      // Result reflects pre-state.
      expect(result.prevCliSessionId).toBe(fix.initialCliSessionId);
      expect(result.wasRunning).toBe(false); // cache empty

      // Row cleared.
      const after = fix.conversations.getAgent(fix.channelId, fix.agentId);
      expect(after?.cli_session_id).toBeNull();

      // Audit row inserted (shouldAudit = prevCliSessionId !== null).
      expect(fix.countMessages()).toBe(1);
      const audit = fix.lastMessage()!;
      expect(audit.from_kind).toBe('system');
      expect(audit.content).toMatch(/cleared @agent-clear's CLI session context/);
      // Prev session prefix truncated to first 8 chars + '...'
      expect(audit.content).toContain('sess-dea...');
      expect(audit.metadata?.subtype).toBe('session_cleared');
      expect(audit.metadata?.was_running).toBe(false);

      // SSE: agent_status + message in this order.
      const kinds = events.publishes.map(e => e.kind);
      expect(kinds).toEqual(['agent_status', 'message']);
      expect(events.publishes[0]!.payload).toMatchObject({
        agent_id: fix.agentId,
        cli_session_id: null,
      });
    } finally {
      fix.cleanup();
    }
  });

  it('skips audit + skips message SSE when prevCliSessionId is null and not running', async () => {
    const fix = makeClearSessionFixture({ initialCliSessionId: null });
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => ({ cleared: false }),
      );
      const { host, events } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      const result = await host.clearSession(
        fix.channelId,
        fix.agentId,
        'alice',
      );
      expect(result.prevCliSessionId).toBeNull();
      expect(result.wasRunning).toBe(false);
      // shouldAudit = false → no message row.
      expect(fix.countMessages()).toBe(0);
      // SSE: agent_status only.
      const kinds = events.publishes.map(e => e.kind);
      expect(kinds).toEqual(['agent_status']);
    } finally {
      fix.cleanup();
    }
  });

  it('derives wasRunning=true from cache (phase != exited), audits even with null prevCliSessionId', async () => {
    const fix = makeClearSessionFixture({ initialCliSessionId: null });
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }),
      );
      const { host, cache, events } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      // Pre-populate cache so phase=ready (i.e. running).
      cache.applyRuntimeStatus(DAEMON_KEY, [
        {
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          pid: 1,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ]);
      const result = await host.clearSession(
        fix.channelId,
        fix.agentId,
        'alice',
      );
      expect(result.wasRunning).toBe(true);
      // shouldAudit fires because wasRunning (even though
      // prevCliSessionId is null).
      expect(fix.countMessages()).toBe(1);
      const kinds = events.publishes.map(e => e.kind);
      expect(kinds).toEqual(['agent_status', 'message']);
      const audit = fix.lastMessage()!;
      expect(audit.metadata?.was_running).toBe(true);
    } finally {
      fix.cleanup();
    }
  });

  it('proceeds with DB tx when bridge returns {cleared:false} (means "nothing to tear down")', async () => {
    // Cindy `BYHZJI9ALSVmmlFr`: `{cleared:false}` is a valid ack —
    // daemon side had nothing live to clear, backend STILL clears
    // its DB session id + writes audit.
    const fix = makeClearSessionFixture();
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => ({ cleared: false }),
      );
      const { host } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      await host.clearSession(fix.channelId, fix.agentId, 'alice');
      const after = fix.conversations.getAgent(fix.channelId, fix.agentId);
      expect(after?.cli_session_id).toBeNull();
      expect(fix.countMessages()).toBe(1);
    } finally {
      fix.cleanup();
    }
  });

  it('audit content carries "A user" prefix when actorUserId is null', async () => {
    const fix = makeClearSessionFixture();
    try {
      const runtimeClearSession = vi.fn(
        async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }),
      );
      const { host } = makeHost(
        { runtimeClearSession },
        fix.conversations,
        { agents: fix.agents, messages: fix.messages, db: fix.db },
      );
      await host.clearSession(fix.channelId, fix.agentId, null);
      const audit = fix.lastMessage()!;
      expect(audit.content).toMatch(/^A user cleared/);
    } finally {
      fix.cleanup();
    }
  });
});
