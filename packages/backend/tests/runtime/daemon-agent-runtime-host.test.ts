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
 *   - `closeActivityLog` — daemon flush ack + backend activity-log close
 *   - `reconcileOnBoot` — daemon snapshot-aware diff
 *   - `clearSession` — bridge first, DB tx + audit + SSE
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
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeStatusResult,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
} from '@silverhand/host';
import {
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
} from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import type { Database } from 'better-sqlite3';
import { DaemonAgentRuntimeHost } from '../../src/runtime/daemon-agent-runtime-host.js';
import type { ActivityLogWriter } from '../../src/runtime/activity-log-writer.js';
import { RuntimeBridge } from '../../src/runtime/bridge.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { RuntimeEventHandler } from '../../src/runtime/event-handler.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import type { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationRepo as RealConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { SettingsRepo } from '../../src/repos/settings-repo.js';
import { RuntimeDeliveryCoordinator } from '../../src/runtime/delivery-coordinator.js';
import { combineGatedBatch } from '../../src/runtime/stdin-format.js';
import { RuntimeHostPlacementError } from '../../src/host-placement-errors.js';
import type { RuntimeHostPlacement } from '../../src/runtime/host-placement.js';
import { MembershipService } from '../../src/services/membership-service.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import type { BackendLogger, SilverhandCliLauncher } from '../../src/context.js';
import type { ServerConfig } from '@silverhand/shared';
import { openTestDb, makeTempSilverhandDir } from '../utils/db.js';

interface ClientOverrides {
  runtimeStart?: (params: RuntimeStartParams) => Promise<RuntimeStartResult> | RuntimeStartResult;
  runtimeStop?: (params: RuntimeStopParams) => Promise<RuntimeStopResult> | RuntimeStopResult;
  runtimeStopAll?: () => Promise<RuntimeStopAllResult> | RuntimeStopAllResult;
  runtimeCloseActivityLog?: () => Promise<RuntimeCloseActivityLogResult> | RuntimeCloseActivityLogResult;
  runtimeStatus?: () => Promise<RuntimeStatusResult> | RuntimeStatusResult;
  runtimeClearSession?: (params: {
    conversation_id: string;
    agent_id: string;
  }) => Promise<RuntimeClearSessionResult> | RuntimeClearSessionResult;
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
  transaction:
    <T>(fn: () => T) =>
    () =>
      fn(),
} as unknown as Database;

const noopInboxRepo = {
  ensureDelivery: () => {
    throw new Error('noopInboxRepo.ensureDelivery invoked');
  },
  markDelivered: () => {},
  listPending: () => [],
} as unknown as ConversationInboxRepo;

const noopUserRepo = {
  get: () => null,
} as unknown as UserRepo;

const noopSettingsRepo = {
  getViewerUserId: () => null,
} as unknown as SettingsRepo;

// New-in-slice-4c stubs — start() reads from workspace/membership +
// the auth/launcher/serverConfig wiring. Tests that don't exercise
// start() never invoke these.
const noopWorkspaceRepo = {
  get: () => null,
  listForAgent: () => [],
} as unknown as WorkspaceRepo;
const noopPlacement = {
  assertActiveHost: () => ({
    id: 'host-local',
    name: 'local',
    kind: 'local',
    user_id: 'local',
    installation_id: 'test-install',
    last_seen_at: null,
    revoked_at: null,
    created_at: 1,
  }),
  resolveForAgent: () => ({
    host: {
      id: 'host-local',
      name: 'local',
      kind: 'local',
      user_id: 'local',
      installation_id: 'test-install',
      last_seen_at: null,
      revoked_at: null,
      created_at: 1,
    },
  }),
} satisfies RuntimeHostPlacement;
const noopMembership = {
  listMembers: () => [],
} as unknown as MembershipService;
const noopAgentTokens = new AgentTokenStore();
const noopSilverhandCli: SilverhandCliLauncher = {
  command: '/tmp/silverhand-stub',
  args: [],
};
const noopServerConfig = (): ServerConfig => ({
  mode: 'embedded',
  url: 'http://127.0.0.1:0',
  auth_token: 'test-token-1234567890ab',
  refresh_token: null,
  child_sessions: {
    max_concurrent_per_parent: null,
    spawn_cooldown_seconds: null,
    max_depth: 1,
  },
});

function makeFakeClient(overrides: ClientOverrides = {}): HostClient {
  // Methods absent from `overrides` are unreachable in the tests below
  // (the live methods explicitly delegate to bridge.runtimeStop /
  // .runtimeStopAll / .runtimeCloseActivityLog only). We supply rejecting
  // stubs so any accidental delegation surfaces loudly as an unexpected
  // resolution.
  const reject = () => Promise.reject(new Error('unmocked host client method'));
  return {
    ping: reject,
    subscribe: overrides.subscribe ?? (() => () => {}),
    onReconnect: () => () => {},
    runtimeStart: overrides.runtimeStart
      ? async (params: RuntimeStartParams) => overrides.runtimeStart!(params)
      : reject,
    runtimeStop: overrides.runtimeStop ? async (params: RuntimeStopParams) => overrides.runtimeStop!(params) : reject,
    runtimeWake: reject,
    runtimeStatus: overrides.runtimeStatus ? async () => overrides.runtimeStatus!() : reject,
    runtimeClearSession: overrides.runtimeClearSession
      ? async (params: { conversation_id: string; agent_id: string }) => overrides.runtimeClearSession!(params)
      : reject,
    runtimeStopAll: overrides.runtimeStopAll ? async () => overrides.runtimeStopAll!() : reject,
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
  events: {
    publishes: Array<{
      conversationId: string;
      kind: string;
      payload: unknown;
    }>;
  };
  publisher: EventPublisher;
}

function makeHost(
  clientOverrides: ClientOverrides = {},
  conversations: ConversationRepo = noopConversationRepo,
  extraDeps: {
    agents?: AgentRepo;
    messages?: MessageRepo;
    db?: Database;
    inboxes?: ConversationInboxRepo;
    users?: UserRepo;
    settings?: SettingsRepo;
    coordinator?: RuntimeDeliveryCoordinator;
    cache?: RunStateCache;
    workspaces?: WorkspaceRepo;
    placement?: RuntimeHostPlacement;
    membership?: MembershipService;
    silverhandDir?: string;
    silverhandCli?: SilverhandCliLauncher;
    agentTokens?: AgentTokenStore;
    serverConfig?: () => ServerConfig;
    logger?: BackendLogger;
    baseProcessEnv?: NodeJS.ProcessEnv;
    activityLog?: ActivityLogWriter;
  } = {},
): HostFixture {
  const client = makeFakeClient(clientOverrides);
  const bridge = new RuntimeBridge(client, { get: () => null });
  const cache = extraDeps.cache ?? new RunStateCache();
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
  const inboxes = extraDeps.inboxes ?? noopInboxRepo;
  const settings = extraDeps.settings ?? noopSettingsRepo;
  const users = extraDeps.users ?? noopUserRepo;
  // Default coordinator passes through to a noop bridge / inbox sink.
  // Tests that want to observe coordinator interactions inject one
  // explicitly via `extraDeps.coordinator` (typically a real
  // RuntimeDeliveryCoordinator wrapping mocked bridge + sink) so the
  // submitLiveDelivery decision is observable.
  const coordinator =
    extraDeps.coordinator ??
    new RuntimeDeliveryCoordinator({
      bridge: { runtimeWake: () => Promise.reject(new Error('noop wake')) },
      cache,
      inboxAck: { markDelivered: () => {} },
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
    inboxes,
    users,
    settings,
    coordinator,
    workspaces: extraDeps.workspaces ?? noopWorkspaceRepo,
    placement: extraDeps.placement ?? noopPlacement,
    membership: extraDeps.membership ?? noopMembership,
    silverhandDir: extraDeps.silverhandDir ?? '/tmp/silverhand-stub-dir',
    silverhandCli: extraDeps.silverhandCli ?? noopSilverhandCli,
    agentTokens: extraDeps.agentTokens ?? noopAgentTokens,
    serverConfig: extraDeps.serverConfig ?? noopServerConfig,
    db: extraDeps.db ?? noopDb,
    logger: extraDeps.logger ?? noopLogger,
    baseProcessEnv: extraDeps.baseProcessEnv,
    activityLog: extraDeps.activityLog,
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

function throwingPlacement(calls: string[] = []): RuntimeHostPlacement {
  const err = new RuntimeHostPlacementError(
    'host_revoked',
    'host host-local has been revoked',
  );
  return {
    assertActiveHost: () => {
      throw err;
    },
    resolveForAgent: agentId => {
      calls.push(agentId);
      throw err;
    },
  };
}

describe('DaemonAgentRuntimeHost — placement guard', () => {
  it('fails closed before every runtime intent when the agent host is revoked', async () => {
    const entrypoints: Array<{
      name: string;
      invoke: (host: DaemonAgentRuntimeHost) => Promise<unknown>;
    }> = [
      { name: 'start', invoke: host => host.start(CONV, AGENT_X) },
      { name: 'stop', invoke: host => host.stop(CONV, AGENT_X, 'hard') },
      {
        name: 'clearSession',
        invoke: host => host.clearSession(CONV, AGENT_X, 'local'),
      },
      {
        name: 'deliverMessage',
        invoke: host => host.deliverMessage(CONV, AGENT_X, 'msg-1'),
      },
      { name: 'drainPending', invoke: host => host.drainPending(CONV, AGENT_X) },
    ];

    for (const entrypoint of entrypoints) {
      const calls: string[] = [];
      const { host } = makeHost({}, noopConversationRepo, {
        placement: throwingPlacement(calls),
      });

      await expect(entrypoint.invoke(host), entrypoint.name).rejects.toMatchObject({
        code: 'host_revoked',
      });
      expect(calls, entrypoint.name).toEqual([AGENT_X]);
    }
  });
});

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
        run_state: fakeRunState({
          runId: 'r-other',
          conversationId: 'conv-other',
        }),
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
        run_state: fakeRunState({
          runId: 'r-other',
          conversationId: 'conv-other',
        }),
        started_at: 1700000000000,
      },
    ]);
    host.resolveConversationRuns(CONV);
    expect(events.publishes.length).toBe(2);
    const reasons = events.publishes.map(e => (e.payload as AgentRunState).terminalReason);
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
    const runtimeStop = vi.fn(async (): Promise<RuntimeStopResult> => {
      throw new Error('daemon disconnected');
    });
    const { host } = makeHost({ runtimeStop });
    await expect(host.stop(CONV, AGENT_X, 'hard')).rejects.toThrow('daemon disconnected');
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
// Option A v2 (Cindy `UMGu36zoTDVuKWXi`): backend ships the raw
// directive text inside `runtime_stop({mode:'soft', soft_directive:
// <raw text>})`. The daemon owns encoding via its in-process driver
// instance (whose state — codex threadId, etc — is authoritative).
// Backend never calls `encodeStdinMessage` and no longer probes for
// "driver accepts stdin"; pre-`readyToEncode()` soft stop and
// non-stdin drivers (cursor oneShot) both surface from the daemon
// as `directive_delivered:false` with `reason:'driver_refused'`,
// which the backend logs as a warn — exactly the same path the
// last test in this block exercises. The cache is NOT mutated
// (event handler owns the exit projection — same as hard stop).

function makeAgentRepoStub(agents: Array<{ id: string; name: string; runtime: 'claude' | 'cursor' }>): AgentRepo {
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
  it('ships RAW directive text via bridge with soft_directive (daemon owns encode — Option A v2)', async () => {
    const runtimeStop = vi.fn(
      async (_params: RuntimeStopParams): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    const agents = makeAgentRepoStub([{ id: AGENT_X, name: 'alice', runtime: 'claude' }]);
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
    // Option A v2: backend ships verbatim text — the daemon encodes via
    // its in-process driver (codex threadId etc lives there). Backend
    // never produces a stream-json line; cli_session_id is the daemon's
    // (stateful) driver's concern.
    expect((call as { soft_directive: string }).soft_directive).toBe('pause and wait');
  });

  it('uses default directive (raw text) when softDirective omitted', async () => {
    const runtimeStop = vi.fn(
      async (_params: RuntimeStopParams): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    const agents = makeAgentRepoStub([{ id: AGENT_X, name: 'alice', runtime: 'claude' }]);
    const conversations = makeConvRepoStub([{ conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null }]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    await host.stop(CONV, AGENT_X, 'soft');
    const shipped = (runtimeStop.mock.calls[0]![0] as { soft_directive: string }).soft_directive;
    // Default phrasing must mention "course correction" so CM-parity
    // tests don't drift, AND it must be raw text (not JSON) per Option A v2.
    expect(shipped).toMatch(/course correction/);
    expect(() => JSON.parse(shipped)).toThrow(); // proves not pre-encoded
  });

  it('non-stdin drivers (cursor oneShot) — backend ships text; daemon surfaces driver_refused as warn (Option A v2)', async () => {
    // Pre-Option A v2 the backend probed `driver.encodeStdinMessage`
    // and threw "does not accept stdin soft directives" before even
    // calling the bridge. Under Option A v2 that responsibility moved
    // into RealSupervisor (`driver_refused` arm — Cindy
    // `wYjG20JdGjLpwq8K`), so backend now ships the text and the
    // daemon's `directive_delivered:false / reason:'driver_refused'`
    // arm becomes the failure surface — handled by the existing warn
    // path below. This test pins that the backend NO LONGER throws
    // (and does NOT short-circuit) for oneShot agents — it must call
    // the bridge so the daemon can refuse cleanly.
    const runtimeStop = vi.fn(
      async (_params: RuntimeStopParams): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: false,
        reason: 'driver_refused',
      }),
    );
    const agents = makeAgentRepoStub([{ id: AGENT_X, name: 'cursor-bot', runtime: 'cursor' }]);
    const conversations = makeConvRepoStub([{ conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null }]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    // Does not throw — soft path is best-effort; warn-only handling
    // covers the refused arm (see the dedicated warn test below).
    await expect(host.stop(CONV, AGENT_X, 'soft')).resolves.toBeUndefined();
    expect(runtimeStop).toHaveBeenCalledTimes(1);
    const call = runtimeStop.mock.calls[0]![0];
    expect(call.mode).toBe('soft');
    expect((call as { soft_directive: string }).soft_directive).toMatch(/course correction/);
  });

  it('throws without calling bridge when agent row missing', async () => {
    const runtimeStop = vi.fn(
      async (): Promise<RuntimeStopResult> => ({
        mode: 'soft',
        directive_delivered: true,
      }),
    );
    // Empty agents stub → host.stop will throw "agent not found".
    const { host } = makeHost({ runtimeStop }, makeConvRepoStub([]), {
      agents: makeAgentRepoStub([]),
    });
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
    const agents = makeAgentRepoStub([{ id: AGENT_X, name: 'alice', runtime: 'claude' }]);
    const conversations = makeConvRepoStub([{ conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null }]);
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
      inboxes: noopInboxRepo,
      users: noopUserRepo,
      settings: noopSettingsRepo,
      coordinator: new RuntimeDeliveryCoordinator({
        bridge: { runtimeWake: () => Promise.reject(new Error('noop')) },
        cache,
        inboxAck: { markDelivered: () => {} },
      }),
      workspaces: noopWorkspaceRepo,
      placement: noopPlacement,
      membership: noopMembership,
      silverhandDir: '/tmp/silverhand-stub-dir',
      silverhandCli: noopSilverhandCli,
      agentTokens: noopAgentTokens,
      serverConfig: noopServerConfig,
      db: noopDb,
      logger: customLogger,
    });
    await host.stop(CONV, AGENT_X, 'soft', 'pause now');
    expect(warned.length).toBe(1);
    expect(warned[0]!.msg).toMatch(/soft stop directive not delivered/);
    expect(warned[0]!.obj).toMatchObject({
      mode: 'daemon',
      conversationId: CONV,
      agent_id: AGENT_X,
      reason: 'not_running',
    });
  });

  it('propagates bridge errors (does NOT swallow)', async () => {
    const runtimeStop = vi.fn(async (): Promise<RuntimeStopResult> => {
      throw new Error('daemon disconnected');
    });
    const agents = makeAgentRepoStub([{ id: AGENT_X, name: 'alice', runtime: 'claude' }]);
    const conversations = makeConvRepoStub([{ conversation_id: CONV, agent_id: AGENT_X, cli_session_id: null }]);
    const { host } = makeHost({ runtimeStop }, conversations, { agents });
    await expect(host.stop(CONV, AGENT_X, 'soft')).rejects.toThrow('daemon disconnected');
  });
});

describe('DaemonAgentRuntimeHost — stopAll / closeActivityLog', () => {
  it('stopAll delegates to bridge.runtimeStopAll', async () => {
    const runtimeStopAll = vi.fn(async (): Promise<RuntimeStopAllResult> => ({ stopped_count: 3 }));
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

  it('closeActivityLog delegates to bridge.runtimeCloseActivityLog then closes backend writer', async () => {
    const calls: string[] = [];
    const runtimeCloseActivityLog = vi.fn(async (): Promise<RuntimeCloseActivityLogResult> => {
      calls.push('bridge');
      return { flushed: true };
    });
    const activityLog = {
      write: vi.fn(),
      close: vi.fn(async () => {
        calls.push('writer');
      }),
    };
    const { host } = makeHost({ runtimeCloseActivityLog }, noopConversationRepo, { activityLog });
    await host.closeActivityLog();
    expect(runtimeCloseActivityLog).toHaveBeenCalledTimes(1);
    expect(activityLog.close).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['bridge', 'writer']);
  });

  it('closeActivityLog propagates bridge errors', async () => {
    const runtimeCloseActivityLog = vi.fn(async (): Promise<RuntimeCloseActivityLogResult> => {
      throw new Error('daemon disconnected');
    });
    const { host } = makeHost({ runtimeCloseActivityLog });
    await expect(host.closeActivityLog()).rejects.toThrow('daemon disconnected');
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
          inboxes: noopInboxRepo,
          users: noopUserRepo,
          settings: noopSettingsRepo,
          coordinator: new RuntimeDeliveryCoordinator({
            bridge: {
              runtimeWake: () => Promise.reject(new Error('noop')),
            },
            cache,
            inboxAck: { markDelivered: () => {} },
          }),
          workspaces: noopWorkspaceRepo,
          placement: noopPlacement,
          membership: noopMembership,
          silverhandDir: '/tmp/silverhand-stub-dir',
          silverhandCli: noopSilverhandCli,
          agentTokens: noopAgentTokens,
          serverConfig: noopServerConfig,
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
  insertChannelWithAgent(workspaceName: string, agentName: string): { channelId: string; agentId: string };
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
    protocol_version: HOST_PROTOCOL_VERSION,
    daemon_pid: daemonPid,
    daemon_version: 'test',
    daemon_id: 'local',
    instance_id: `${startedAt}-${daemonPid}`,
    host_descriptor: { name: 'local', kind: 'local' as const },
    capabilities: [...KNOWN_CAPABILITIES_V1],
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

      const { host, events } = makeHost({ runtimeStatus, subscribe }, fix.conversations);
      await host.reconcileOnBoot();

      // Alive row untouched.
      const aliveAfter = fix.conversations.getAgent(alive.channelId, alive.agentId);
      expect(aliveAfter?.status).toBe('active');
      expect(aliveAfter?.pid).toBe(1111);

      // Stale row flipped to idle + pid cleared.
      const staleAfter = fix.conversations.getAgent(stale.channelId, stale.agentId);
      expect(staleAfter?.status).toBe('idle');
      expect(staleAfter?.pid).toBeNull();

      // SSE published for the cleared row only.
      const idlePublishes = events.publishes.filter(e => e.kind === 'agent_status');
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
      const runtimeStatus = vi.fn(async (): Promise<RuntimeStatusResult> => ({ runtimes: [] }));
      const subscribe: HostClient['subscribe'] = sink => {
        sink(readyFrame(1, 1));
        return () => {};
      };
      const { host, events } = makeHost({ runtimeStatus, subscribe }, fix.conversations);
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

      const { host, cache, events } = makeHost({ runtimeStatus, subscribe }, fix.conversations);
      await host.reconcileOnBoot();

      // Cache empty + no daemon key latched.
      expect(cache.daemonInstanceKey).toBeNull();
      // DB untouched.
      const after = fix.conversations.getAgent(seed.channelId, seed.agentId);
      expect(after?.status).toBe('active');
      expect(after?.pid).toBe(9999);
      // No agent_status publishes.
      expect(events.publishes.filter(e => e.kind === 'agent_status')).toEqual([]);
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

function makeClearSessionFixture(opts: { initialCliSessionId?: string | null } = {}): ClearSessionFixture {
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
    opts.initialCliSessionId === undefined ? 'sess-deadbeef-abc123' : opts.initialCliSessionId;
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
        .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?')
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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      const { host } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
      await expect(host.clearSession('conv-nope', fix.agentId, 'alice')).rejects.toThrow(/conversation .* not found/);
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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => {
        callOrder.push('bridge');
        // Snapshot the DB at the moment the bridge is invoked —
        // cli_session_id MUST still be the seeded value (the tx has
        // not run yet).
        const snap = fix.conversations.getAgent(fix.channelId, fix.agentId);
        callOrder.push(`db-during-bridge=${snap?.cli_session_id ?? 'null'}`);
        return { cleared: true };
      });
      const { host } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
      const result = await host.clearSession(fix.channelId, fix.agentId, 'alice');
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

  it('clears coordinator runtime state after daemon clear succeeds', async () => {
    const fix = makeClearSessionFixture();
    try {
      const cache = new RunStateCache();
      const coordinator = new RuntimeDeliveryCoordinator({
        bridge: { runtimeWake: () => Promise.reject(new Error('unused')) },
        cache,
        inboxAck: { markDelivered: () => {} },
      });
      const clearRuntime = vi.spyOn(coordinator, 'clearRuntime');
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      const { host } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
        cache,
        coordinator,
      });

      await host.clearSession(fix.channelId, fix.agentId, 'alice');

      expect(runtimeClearSession).toHaveBeenCalledTimes(1);
      expect(clearRuntime).toHaveBeenCalledWith(fix.channelId, fix.agentId, 'stopped');
    } finally {
      fix.cleanup();
    }
  });

  it('transport error from bridge propagates; DB is NOT touched', async () => {
    const fix = makeClearSessionFixture();
    try {
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => {
        throw new Error('daemon transport error');
      });
      const { host, events } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
      await expect(host.clearSession(fix.channelId, fix.agentId, 'alice')).rejects.toThrow('daemon transport error');
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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      const { host, events } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
      const result = await host.clearSession(fix.channelId, fix.agentId, 'alice');

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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: false }));
      const { host, events } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
      const result = await host.clearSession(fix.channelId, fix.agentId, 'alice');
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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      const { host, cache, events } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
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
      const result = await host.clearSession(fix.channelId, fix.agentId, 'alice');
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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: false }));
      const { host } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
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
      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      const { host } = makeHost({ runtimeClearSession }, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        db: fix.db,
      });
      await host.clearSession(fix.channelId, fix.agentId, null);
      const audit = fix.lastMessage()!;
      expect(audit.content).toMatch(/^A user cleared/);
    } finally {
      fix.cleanup();
    }
  });

  // B4 (Cindy `usjxj8AxX4AvJ5E-`): audit row must be delivered to every
  // OTHER agent in the conversation via `deliverMessage`, matching CM's
  // `publishAndDeliverSessionClearedAudit` semantics. The cleared agent
  // does NOT receive its own audit. Per-delivery failures only warn —
  // clearSession as a whole still succeeds.
  it('delivers audit message to peer agents via deliverMessage; cleared agent does not get own', async () => {
    const { db, viewerUserId, localHostId } = openTestDb();
    const { silverhandDir, workspacesRoot, cleanup } = makeTempSilverhandDir();
    const conversations = new RealConversationRepo(db);
    const agents = new AgentRepo(db);
    const workspaces = new WorkspaceRepo(db, { workspacesRoot });
    const messages = new MessageRepo(db);
    const inboxes = new ConversationInboxRepo(db);
    const users = new UserRepo(db);
    const settings = new SettingsRepo(db);

    try {
      const ws = workspaces.insert({
        name: 'ws-clear-2',
        description: null,
        workspacePath: `${workspacesRoot}/ws-clear-2`,
        workspaceHostId: localHostId,
      });
      const cleared = agents.create(
        { name: 'agent-cleared', runtime: 'claude', host_id: localHostId },
        localHostId,
        viewerUserId,
      );
      const peer = agents.create(
        { name: 'agent-peer', runtime: 'claude', host_id: localHostId },
        localHostId,
        viewerUserId,
      );
      const channel = conversations.insertChannel({
        workspaceId: ws.id,
        workspacePath: ws.workspace_path,
        title: 'ws-clear-2',
        spawnedByAgentId: null,
      });
      conversations.addAgent(channel.id, cleared.id);
      conversations.addAgent(channel.id, peer.id);
      conversations.updateAgentRuntime(channel.id, cleared.id, {
        cliSessionId: 'sess-deadbeef-abc123',
      });

      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      // Coordinator is not needed here — peer has no cache entry and
      // claude (kickoffMode='requires_first_message') is NOT oneShot,
      // so deliverMessage short-circuits before the coordinator runs.
      // The inbox row is what we assert on (rows replay via
      // startup_delivery on peer's next spawn).
      const { host, events } = makeHost({ runtimeClearSession }, conversations, {
        agents,
        messages,
        db,
        inboxes,
        users,
        settings,
        silverhandDir,
      });
      await host.clearSession(channel.id, cleared.id, 'alice');

      // Cleared agent's row is wiped.
      const after = conversations.getAgent(channel.id, cleared.id);
      expect(after?.cli_session_id).toBeNull();

      // Exactly one audit message in the conversation.
      const messageCount = (db
        .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?')
        .get(channel.id)?.c ?? 0) as number;
      expect(messageCount).toBe(1);
      const auditRow = db
        .prepare<[string], { id: string }>(
          `SELECT id FROM messages WHERE conversation_id = ?
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(channel.id)!;

      // Peer agent's inbox has the audit row pending; cleared agent has none.
      const peerInbox = db
        .prepare<[string, string, string], { id: number; delivered_at: number | null }>(
          `SELECT id, delivered_at FROM conversation_inboxes
             WHERE conversation_id = ? AND agent_id = ? AND message_id = ?`,
        )
        .get(channel.id, peer.id, auditRow.id);
      expect(peerInbox).toBeDefined();
      // Peer is not running → row stays pending; coordinator never ran.
      expect(peerInbox!.delivered_at).toBeNull();

      const clearedInbox =
        db
          .prepare<[string, string], { c: number }>(
            'SELECT COUNT(*) AS c FROM conversation_inboxes WHERE conversation_id = ? AND agent_id = ?',
          )
          .get(channel.id, cleared.id)?.c ?? 0;
      expect(clearedInbox).toBe(0);

      // SSE: agent_status + message.
      expect(events.publishes.map(e => e.kind)).toEqual(['agent_status', 'message']);
    } finally {
      cleanup();
    }
  });

  // B4 (cont'd): per-delivery failure warns only — clearSession still
  // succeeds. Simulated by proxying the agents repo so peer's
  // `agents.get` throws inside deliverMessage (the cleared agent's
  // earlier `agents.get` call for the audit row still goes through).
  it('peer deliverMessage failure does not fail clearSession (warn-only)', async () => {
    const { db, viewerUserId, localHostId } = openTestDb();
    const { silverhandDir, workspacesRoot, cleanup } = makeTempSilverhandDir();
    const conversations = new RealConversationRepo(db);
    const realAgents = new AgentRepo(db);
    const workspaces = new WorkspaceRepo(db, { workspacesRoot });
    const messages = new MessageRepo(db);
    const inboxes = new ConversationInboxRepo(db);
    const users = new UserRepo(db);
    const settings = new SettingsRepo(db);

    try {
      const ws = workspaces.insert({
        name: 'ws-clear-3',
        description: null,
        workspacePath: `${workspacesRoot}/ws-clear-3`,
        workspaceHostId: localHostId,
      });
      const cleared = realAgents.create(
        { name: 'agent-cleared', runtime: 'claude', host_id: localHostId },
        localHostId,
        viewerUserId,
      );
      const peer = realAgents.create(
        { name: 'agent-peer', runtime: 'claude', host_id: localHostId },
        localHostId,
        viewerUserId,
      );
      const channel = conversations.insertChannel({
        workspaceId: ws.id,
        workspacePath: ws.workspace_path,
        title: 'ws-clear-3',
        spawnedByAgentId: null,
      });
      conversations.addAgent(channel.id, cleared.id);
      conversations.addAgent(channel.id, peer.id);
      conversations.updateAgentRuntime(channel.id, cleared.id, {
        cliSessionId: 'sess-deadbeef-abc123',
      });

      // Proxy agents so `agents.get(peer.id)` throws. Cleared agent's
      // `agents.get` is called earlier (when building the audit row) and
      // must still succeed.
      const agents = new Proxy(realAgents, {
        get(target, prop, receiver) {
          if (prop === 'get') {
            return (id: string) => {
              if (id === peer.id) {
                throw new Error('simulated peer agents.get failure');
              }
              return target.get(id);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as AgentRepo;

      const runtimeClearSession = vi.fn(async (): Promise<RuntimeClearSessionResult> => ({ cleared: true }));
      const { host } = makeHost({ runtimeClearSession }, conversations, {
        agents,
        messages,
        db,
        inboxes,
        users,
        settings,
        silverhandDir,
      });
      // clearSession must still resolve — peer failure is warn-only.
      await expect(host.clearSession(channel.id, cleared.id, 'alice')).resolves.toMatchObject({ wasRunning: false });

      // DB still cleared + audit row still inserted.
      const after = conversations.getAgent(channel.id, cleared.id);
      expect(after?.cli_session_id).toBeNull();
      const messageCount = (db
        .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?')
        .get(channel.id)?.c ?? 0) as number;
      expect(messageCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ── deliverMessage ──────────────────────────────────────────────────
//
// Slice 4b: `deliverMessage` orchestrates inbox `ensureDelivery` →
// driver encode → `coordinator.submitLiveDelivery`. The coordinator
// owns the wake-vs-queue-vs-respawn decision + `markDelivered` timing
// (Cindy `0G5uJBydO_4qt_2r`: backend NEVER marks rows delivered
// outside the wake ack path). Test surface:
//
//   1. Missing message → log warn + return; no inbox write.
//   2. Already-delivered row → log + return; no coordinator call.
//   3. Agent not in agents table → log warn + return; row stays
//      pending (ensureDelivery already ran — that's idempotent).
//   4. No cache entry + driver NOT oneShot → log + return; no
//      coordinator call; row stays pending for next start drain.
//   5. No cache entry + driver IS oneShot → call `this.start()` (still
//      throws in 4b but caught + logged; row stays pending).
//   6. Cache entry exists, driver.encodeStdinMessage returns null →
//      log + return; no coordinator call.
//   7. Cache entry exists, driver returns a line → coordinator.
//      submitLiveDelivery called with payload + driver capability
//      snapshot.

interface DeliverFixture {
  cleanup: () => void;
  db: Database;
  channelId: string;
  agentId: string;
  agents: AgentRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  inboxes: ConversationInboxRepo;
  users: UserRepo;
  settings: SettingsRepo;
  /** Insert a message authored by the registered viewer and return id. */
  insertViewerMessage(content: string): string;
}

function makeDeliverFixture(
  opts: {
    agentRuntime?: 'claude' | 'cursor';
  } = {},
): DeliverFixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const { workspacesRoot, cleanup } = makeTempSilverhandDir();
  const conversations = new RealConversationRepo(db);
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const messages = new MessageRepo(db);
  const inboxes = new ConversationInboxRepo(db);
  const users = new UserRepo(db);
  const settings = new SettingsRepo(db);

  const ws = workspaces.insert({
    name: 'ws-deliver',
    description: null,
    workspacePath: `${workspacesRoot}/ws-deliver`,
    workspaceHostId: localHostId,
  });
  const agent = agents.create(
    {
      name: 'agent-deliver',
      runtime: opts.agentRuntime ?? 'claude',
      host_id: localHostId,
    },
    localHostId,
    viewerUserId,
  );
  const channel = conversations.insertChannel({
    workspaceId: ws.id,
    workspacePath: ws.workspace_path,
    title: 'ws-deliver',
    spawnedByAgentId: null,
  });
  conversations.addAgent(channel.id, agent.id);

  return {
    cleanup,
    db,
    channelId: channel.id,
    agentId: agent.id,
    agents,
    conversations,
    messages,
    inboxes,
    users,
    settings,
    insertViewerMessage: (content: string) => {
      const dto = messages.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: viewerUserId,
        content,
      });
      return dto.id;
    },
  };
}

/** Coordinator with mocked bridge + sink so deliverMessage tests can
 *  observe submitLiveDelivery outcomes without a real daemon. */
function makeObservableCoordinator(cache: RunStateCache): {
  coordinator: RuntimeDeliveryCoordinator;
  wakeCalls: Array<{
    conversationId: string;
    agent_id: string;
    delivery_ids: number[];
    text: string;
  }>;
  marked: number[][];
  setWakeResponse(
    r:
      | { delivered: true; ids?: number[] }
      | {
          delivered: false;
          reason:
            | 'not_running'
            | 'not_initialized'
            | 'startup_pending'
            | 'draining'
            | 'driver_not_ready'
            | 'driver_refused';
        },
  ): void;
} {
  let next:
    | { delivered: true; ids?: number[] }
    | {
        delivered: false;
        reason:
          | 'not_running'
          | 'not_initialized'
          | 'startup_pending'
          | 'draining'
          | 'driver_not_ready'
          | 'driver_refused';
      } = { delivered: true };
  const wakeCalls: Array<{
    conversationId: string;
    agent_id: string;
    delivery_ids: number[];
    text: string;
  }> = [];
  const marked: number[][] = [];
  const coordinator = new RuntimeDeliveryCoordinator({
    bridge: {
      runtimeWake: async params => {
        wakeCalls.push({
          conversationId: params.conversation_id,
          agent_id: params.agent_id,
          delivery_ids: params.delivery_ids,
          text: params.text,
        });
        if (next.delivered) {
          return {
            delivered: true,
            delivery_ids: next.ids ?? params.delivery_ids,
          };
        }
        return {
          delivered: false,
          reason: next.reason,
          delivery_ids: params.delivery_ids,
        };
      },
    },
    cache,
    inboxAck: {
      markDelivered: ids => marked.push([...ids]),
    },
    callbacks: {
      // Match production wiring in `packages/backend/src/index.ts` so
      // multi-row drainPending batches collapse via the same byte-format
      // pipeline. Single-payload batches never hit this callback.
      combineGated: payloads => combineGatedBatch(payloads, 'silverhand message send'),
    },
  });
  return {
    coordinator,
    wakeCalls,
    marked,
    setWakeResponse: r => {
      next = r;
    },
  };
}

describe('DaemonAgentRuntimeHost — deliverMessage', () => {
  it('missing message → log warn + return; no inbox write, no coordinator call', async () => {
    const fix = makeDeliverFixture();
    try {
      const { coordinator, wakeCalls } = makeObservableCoordinator(new RunStateCache());
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, 'msg-does-not-exist');
      expect(wakeCalls).toEqual([]);
      // No inbox row created either — ensureDelivery requires a valid
      // message FK so we short-circuit before touching the inbox.
      const inboxCount =
        fix.db
          .prepare<[string, string], { c: number }>(
            'SELECT COUNT(*) AS c FROM conversation_inboxes WHERE conversation_id = ? AND agent_id = ?',
          )
          .get(fix.channelId, fix.agentId)?.c ?? 0;
      expect(inboxCount).toBe(0);
    } finally {
      fix.cleanup();
    }
  });

  it('already-delivered inbox row → log + return; no coordinator call', async () => {
    const fix = makeDeliverFixture();
    try {
      const msgId = fix.insertViewerMessage('hello');
      // Pre-create + mark delivered.
      const pre = fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgId);
      fix.inboxes.markDelivered([pre.inboxId]);

      const { coordinator, wakeCalls } = makeObservableCoordinator(new RunStateCache());
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);
      expect(wakeCalls).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('agent missing from agents table → log warn + return; row stays pending', async () => {
    const fix = makeDeliverFixture();
    try {
      const msgId = fix.insertViewerMessage('hello');
      const { coordinator, wakeCalls } = makeObservableCoordinator(new RunStateCache());
      const { host } = makeHost({}, fix.conversations, {
        // Stub agents to return null even though the real fix.agents
        // has the row — exercises the missing-agent branch directly.
        agents: { get: () => null } as unknown as AgentRepo,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);
      expect(wakeCalls).toEqual([]);
      // ensureDelivery DID run (idempotent insert) but the row is left
      // pending (no markDelivered).
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).toBeNull();
    } finally {
      fix.cleanup();
    }
  });

  it('no cache entry + non-oneShot driver → log + return; row stays pending', async () => {
    const fix = makeDeliverFixture(); // claude (non-oneShot)
    try {
      const msgId = fix.insertViewerMessage('hello');
      const cache = new RunStateCache();
      // No applyRuntimeStatus → no cache entry for (conv, agent).
      const { coordinator, wakeCalls } = makeObservableCoordinator(cache);
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);
      expect(wakeCalls).toEqual([]);
      // Row exists + still pending.
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).toBeNull();
    } finally {
      fix.cleanup();
    }
  });

  it('no cache entry + oneShot driver → calls start() (which still throws in 4b); error caught + logged; row stays pending', async () => {
    const fix = makeDeliverFixture({ agentRuntime: 'cursor' }); // oneShot
    try {
      const msgId = fix.insertViewerMessage('hello');
      const cache = new RunStateCache();
      const { coordinator, wakeCalls } = makeObservableCoordinator(cache);
      const errors: Array<{ obj: unknown; msg: string }> = [];
      const customLogger: BackendLogger = {
        ...noopLogger,
        error: (obj: unknown, msg: string) => errors.push({ obj, msg }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const client = makeFakeClient({});
      const bridge = new RuntimeBridge(client, { get: () => null });
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
      const host = new DaemonAgentRuntimeHost({
        client,
        bridge,
        cache,
        eventHandler,
        events: publisher,
        conversations: fix.conversations,
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        workspaces: noopWorkspaceRepo,
        placement: noopPlacement,
        membership: noopMembership,
        silverhandDir: '/tmp/silverhand-stub-dir',
        silverhandCli: noopSilverhandCli,
        agentTokens: noopAgentTokens,
        serverConfig: noopServerConfig,
        db: fix.db,
        logger: customLogger,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);
      // start() threw inside the .catch; error log captured.
      const startErrors = errors.filter(e => e.msg.includes('auto-start on deliverMessage failed'));
      expect(startErrors.length).toBe(1);
      // Coordinator NOT called (the oneShot path bypasses
      // submitLiveDelivery — respawn route exclusively).
      expect(wakeCalls).toEqual([]);
      // Row still pending.
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).toBeNull();
    } finally {
      fix.cleanup();
    }
  });

  it('cache entry exists, claude driver in ready phase → coordinator.submitLiveDelivery + bridge.runtimeWake; ack DEFERRED by B3 gate until session_init', async () => {
    const fix = makeDeliverFixture(); // claude (kickoffMode='requires_first_message')
    try {
      const msgId = fix.insertViewerMessage('@agent-deliver please look');
      const cache = new RunStateCache();
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
      const { coordinator, wakeCalls, marked, setWakeResponse } = makeObservableCoordinator(cache);
      setWakeResponse({ delivered: true });
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);

      // Coordinator dispatched one wake.
      expect(wakeCalls.length).toBe(1);
      expect(wakeCalls[0]!.conversationId).toBe(fix.channelId);
      expect(wakeCalls[0]!.agent_id).toBe(fix.agentId);
      // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): backend ships RAW text
      // (formatted via `formatLiveMessage`); daemon owns the
      // stream-json encode via its in-process driver. The shipped text
      // therefore contains the human-readable line, NOT a JSON envelope.
      const shipped = wakeCalls[0]!.text;
      expect(shipped).toContain('@agent-deliver please look');
      expect(() => JSON.parse(shipped)).toThrow(); // proves not pre-encoded
      // B3 (Cindy `usjxj8AxX4AvJ5E-`): claude is
      // `kickoffMode='requires_first_message'`. The first wake before
      // `session_init` must NOT mark delivered — the gate stashes the
      // ID into initPendingDeliveryIds and waits for the parsed
      // session_init to prove consumption.
      expect(marked).toEqual([]);
      // Now simulate the parsed session_init landing. The coordinator's
      // onParsedEvent fires markDelivered for the stashed IDs.
      const row = fix.db
        .prepare<[string], { delivered_at: number | null; id: number }>(
          'SELECT id, delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      coordinator.onParsedEvent(fix.channelId, fix.agentId, {
        kind: 'session_init',
        sessionId: 'sess-xyz-12345',
      });
      expect(marked.flat()).toEqual([row!.id]);
    } finally {
      fix.cleanup();
    }
  });

  it('cache entry exists, cursor driver returns null payload → log + return; coordinator NOT called', async () => {
    const fix = makeDeliverFixture({ agentRuntime: 'cursor' });
    try {
      const msgId = fix.insertViewerMessage('hello');
      const cache = new RunStateCache();
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
      const { coordinator, wakeCalls } = makeObservableCoordinator(cache);
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);
      // Cursor returns null from encodeStdinMessage → short-circuit.
      expect(wakeCalls).toEqual([]);
      // Row stays pending; the next runtime_exit will trigger an
      // auto-respawn whose startup_delivery drains it.
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).toBeNull();
    } finally {
      fix.cleanup();
    }
  });

  it('cache entry exists, wake refused → coordinator returns wake_refused; markDelivered NOT called', async () => {
    const fix = makeDeliverFixture();
    try {
      const msgId = fix.insertViewerMessage('hello');
      const cache = new RunStateCache();
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
      const { coordinator, wakeCalls, marked, setWakeResponse } = makeObservableCoordinator(cache);
      setWakeResponse({ delivered: false, reason: 'driver_refused' });
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
      });
      await host.deliverMessage(fix.channelId, fix.agentId, msgId);
      expect(wakeCalls.length).toBe(1);
      // markDelivered MUST NOT run on a refusal (Cindy
      // `0G5uJBydO_4qt_2r`).
      expect(marked).toEqual([]);
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).toBeNull();
    } finally {
      fix.cleanup();
    }
  });
});

// ── slice 4c: DaemonHost.start ─────────────────────────────────────
//
// `start()` orchestrates spawn intent: it builds the prompt context,
// writes spawn files, optionally composes startup_delivery (streamed)
// or initial_prompt (oneShot), and calls `bridge.runtimeStart`. The
// real spawn happens daemon-side; backend only wires the request and
// projects the response.
//
// Behavioral surface covered here:
//
//   1. Success arm — bridge returns {started:true, pid, started_at}.
//      DB row flips to `starting` + pid; SSE `agent_status` published.
//   2. init_cooldown arm — bridge returns {started:false,
//      reason:'init_cooldown', cooldown_until}. DB row flips to
//      `crashed` + null pid; SSE carries `reason:'init_cooldown'` +
//      `cooldown_until`. Mirrors CM `publishInitCooldown`.
//   3. Idempotency — cache shows live entry → no-op (no bridge call).
//   4. Streamed startup_delivery — inbox has rows; one stream-json
//      line composed + shipped as `startup_delivery`. markDelivered
//      NOT called here (daemon's runtime_startup_delivery_consumed
//      event is the async ack).
//   5. oneShot drain — cursor agent with inbox; initial_prompt
//      populated, NO startup_delivery, markDelivered IS called after
//      the success arm (daemon does not emit consumed event for the
//      argv-content path).
//   6. Transport throw — bridge throws → start() propagates the error;
//      DB row untouched.

interface StartFixture extends DeliverFixture {
  workspaces: WorkspaceRepo;
  membership: MembershipService;
  silverhandDir: string;
  silverhandCli: SilverhandCliLauncher;
  agentTokens: AgentTokenStore;
  serverConfig: () => ServerConfig;
}

function makeStartFixture(
  opts: {
    agentRuntime?: 'claude' | 'cursor';
  } = {},
): StartFixture {
  const base = makeDeliverFixture(opts);
  const workspaces = new WorkspaceRepo(base.db, {
    workspacesRoot: '/tmp/silverhand-stub-workspaces',
  });
  const membership = new MembershipService({
    agents: base.agents,
    users: base.users,
    conversations: base.conversations,
  });
  const tmp = makeTempSilverhandDir();
  // Extend cleanup so the silverhandDir temp folder is removed too.
  const compoundCleanup = (): void => {
    try {
      tmp.cleanup();
    } catch {
      // best-effort
    }
    base.cleanup();
  };
  return {
    ...base,
    cleanup: compoundCleanup,
    workspaces,
    membership,
    silverhandDir: tmp.silverhandDir,
    silverhandCli: noopSilverhandCli,
    agentTokens: new AgentTokenStore(),
    serverConfig: noopServerConfig,
  };
}

describe('DaemonAgentRuntimeHost — start', () => {
  it('success arm: {started:true} → DB row flips to starting + pid; SSE agent_status published', async () => {
    const fix = makeStartFixture();
    try {
      const cache = new RunStateCache();
      const startCalls: RuntimeStartParams[] = [];
      const { host, events } = makeHost(
        {
          runtimeStart: async params => {
            startCalls.push(params);
            return {
              started: true,
              pid: 42,
              started_at: 1700000000000,
            };
          },
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
        },
      );

      await host.start(fix.channelId, fix.agentId);

      // Bridge was called with the right shape.
      expect(startCalls.length).toBe(1);
      expect(startCalls[0]!.conversation_id).toBe(fix.channelId);
      expect(startCalls[0]!.agent_id).toBe(fix.agentId);
      // No inbox → no startup_delivery.
      expect(startCalls[0]!.startup_delivery).toBeUndefined();

      // DB row updated.
      const row = fix.db
        .prepare<[string, string], { status: string; pid: number | null }>(
          'SELECT status, pid FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?',
        )
        .get(fix.channelId, fix.agentId);
      expect(row?.status).toBe('starting');
      expect(row?.pid).toBe(42);

      // SSE agent_status emitted.
      const statusEvents = events.publishes.filter(p => p.kind === 'agent_status');
      expect(statusEvents.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = statusEvents[0]!.payload as any;
      expect(payload.agent_id).toBe(fix.agentId);
      expect(payload.status).toBe('starting');
      expect(payload.pid).toBe(42);
    } finally {
      fix.cleanup();
    }
  });

  it('init_cooldown arm: {started:false} → DB flips to crashed; SSE carries reason + cooldown_until', async () => {
    const fix = makeStartFixture();
    try {
      const cache = new RunStateCache();
      const cooldownUntil = Date.now() + 5 * 60 * 1000;
      const { host, events } = makeHost(
        {
          runtimeStart: async () => ({
            started: false,
            reason: 'init_cooldown',
            cooldown_until: cooldownUntil,
          }),
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
        },
      );

      await host.start(fix.channelId, fix.agentId);

      // DB row → crashed + null pid.
      const row = fix.db
        .prepare<[string, string], { status: string; pid: number | null }>(
          'SELECT status, pid FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?',
        )
        .get(fix.channelId, fix.agentId);
      expect(row?.status).toBe('crashed');
      expect(row?.pid).toBeNull();

      // SSE.
      const statusEvents = events.publishes.filter(p => p.kind === 'agent_status');
      expect(statusEvents.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = statusEvents[0]!.payload as any;
      expect(payload.status).toBe('crashed');
      expect(payload.reason).toBe('init_cooldown');
      expect(payload.cooldown_until).toBe(cooldownUntil);
    } finally {
      fix.cleanup();
    }
  });

  it('idempotent: cache has live entry → no-op; bridge NOT called', async () => {
    const fix = makeStartFixture();
    try {
      const cache = new RunStateCache();
      cache.applyRuntimeStatus(DAEMON_KEY, [
        {
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          pid: 99,
          phase: 'ready',
          run_state: null,
          started_at: 1700000000000,
        },
      ]);
      let called = 0;
      const { host } = makeHost(
        {
          runtimeStart: async () => {
            called += 1;
            return { started: true, pid: 99, started_at: 1700000000000 };
          },
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
        },
      );
      await host.start(fix.channelId, fix.agentId);
      expect(called).toBe(0);
    } finally {
      fix.cleanup();
    }
  });

  it('streamed driver with pending inbox → startup_delivery composed; markDelivered NOT called by start', async () => {
    const fix = makeStartFixture(); // claude (streamed)
    try {
      const cache = new RunStateCache();
      // Seed pending inbox row.
      const msgId = fix.insertViewerMessage('@agent-deliver please look');
      const delivery = fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgId);

      const startCalls: RuntimeStartParams[] = [];
      const { host } = makeHost(
        {
          runtimeStart: async params => {
            startCalls.push(params);
            return {
              started: true,
              pid: 42,
              started_at: 1700000000000,
              startup_delivery_accepted: true,
            };
          },
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
        },
      );

      await host.start(fix.channelId, fix.agentId);

      expect(startCalls.length).toBe(1);
      const sd = startCalls[0]!.startup_delivery;
      expect(sd).toBeDefined();
      expect(sd!.delivery_ids).toEqual([delivery.inboxId]);
      // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): backend ships unencoded
      // text; daemon encodes via its in-process driver. So we assert
      // the text contains the human-readable mention, not a stream-json
      // shape — the encode step happens daemon-side.
      expect(sd!.text).toContain('@agent-deliver please look');

      // start() MUST NOT mark delivered for streamed drivers — that's
      // the daemon's `runtime_startup_delivery_consumed` ack route.
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).toBeNull();
    } finally {
      fix.cleanup();
    }
  });

  it('oneShot driver with pending inbox → initial_prompt populated; rows marked delivered after success', async () => {
    const fix = makeStartFixture({ agentRuntime: 'cursor' });
    try {
      const cache = new RunStateCache();
      const msgId = fix.insertViewerMessage('hello cursor');
      fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgId);

      const startCalls: RuntimeStartParams[] = [];
      const { host } = makeHost(
        {
          runtimeStart: async params => {
            startCalls.push(params);
            return {
              started: true,
              pid: 7,
              started_at: 1700000000000,
            };
          },
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
        },
      );

      await host.start(fix.channelId, fix.agentId);

      expect(startCalls.length).toBe(1);
      // oneShot: NO startup_delivery; initial_prompt has the text.
      expect(startCalls[0]!.startup_delivery).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = startCalls[0]!.options as any;
      expect(typeof options.initial_prompt).toBe('string');
      expect(options.initial_prompt).toContain('hello cursor');

      // oneShot: markDelivered IS called (daemon has no async ack
      // route for argv-content drains).
      const row = fix.db
        .prepare<[string], { delivered_at: number | null }>(
          'SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?',
        )
        .get(msgId);
      expect(row?.delivered_at).not.toBeNull();
    } finally {
      fix.cleanup();
    }
  });

  it('bridge transport error → start() rejects; DB row untouched', async () => {
    const fix = makeStartFixture();
    try {
      const cache = new RunStateCache();
      const { host } = makeHost(
        {
          runtimeStart: () => {
            throw new Error('daemon disconnected');
          },
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
        },
      );
      let err: unknown;
      await host.start(fix.channelId, fix.agentId).catch(e => {
        err = e;
      });
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('daemon disconnected');

      // DB row was never flipped to starting/crashed.
      const row = fix.db
        .prepare<[string, string], { status: string }>(
          'SELECT status FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?',
        )
        .get(fix.channelId, fix.agentId);
      // Initial status after addAgent — anything other than starting/crashed
      // means we never wrote a partial state.
      expect(row?.status).not.toBe('starting');
      expect(row?.status).not.toBe('crashed');
    } finally {
      fix.cleanup();
    }
  });

  it('B5: bridge receives env === applyProxyEnv(buildBridgeBaseEnv(...)) — DaemonHost MUST NOT call buildAgentSpawnEnv', async () => {
    // The wire-level invariant: backend ships `buildBridgeBaseEnv`
    // (driver.applyEnv + SILVERHAND_* + bin shim, NO proxy) as
    // `RuntimeStartInput.baseEnv`; the bridge layers `applyProxyEnv`
    // on top per the allowlist. DaemonHost calling `buildAgentSpawnEnv`
    // would either double-overlay proxy (already in baseEnv + bridge
    // re-adds) or bypass the bridge's single-point proxy boundary —
    // both break the spawn-env contract from commit 5 unit 1.
    const fix = makeStartFixture(); // claude — proxy_runtimes includes claude
    try {
      const cache = new RunStateCache();
      const startCalls: RuntimeStartParams[] = [];
      const { host } = makeHost(
        {
          runtimeStart: async params => {
            startCalls.push(params);
            return {
              started: true,
              pid: 1,
              started_at: 1700000000000,
            };
          },
        },
        fix.conversations,
        {
          agents: fix.agents,
          messages: fix.messages,
          inboxes: fix.inboxes,
          users: fix.users,
          settings: fix.settings,
          workspaces: fix.workspaces,
          membership: fix.membership,
          silverhandDir: fix.silverhandDir,
          silverhandCli: fix.silverhandCli,
          agentTokens: fix.agentTokens,
          serverConfig: fix.serverConfig,
          cache,
          db: fix.db,
          // B5 deterministic env: production inherits `process.env` so
          // the parent's HTTP_PROXY etc. propagate (shiki invariant —
          // codex needs proxy export). The test pins a `{}` baseProcessEnv
          // seam so the wire-env assertion below is independent of the
          // developer's shell (Cindy `nKFVSvx4CyBLxPNq` blocker 1).
          baseProcessEnv: {},
        },
      );
      await host.start(fix.channelId, fix.agentId);
      expect(startCalls.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wireEnv = (startCalls[0]!.options as any).env as NodeJS.ProcessEnv;

      // Required SILVERHAND_* vars from buildBridgeBaseEnv → present.
      expect(wireEnv.SILVERHAND_CONVERSATION_ID).toBe(fix.channelId);
      expect(wireEnv.SILVERHAND_AGENT_ID).toBe(fix.agentId);
      // bin shim prepended to PATH.
      expect(wireEnv.PATH?.split(':')[0]).toMatch(/spawn-.+\/bin$/);
      // No proxy settings configured in fixture + deterministic empty
      // baseProcessEnv → bridge's applyProxyEnv is identity, so no
      // HTTP_PROXY / HTTPS_PROXY surfaces.
      expect(wireEnv.HTTP_PROXY).toBeUndefined();
      expect(wireEnv.HTTPS_PROXY).toBeUndefined();
      expect(wireEnv.http_proxy).toBeUndefined();
      expect(wireEnv.https_proxy).toBeUndefined();
    } finally {
      fix.cleanup();
    }
  });
});

// ── drainPending ────────────────────────────────────────────────────
//
// B2 (Cindy `usjxj8AxX4AvJ5E-`): EventHandler routes
// `runtime_ready_for_drain` to `DaemonHost.drainPending(conv, agent)`,
// which collapses every pending inbox row into a single batch handed
// to `coordinator.submitLiveDeliveryBatch`. That call issues ONE
// `runtime_wake` carrying every `delivery_id`, with all-or-nothing
// ack semantics (Cindy `nKFVSvx4CyBLxPNq` blocker 2). Per-row
// `deliverMessage` looping is forbidden — it would change claude's
// visible turn boundary and degrade ack into partial success.
//
// Tests pin:
//   1. listPending empty → noop log, coordinator not called
//   2. one pending row + cache phase=ready + claude → coordinator.wake
//      with the right payload + delivered_at set (B3 gate defers ack)
//   3. multiple pending rows → ONE wake carrying all delivery_ids in a
//      combined payload (batch-native)
//   4. all-or-nothing ack: bridge throw → NO rows acked, every row
//      stays pending for the next ready_for_drain replay

describe('DaemonAgentRuntimeHost — drainPending', () => {
  it('listPending empty → noop, coordinator not called', async () => {
    const fix = makeDeliverFixture();
    try {
      const cache = new RunStateCache();
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
      const { coordinator, wakeCalls } = makeObservableCoordinator(cache);
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
      });
      await host.drainPending(fix.channelId, fix.agentId);
      expect(wakeCalls).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('one pending row + cache phase=ready → coordinator wakes; ack DEFERRED by B3 gate (claude)', async () => {
    const fix = makeDeliverFixture();
    try {
      // Viewer user `local` is pre-seeded by openTestDb fixture; no
      // need to upsert. formatLiveMessage resolves the sender handle
      // via SettingsRepo.getViewerUserId + UserRepo.get.
      const msgId = fix.insertViewerMessage('@agent-deliver pls drain');
      fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgId);

      const cache = new RunStateCache();
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
      const { coordinator, wakeCalls, marked } = makeObservableCoordinator(cache);
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
      });
      await host.drainPending(fix.channelId, fix.agentId);

      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0]!.conversationId).toBe(fix.channelId);
      expect(wakeCalls[0]!.agent_id).toBe(fix.agentId);
      // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): backend ships RAW
      // combined text built by `formatInboxBatch` — the daemon owns
      // the stream-json encode via its in-process driver. Single-row
      // drainPending still wraps via the inbox-drain wrapper ("You
      // have one message waiting since you were last active:"), but
      // there is no surrounding JSON envelope on the wire.
      const shipped = wakeCalls[0]!.text;
      expect(() => JSON.parse(shipped)).toThrow(); // proves not pre-encoded
      expect(shipped).toContain('You have one message waiting');
      expect(shipped).toContain('@agent-deliver pls drain');

      // B3 (Cindy `usjxj8AxX4AvJ5E-`): drainPending fires for the
      // `requires_first_message` claude driver. The wake's
      // `delivered:true` is NOT immediately acked — gate holds it
      // until parsed session_init. This is the very point of B3 —
      // empty-inbox claude that crossed startup_pending → ready
      // doesn't yet have a parsed `system.init`, and acking the wake
      // on bytes-on-stdin alone would lose the message if the child
      // dies before parsing.
      expect(marked).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('multiple pending rows → ONE wake carrying all delivery_ids in a valid stream-json line (batch-native + combine-before-encode)', async () => {
    // Cindy `nKFVSvx4CyBLxPNq` blocker 2 + `Mqf1h-FKudtEbH1O`:
    // `runtime_ready_for_drain` is a batch primitive — N pending rows
    // must collapse into ONE `runtime_wake` call with ALL `delivery_ids`
    // in a single legal claude stream-json line. Combine MUST happen
    // before driver.encode (feeding driver-encoded JSON lines into
    // combineGatedBatch would produce a malformed payload that claude
    // sees as non-stream-json text).
    const fix = makeDeliverFixture();
    try {
      const msgA = fix.insertViewerMessage('first');
      const msgB = fix.insertViewerMessage('second');
      const msgC = fix.insertViewerMessage('third');
      const dA = fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgA);
      const dB = fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgB);
      const dC = fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgC);

      const cache = new RunStateCache();
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
      const { coordinator, wakeCalls, marked } = makeObservableCoordinator(cache);
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
      });
      await host.drainPending(fix.channelId, fix.agentId);

      // Exactly ONE wake — every pending row in a single payload.
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0]!.delivery_ids).toEqual([dA.inboxId, dB.inboxId, dC.inboxId]);
      // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): payload is RAW combined
      // text built by `formatInboxBatch` (inbox-drain wrapper), NOT a
      // pre-encoded stream-json line. Daemon owns the encode via its
      // in-process driver. Pre-Option-A-v2 this was a stream-json JSON
      // envelope; under Option A v2 it is the literal "You have N
      // messages waiting…" line containing each row verbatim. Combine
      // BEFORE encode is preserved because there IS no backend encode
      // step at all — daemon receives one combined text per batch.
      const shipped = wakeCalls[0]!.text;
      expect(() => JSON.parse(shipped)).toThrow(); // proves not pre-encoded
      expect(shipped).toContain('You have 3 messages waiting since you were last active');
      expect(shipped).toContain('first');
      expect(shipped).toContain('second');
      expect(shipped).toContain('third');
      // No nested `{"type":"user"` — pre-Mqf1h-FKudtEbH1O bug embedded
      // per-row encoded payloads as text; under Option A v2 there are
      // no per-row encodes anywhere.
      expect(shipped).not.toContain('"type":"user"');

      // B3 gate still applies — claude is `requires_first_message`, so
      // the batch's delivered:true does NOT immediately ack; the entire
      // batch stays stashed until session_init lands.
      expect(marked).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('all-or-nothing ack: bridge throw → NO rows acked, entire batch stays pending', async () => {
    // Cindy `nKFVSvx4CyBLxPNq` blocker 2: failure semantics for a
    // batch wake must be all-or-nothing — if the single
    // `runtime_wake` throws (or returns delivered:false), every row
    // in the batch stays pending. There must be NO partial markDelivered.
    const fix = makeDeliverFixture();
    try {
      const msgA = fix.insertViewerMessage('A');
      const msgB = fix.insertViewerMessage('B');
      fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgA);
      fix.inboxes.ensureDelivery(fix.channelId, fix.agentId, msgB);

      const cache = new RunStateCache();
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
      // Coordinator whose wake always throws — simulate transport blip.
      let wakeAttempts = 0;
      const marked: number[][] = [];
      const coordinator = new RuntimeDeliveryCoordinator({
        bridge: {
          runtimeWake: async () => {
            wakeAttempts += 1;
            throw new Error('simulated transport blip');
          },
        },
        cache,
        inboxAck: {
          markDelivered: ids => marked.push([...ids]),
        },
        callbacks: {
          combineGated: payloads => combineGatedBatch(payloads, 'silverhand message send'),
        },
      });
      const warns: Array<{ meta: unknown; msg: string }> = [];
      const customLogger: BackendLogger = {
        ...noopLogger,
        warn: (meta, msg) => warns.push({ meta, msg: msg ?? '' }),
      };
      const { host } = makeHost({}, fix.conversations, {
        agents: fix.agents,
        messages: fix.messages,
        inboxes: fix.inboxes,
        users: fix.users,
        settings: fix.settings,
        coordinator,
        cache,
        db: fix.db,
        logger: customLogger,
      });
      await host.drainPending(fix.channelId, fix.agentId);

      // Exactly ONE wake attempted (not per-row) and it threw.
      expect(wakeAttempts).toBe(1);
      // No rows acked — batch failure is all-or-nothing.
      expect(marked).toEqual([]);
      // drainPending swallowed the throw + logged warn for the batch.
      const drainWarns = warns.filter(w => w.msg.includes('drain: coordinator inbox-batch threw'));
      expect(drainWarns.length).toBe(1);
      // Inbox rows still pending — next ready_for_drain replays them.
      expect(fix.inboxes.listPending(fix.channelId, fix.agentId)).toHaveLength(2);
    } finally {
      fix.cleanup();
    }
  });
});
