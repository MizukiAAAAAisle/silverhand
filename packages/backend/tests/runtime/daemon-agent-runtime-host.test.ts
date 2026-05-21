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
 *   - `stopAll` — `bridge.runtimeStopAll`
 *   - `closeActivityLog` — `bridge.runtimeCloseActivityLog`
 *
 * Still throws (covered by scaffolding-error tests below):
 *   - `start`, `deliverMessage`, `clearSession`, `reconcileOnBoot`
 *   - `stop` with `mode='soft'`
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
  RuntimeCloseActivityLogResult,
  RuntimeStatusResult,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
} from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import { DaemonAgentRuntimeHost } from '../../src/runtime/daemon-agent-runtime-host.js';
import { RuntimeBridge } from '../../src/runtime/bridge.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { RuntimeEventHandler } from '../../src/runtime/event-handler.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import type { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationRepo as RealConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
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
  subscribe?: HostClient['subscribe'];
}

const noopLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Minimal stub used by tests that never call reconcileOnBoot — the
// type checker insists on a ConversationRepo shape, but listLiveStatusAgents
// is never invoked. Cast through `unknown` keeps the surface narrow.
const noopConversationRepo = {
  listLiveStatusAgents: () => [],
  updateAgentRuntime: () => null,
} as unknown as ConversationRepo;

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
    runtimeClearSession: reject,
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

  it('stop(mode=soft) throws with rollback recipe', async () => {
    const { host } = makeHost();
    let err: unknown;
    await host.stop(CONV, AGENT_X, 'soft', 'pause now').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'stop(mode=soft)');
  });

  it('clearSession() throws with rollback recipe', async () => {
    const { host } = makeHost();
    let err: unknown;
    await host.clearSession(CONV, AGENT_X, 'user-1').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'clearSession');
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
