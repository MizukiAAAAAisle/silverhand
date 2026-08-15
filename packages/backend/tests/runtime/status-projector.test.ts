/**
 * Tests for `DbRuntimeStatusProjector` — the narrow sink that owns
 * both the DB write to the runtime-slot authority AND the matching
 * `agent_status` SSE for status-mutating runtime events.
 *
 * Cindy `usjxj8AxX4AvJ5E-` B1 pin:
 *   - status mapping lives HERE, not in EventHandler
 *   - tests verify "this combination of inputs produces exactly this
 *     DB row + exactly this SSE payload" without involving an event
 *     handler at all
 *
 * Each test exercises the full DB+SSE pair so a future refactor that
 * moves the status mapping back into the handler would have to delete
 * an assertion to pass.
 */
import { fixedConversationTitle } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import {
  DbRuntimeStatusProjector,
  type RuntimeStatusPayload,
} from '../../src/runtime/status-projector.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { openTestDb, makeTempSilverhandDir } from '../utils/db.js';
import type { AgentRunState } from '@silverhand/shared';

interface Fixture {
  conversations: ConversationRepo;
  channelId: string;
  agentId: string;
  events: Array<{ conv: string; kind: string; payload: unknown }>;
  publisher: EventPublisher;
  projector: DbRuntimeStatusProjector;
  custody: { generation: number; daemonInstanceId: string };
  cleanup: () => void;
  /** Current joined membership + runtime-slot projection for the seeded pair. */
  row(): { status: string; pid: number | null; cli_session_id: string | null };
}

function fixtureScope(fix: Fixture) {
  return {
    kind: 'conversation' as const,
    conversationId: fix.channelId,
    agentId: fix.agentId,
  };
}

function makeFixture(
  opts: { initialCliSessionId?: string | null; initialStatus?: 'starting' | 'active' | 'idle' | 'crashed' } = {},
): Fixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const { workspacesRoot, cleanup } = makeTempSilverhandDir();
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const runtimeSlots = new RuntimeSlotRepo(db);

  const ws = workspaces.insert({
    name: 'ws-proj',
    description: null,
  });
  const agent = agents.create(
    { name: 'agent-proj', runtime: 'claude', host_id: localHostId },
    localHostId,
    viewerUserId,
  );
  const channel = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('ws-proj'),
    spawnedByAgentId: null,
  });
  conversations.addAgent(channel.id, agent.id);
  if (opts.initialStatus || opts.initialCliSessionId !== undefined) {
    runtimeSlots.updateCurrentConversationProjection(channel.id, agent.id, {
      ...(opts.initialStatus ? { status: opts.initialStatus } : {}),
      ...(opts.initialCliSessionId !== undefined
        ? { cliSessionId: opts.initialCliSessionId }
        : {}),
    });
  }

  const events: Array<{ conv: string; kind: string; payload: unknown }> = [];
  const publisher: EventPublisher = {
    publish: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
    // Stage-2 P2: status projections now route to the side-channel scope.
    // Capture both so behavioral assertions are indifferent to the channel;
    // scope-routing itself is locked in scope-event-bus / ws-server tests.
    publishSide: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
  };
  const projector = new DbRuntimeStatusProjector(runtimeSlots, publisher, {
    listProjectionConversationIds: () => [channel.id],
  });
  const daemonInstanceId = 'daemon-projector-test';
  const claimed = runtimeSlots.claimGeneration({
    scope: { kind: 'conversation', conversationId: channel.id, agentId: agent.id },
    daemonInstanceId,
    status: opts.initialStatus ?? 'starting',
  });
  if (!claimed) throw new Error('runtime slot claim failed');

  return {
    conversations,
    channelId: channel.id,
    agentId: agent.id,
    events,
    publisher,
    projector,
    custody: { generation: claimed.generation, daemonInstanceId },
    cleanup,
    row: () => {
      const r = runtimeSlots.getConversation(channel.id, agent.id);
      if (!r) throw new Error('runtime slot row missing');
      return {
        status: r.observed_status,
        pid: r.observed_pid,
        cli_session_id: r.cli_session_id,
      };
    },
  };
}

describe('DbRuntimeStatusProjector — wire identity boundary', () => {
  it('rejects payload-owned agent_id statically and overwrites a cast spoof at runtime', () => {
    const fix = makeFixture();
    try {
      const spoofed: RuntimeStatusPayload = {
        status: 'active',
        // @ts-expect-error `agent_id` is projector-owned, never caller-owned.
        agent_id: 'spoofed-agent',
      };
      fix.projector.publishStatus({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        payload: spoofed,
      });
      expect(fix.events[0]?.payload).toMatchObject({
        agent_id: fix.agentId,
        status: 'active',
      });
    } finally {
      fix.cleanup();
    }
  });
});

describe('DbRuntimeStatusProjector — sessionInit', () => {
  it('writes status=active + cli_session_id, publishes agent_status', () => {
    const fix = makeFixture({ initialStatus: 'starting' });
    try {
      fix.projector.sessionInit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        cliSessionId: 'sess-cafe-1234',
      });
      expect(fix.row()).toEqual({
        status: 'active',
        pid: null,
        cli_session_id: 'sess-cafe-1234',
      });
      expect(fix.events).toHaveLength(1);
      expect(fix.events[0]).toMatchObject({
        conv: fix.channelId,
        kind: 'agent_status',
        payload: {
          agent_id: fix.agentId,
          status: 'active',
          cli_session_id: 'sess-cafe-1234',
        },
      });
    } finally {
      fix.cleanup();
    }
  });

  it('is idempotent — claude system.init per-turn re-arrival writes same row + republishes', () => {
    // Cindy `usjxj8AxX4AvJ5E-` B1 docstring: `system.init` is per-turn,
    // not per-process. The projector deliberately does NOT dedup —
    // dedup of non-idempotent side effects (init-pending inbox, drain)
    // is the coordinator's job (B3).
    const fix = makeFixture({ initialStatus: 'starting' });
    try {
      fix.projector.sessionInit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        cliSessionId: 'sess-cafe-1234',
      });
      fix.projector.sessionInit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        cliSessionId: 'sess-cafe-1234',
      });
      expect(fix.row().status).toBe('active');
      expect(fix.events).toHaveLength(2);
    } finally {
      fix.cleanup();
    }
  });
});

describe('DbRuntimeStatusProjector — runtimeReady', () => {
  it('writes status=active without touching cli_session_id, publishes agent_status', () => {
    const fix = makeFixture({ initialStatus: 'starting', initialCliSessionId: 'sess-existing' });
    try {
      fix.projector.runtimeReady({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
      });
      expect(fix.row()).toEqual({
        status: 'active',
        pid: null,
        cli_session_id: 'sess-existing',
      });
      expect(fix.events).toHaveLength(1);
      expect(fix.events[0]).toMatchObject({
        conv: fix.channelId,
        kind: 'agent_status',
        payload: {
          agent_id: fix.agentId,
          status: 'active',
        },
      });
      expect(fix.events[0]!.payload).not.toHaveProperty('cli_session_id');
    } finally {
      fix.cleanup();
    }
  });
});

describe('DbRuntimeStatusProjector — runtimeExit', () => {
  const baseRunState: AgentRunState = {
    runId: 'r1',
    agentId: 'a1',
    conversationId: 'c1',
    status: 'thinking',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    lastActivityAt: 1700000000000,
  };

  it('intentional + code 0 → status=idle', () => {
    const fix = makeFixture({ initialStatus: 'active' });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: true,
        code: 0,
        initTimedOut: false,
        fatalError: false,
        runState: null,
      });
      expect(fix.row()).toMatchObject({ status: 'idle', pid: null });
      expect(fix.events[0]!.payload).toMatchObject({
        status: 'idle',
        exit_code: 0,
        intentional: true,
        run_state: null,
      });
    } finally {
      fix.cleanup();
    }
  });

  it('intentional=false + non-zero code → status=crashed', () => {
    const fix = makeFixture({ initialStatus: 'active' });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: false,
        code: 137,
        initTimedOut: false,
        fatalError: false,
        runState: null,
      });
      expect(fix.row().status).toBe('crashed');
      expect(fix.events[0]!.payload).toMatchObject({
        status: 'crashed',
        exit_code: 137,
        intentional: false,
      });
    } finally {
      fix.cleanup();
    }
  });

  it('intentional=false + code=0 → status=idle (normal session end)', () => {
    const fix = makeFixture({ initialStatus: 'active' });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: false,
        code: 0,
        initTimedOut: false,
        fatalError: false,
        runState: null,
      });
      expect(fix.row().status).toBe('idle');
    } finally {
      fix.cleanup();
    }
  });

  it('initTimedOut=true overrides intentional/code=0 → crashed', () => {
    // Cindy `rrF2L1RmWq5JFH3m` B2: a process that timed-out init but
    // exited with code 0 must still surface as crashed.
    const fix = makeFixture({ initialStatus: 'starting' });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: false,
        code: 0,
        initTimedOut: true,
        fatalError: false,
        runState: null,
      });
      expect(fix.row().status).toBe('crashed');
      expect(fix.events[0]!.payload).toMatchObject({ status: 'crashed' });
    } finally {
      fix.cleanup();
    }
  });

  it('fatalError=true overrides intentional → crashed', () => {
    const fix = makeFixture({ initialStatus: 'active' });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: true,
        code: 0,
        initTimedOut: false,
        fatalError: true,
        runState: null,
      });
      expect(fix.row().status).toBe('crashed');
    } finally {
      fix.cleanup();
    }
  });

  it('does NOT clear cli_session_id (keeps it for --resume on next start)', () => {
    const fix = makeFixture({
      initialStatus: 'active',
      initialCliSessionId: 'sess-keepme-9999',
    });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: true,
        code: 0,
        initTimedOut: false,
        fatalError: false,
        runState: null,
      });
      expect(fix.row().cli_session_id).toBe('sess-keepme-9999');
    } finally {
      fix.cleanup();
    }
  });

  it('clears cli_session_id when the exit is tied to a stale resume target', () => {
    const fix = makeFixture({
      initialStatus: 'active',
      initialCliSessionId: 'sess-archived-1234',
    });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: false,
        code: 1,
        initTimedOut: false,
        fatalError: true,
        clearCliSessionId: true,
        runState: null,
      });
      expect(fix.row().status).toBe('crashed');
      expect(fix.row().cli_session_id).toBeNull();
      expect(fix.events[0]).toMatchObject({
        conv: fix.channelId,
        kind: 'agent_status',
        payload: {
          agent_id: fix.agentId,
          status: 'crashed',
          cli_session_id: null,
        },
      });
    } finally {
      fix.cleanup();
    }
  });

  it('forwards runState through to the SSE payload', () => {
    const fix = makeFixture({ initialStatus: 'active' });
    try {
      fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: true,
        code: 0,
        initTimedOut: false,
        fatalError: false,
        runState: baseRunState,
      });
      expect((fix.events[0]!.payload as { run_state: AgentRunState | null }).run_state)
        .toEqual(baseRunState);
    } finally {
      fix.cleanup();
    }
  });

  it('finalize is terminal: delayed projections and duplicate exits emit nothing and cannot revive the slot', () => {
    const fix = makeFixture({ initialStatus: 'active' });
    try {
      const finalized = fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: true,
        code: 0,
        initTimedOut: false,
        fatalError: false,
        runState: null,
      });
      expect(finalized).not.toBeNull();
      expect(fix.events).toHaveLength(1);

      fix.projector.sessionInit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        cliSessionId: 'late-session',
      });
      const duplicate = fix.projector.runtimeExit({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        intentional: false,
        code: 1,
        initTimedOut: false,
        fatalError: false,
        runState: null,
      });
      expect(duplicate).toBeNull();
      expect(fix.events).toHaveLength(1);
      expect(fix.row()).toEqual({
        status: 'idle',
        pid: null,
        cli_session_id: null,
      });
    } finally {
      fix.cleanup();
    }
  });
});

describe('DbRuntimeStatusProjector — initRetrying', () => {
  it('writes status=starting + pid=null, publishes agent_status starting reason=init_timeout_retrying', () => {
    const fix = makeFixture({ initialStatus: 'starting' });
    try {
      fix.projector.initRetrying({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        retryAttempt: 2,
        maxRetries: 3,
        timeoutReason: 'silence',
      });
      expect(fix.row()).toMatchObject({ status: 'starting', pid: null });
      expect(fix.events[0]!.payload).toMatchObject({
        agent_id: fix.agentId,
        status: 'starting',
        reason: 'init_timeout_retrying',
        retry_attempt: 2,
        max_retries: 3,
        timeout_reason: 'silence',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('omits timeout_reason field when undefined (no key in payload)', () => {
    const fix = makeFixture({ initialStatus: 'starting' });
    try {
      fix.projector.initRetrying({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        retryAttempt: 1,
        maxRetries: 3,
        timeoutReason: undefined,
      });
      const payload = fix.events[0]!.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty('timeout_reason');
    } finally {
      fix.cleanup();
    }
  });
});

describe('DbRuntimeStatusProjector — initCooldown', () => {
  it('writes status=crashed + pid=null, publishes agent_status crashed reason=init_cooldown', () => {
    const fix = makeFixture({ initialStatus: 'starting' });
    try {
      fix.projector.initCooldown({
        scope: fixtureScope(fix),
        conversationId: fix.channelId,
        agentId: fix.agentId,
        custody: fix.custody,
        cooldownUntil: 1700000999000,
        attemptsExhausted: 3,
      });
      expect(fix.row()).toMatchObject({ status: 'crashed', pid: null });
      expect(fix.events[0]!.payload).toMatchObject({
        agent_id: fix.agentId,
        status: 'crashed',
        reason: 'init_cooldown',
        cooldown_until: 1700000999000,
        attempts_exhausted: 3,
      });
    } finally {
      fix.cleanup();
    }
  });
});
