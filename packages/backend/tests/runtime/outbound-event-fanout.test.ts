import { testWorkspacePath } from '../utils/db.js';
import { describe, expect, it, vi } from 'vitest';
import {
  EventFrameSchema,
  KNOWN_CAPABILITIES_V1,
  OUTBOUND_DAEMON_EVENT_KINDS,
  type EventFrame,
  type OutboundDaemonEventKind,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type RuntimeStatusResult,
} from '@silverhand/host';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import type { AgentRunState, RuntimeKind } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationEventRepo } from '../../src/repos/conversation-event-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import { RuntimeEventHandler, type EventPublisher } from '../../src/runtime/event-handler.js';
import {
  ClearSessionExitTimeoutError,
  ClearSessionInProgressError,
} from '../../src/runtime/agent-runtime-host.js';
import {
  OutboundRuntimeEventFanout,
  outboundEventToEventFrame,
} from '../../src/runtime/outbound-event-fanout.js';
import { AgentL2SeedEnsurer } from '../../src/runtime/agent-l2-seed-ensurer.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { DbRuntimeStatusProjector } from '../../src/runtime/status-projector.js';
import type {
  HostWsAttachment,
  HostWsServerController,
} from '../../src/ws/host-ws-server.js';
import { openTestDb } from '../utils/db.js';

describe('OutboundRuntimeEventFanout', () => {
  it('keeps outbound event projection in lockstep with EventFrameSchema', () => {
    for (const kind of OUTBOUND_DAEMON_EVENT_KINDS) {
      const projected = outboundEventToEventFrame(outboundEventFixture(kind));
      expect(EventFrameSchema.safeParse(projected).success, kind).toBe(true);
    }
  });

  it('projects outbound daemon events through the same SSE and DB path as the unix-socket handler', () => {
    const unix = makeFixture();
    const outbound = makeFixture();
    try {
      const event: EventFrame = {
        event: 'runtime_parsed_event',
        conversation_id: unix.channelId,
        agent_id: unix.agentId,
        parsed: { kind: 'session_init', sessionId: 'sess-1' },
        ts: 1700000000000,
      };
      makeUnixHandler(unix).dispatch(event);

      outbound.fanout.onEvent(outbound.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_parsed_event',
        conversation_id: outbound.channelId,
        agent_id: outbound.agentId,
        parsed: { kind: 'session_init', sessionId: 'sess-1' },
        ts: 1700000000000,
      }, 'conn-1');

      expect(normalizeEvents(outbound.events, outbound)).toEqual(
        normalizeEvents(unix.events, unix),
      );
      expect(outbound.row()).toEqual(unix.row());
    } finally {
      unix.cleanup();
      outbound.cleanup();
    }
  });

  it('marks delivery consumed rows delivered from outbound events', () => {
    const fix = makeFixture();
    try {
      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'deliver me',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      fix.fanout.onEvent(fix.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_delivery_consumed',
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        delivery_ids: [delivery.inboxId],
        ts: 1700000000000,
      }, 'conn-1');

      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('leaves delivery failed rows pending for backend retry policy', () => {
    const fix = makeFixture();
    try {
      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'retry me',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      fix.fanout.onEvent(fix.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_delivery_failed',
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        delivery_ids: [delivery.inboxId],
        reason: 'write_failed',
        ts: 1700000000000,
      }, 'conn-1');

      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toMatchObject([
        { inboxId: delivery.inboxId },
      ]);
    } finally {
      fix.cleanup();
    }
  });

  it('keeps inbox custody pending and blocks spawn while the agent switches runtime', async () => {
    const fix = makeFixture({ runtime: 'claude' });
    try {
      expect(
        new AgentRepo(fix.db).beginRuntimeTransition(fix.agentId, 'codex'),
      ).toBe('started');
      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'wait for the target runtime',
      });

      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);
      await fix.fanout.start(fix.channelId, fix.agentId);

      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toHaveLength(1);
      expect(
        fix.transport.calls.filter(
          call => call.kind === 'runtime_deliver' || call.kind === 'runtime_start',
        ),
      ).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  // #task:1486 SEND-gate: a non-baseline reasoning token may only be dispatched
  // to a daemon that advertised `runtime.codex.reasoning.v1` on its live
  // connection; an old daemon (no capability) must be protected from receiving
  // a token its strict enum would reject.
  describe('#1486 reasoning-effort send gate', () => {
    function codexUltraFixture() {
      const fix = makeFixture({ runtime: 'codex' });
      // Persist a product-valid non-baseline combo (ultra only on sol).
      new AgentRepo(fix.db).update(fix.agentId, {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'ultra',
      });
      return fix;
    }

    it('blocks dispatch when the live daemon lacks the capability (old daemon)', async () => {
      const fix = codexUltraFixture();
      fix.transport.attachmentCapabilities = []; // attached, but no capability
      try {
        await expect(
          fix.fanout.start(fix.channelId, fix.agentId),
        ).rejects.toThrow(/runtime\.codex\.reasoning\.v1/);
        // Nothing was dispatched — the throw is BEFORE the wire.
        expect(
          fix.transport.calls.filter(c => c.kind === 'runtime_start'),
        ).toEqual([]);
      } finally {
        fix.cleanup();
      }
    });

    it('allows dispatch when the live daemon advertises the capability', async () => {
      const fix = codexUltraFixture();
      fix.transport.attachmentCapabilities = ['runtime.codex.reasoning.v1'];
      try {
        await fix.fanout.start(fix.channelId, fix.agentId);
        expect(
          fix.transport.calls.filter(c => c.kind === 'runtime_start'),
        ).toHaveLength(1);
      } finally {
        fix.cleanup();
      }
    });

    it('never blocks a baseline effort even without the capability', async () => {
      const fix = makeFixture({ runtime: 'codex' });
      new AgentRepo(fix.db).update(fix.agentId, {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
      });
      fix.transport.attachmentCapabilities = [];
      try {
        await fix.fanout.start(fix.channelId, fix.agentId);
        expect(
          fix.transport.calls.filter(c => c.kind === 'runtime_start'),
        ).toHaveLength(1);
      } finally {
        fix.cleanup();
      }
    });
  });

  it('rehydrates from runtime_status on fresh ready after disconnect even for the same daemon pid', async () => {
    const fix = makeFixture();
    try {
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'thinking',
          }),
        ],
      };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.fanout.getAgentRunStates(fix.channelId).length === 1);
      expect(fix.fanout.getAgentRunStates(fix.channelId)[0]).toMatchObject({
        status: 'thinking',
      });

      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'idle', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
            updatedAt: 1700000005000,
            lastActivityAt: 1700000005000,
          }),
        ],
      };
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-2');

      await waitFor(() =>
        fix.fanout.getAgentRunStates(fix.channelId)[0]?.status === 'idle',
      );
      expect(fix.fanout.getAgentRunStates(fix.channelId)[0]).toMatchObject({
        status: 'idle',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('marks DB-active runtimes missing from a daemon hydrate snapshot as crashed', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      new ConversationRepo(fix.db).updateAgentRuntime(fix.channelId, fix.agentId, {
        status: 'active',
        pid: 999,
      });
      fix.transport.snapshot = { runtimes: [] };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');

      await waitFor(() => fix.row().status === 'crashed');
      expect(fix.row()).toMatchObject({ status: 'crashed', pid: null });
      expect(fix.events).toContainEqual({
        conv: fix.channelId,
        kind: 'agent_status',
        payload: {
          agent_id: fix.agentId,
          status: 'crashed',
          pid: null,
          reason: 'daemon_hydrate_missing',
        },
      });
    } finally {
      fix.cleanup();
    }
  });

  it('drops stale ready_for_drain events and does not pin a live delivery to the old connection', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));

      // The transport has accepted a newer attachment, but an old
      // socket/frame delivers a late ready_for_drain. It must not write
      // state.currentConnectionId back to conn-1 or dispatch a delivery
      // pinned to that dead connection.
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await wait(25);
      expect(fix.transport.deliverCalls()).toHaveLength(0);

      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'live after stale event',
      });
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_deliver'),
      );
      const deliver = fix.transport.deliverCalls()[0];
      expect(deliver?.opts?.expectedConnectionId).toBe('conn-2');
    } finally {
      fix.cleanup();
    }
  });

  it('logs at most one warning per stale outbound event connection', () => {
    const warnings: Array<Record<string, unknown>> = [];
    const fix = makeFixture({
      logger: {
        ...SILENT_LOGGER,
        warn: (obj: Record<string, unknown>) => warnings.push(obj),
      },
    });
    try {
      fix.transport.connectionId = 'conn-2';

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');

      expect(
        warnings.filter(
          warning => warning.action === 'outbound_event_stale_connection',
        ),
      ).toHaveLength(1);
    } finally {
      fix.cleanup();
    }
  });

  it('replays pending inbox rows only after runtime_ready_for_drain', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'replay me');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      expect(fix.transport.calls.some(call => call.kind === 'runtime_deliver')).toBe(false);

      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_deliver'));

      const deliver = fix.transport.deliverCalls()[0];
      expect(deliver?.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  // Boot-herd root-cause pin (shiki: "为什么会同一时间拉起那么多" / Cindy
  // negative `Glz2dqd_gmAlDOv2`). The reattach replay
  // (`onHydrateComplete → replayPendingForHost`) must derive its
  // re-drive set from the daemon's LIVE runtime snapshot — never from
  // the DB pending set. A cold daemon (re)start reports zero live
  // runtimes, so DB backlog must NOT be turned into runtime_start /
  // runtime_wake at attach time. Activation happens only on a real send.
  it('cold daemon attach with DB pending but NO live runtime in the hydrate snapshot does NOT replay backlog into runtime_start/wake; a later live send starts exactly that one pair', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      // Historical backlog from a prior session — the exact state that,
      // pre-fix, made every pending (conv, agent) pair spawn a runtime
      // at boot (29 claude procs / 8GB in shiki's dogfood).
      enqueueMessage(fix, 'historical pending from a prior session');

      // Cold daemon: just (re)started, so its runtime_status snapshot
      // reports ZERO live runtimes. Hydrate populates an empty cache.
      fix.transport.snapshot = { runtimes: [] };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_status'),
      );
      // Let the queueMicrotask-scheduled onHydrateComplete replay run.
      await wait(25);

      // Root-cause invariant: no live runtime in the snapshot ⇒ NOTHING
      // derived from DB pending. Neither a spawn nor a deliver.
      expect(
        fix.transport.calls.some(call => call.kind === 'runtime_start'),
      ).toBe(false);
      expect(fix.transport.deliverCalls()).toHaveLength(0);
      // The backlog stays a durable pending inbox, untouched.
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toHaveLength(1);

      // The user actually sends into this conversation. THAT — and only
      // that — is the activation trigger: exactly one runtime_deliver for
      // this one pair (the daemon spawns-with-batch to drain the backlog).
      const live = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'live send',
      });
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, live.id);
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_deliver'),
      );
      expect(fix.transport.deliverCalls()).toHaveLength(1);
    } finally {
      fix.cleanup();
    }
  });

  it('delivers a live message via a single runtime_deliver even when the backend cache has no entry (daemon owns spawn-vs-admit)', async () => {
    // #task:1417 Stage 2b — the SOLE delivery command is `runtime_deliver`,
    // and the coordinator no longer reads the desyncable cache to route
    // (root #1416 fix). The old "runtime_start → reroute-to-wake" dance for a
    // live-but-uncached handle is gone: deliverMessage claims the row and
    // dispatches ONE runtime_deliver; the daemon admits (or spawns). The row
    // is never orphaned. Runtime-agnostic; codex stands in for opencode.
    const fix = makeFixture({ runtime: 'codex' });
    try {
      // Daemon connected, but the hydrate reported an EMPTY snapshot so the
      // backend cache has no entry for this pair — the exact desync that used
      // to wedge #1416. In Stage 2b it no longer matters: no cache read.
      fix.transport.snapshot = { runtimes: [] };
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_status'),
      );

      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'second message to a live-but-uncached runtime',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      // Daemon has the handle alive → admits the batch.
      fix.transport.setNextDeliverDisposition('admitted');
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);

      // Exactly one runtime_deliver carrying the row — not orphaned in pending
      // (rows stay in-flight until the async runtime_delivery_consumed).
      expect(fix.transport.deliverCalls()).toHaveLength(1);
      expect(fix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('delivers via runtime_deliver even while the hydrate is still in flight (cache not latched)', async () => {
    // Stage 2b: because delivery no longer consults the cache, the
    // ready→hydrate race window that used to need a `runtime_start` reroute
    // is a non-issue — deliverMessage dispatches runtime_deliver regardless of
    // whether the cache has latched a daemon key.
    const fix = makeFixture({ runtime: 'codex' });
    try {
      // Hold the hydrate open so the cache NEVER latches a daemon key.
      fix.transport.deferNextStatus();
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_status'),
      );

      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'message in the ready→hydrate window',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      fix.transport.setNextDeliverDisposition('admitted');
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);

      expect(fix.transport.deliverCalls()).toHaveLength(1);
      expect(fix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);

      // Let the deferred hydrate settle so teardown doesn't leave a dangling
      // promise.
      fix.transport.resolveDeferredStatus({ runtimes: [] });
    } finally {
      fix.cleanup();
    }
  });

  it('keeps rows pending when runtime_deliver is refused (startup_pending / cooldown)', async () => {
    // Stage 2b: a refused disposition means the daemon took nothing (handle
    // still coming up). Backend rolls the claimed rows back to pending
    // (retriable); the daemon's own ready_for_drain re-drives later.
    for (const reason of ['startup_pending', 'cooldown'] as const) {
      const fix = makeFixture({ runtime: 'codex' });
      try {
        fix.transport.snapshot = { runtimes: [] };
        fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
        await waitFor(() =>
          fix.transport.calls.some(call => call.kind === 'runtime_status'),
        );

        const msg = fix.messages.insertForConversation({
          conversationId: fix.channelId,
          fromKind: 'user',
          content: `message while ${reason}`,
        });
        const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

        fix.transport.refuseNextDeliver(reason);
        await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);

        // Exactly one deliver attempt, row rolled back to pending.
        expect(fix.transport.deliverCalls()).toHaveLength(1);
        const pending = fix.inbox.listPending(fix.channelId, fix.agentId);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.inboxId).toBe(delivery.inboxId);
      } finally {
        fix.cleanup();
      }
    }
  });

  it('keeps rows pending when runtime_deliver is refused (draining)', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      fix.transport.snapshot = { runtimes: [] };
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_status'),
      );

      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'message while draining',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      fix.transport.refuseNextDeliver('draining');
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);

      expect(fix.transport.deliverCalls()).toHaveLength(1);
      const pending = fix.inbox.listPending(fix.channelId, fix.agentId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.inboxId).toBe(delivery.inboxId);
    } finally {
      fix.cleanup();
    }
  });

  it('claims replay rows FIFO and does not issue concurrent deliveries for repeated ready_for_drain', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const first = enqueueMessage(fix, 'first');
      const second = enqueueMessage(fix, 'second');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.deferNextDeliver();

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.deliverCalls().length === 1);
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await new Promise(resolve => setTimeout(resolve, 25));

      expect(fix.transport.deliverCalls()).toHaveLength(1);
      expect(fix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [first.inboxId, second.inboxId],
      });

      fix.transport.resolveDeferredDeliver({
        disposition: 'admitted',
        pid: 123,
        started_at: 1700000000000,
      });
      // Ack the batch so the in-flight rows clear (dispatched keeps rows
      // in-flight until the async runtime_delivery_consumed).
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_delivery_consumed',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          delivery_ids: [first.inboxId, second.inboxId],
          ts: 1700000002000,
        },
        'conn-1',
      );
      await waitFor(() => fix.inbox.listPending(fix.channelId, fix.agentId).length === 0);
    } finally {
      fix.cleanup();
    }
  });

  it('rolls in-flight replay rows back to pending when delivery dispatch fails', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'retry after timeout');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.rejectNextDeliver(new Error('transport_timeout'));

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');

      await waitFor(() =>
        fix.inbox.listPending(fix.channelId, fix.agentId)[0]?.inboxId === delivery.inboxId,
      );
    } finally {
      fix.cleanup();
    }
  });

  it('keeps replay rows pending when daemon refuses delivery', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'driver not ready');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.refuseNextDeliver('startup_pending');

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');

      await waitFor(() =>
        fix.inbox.listPending(fix.channelId, fix.agentId)[0]?.inboxId === delivery.inboxId,
      );
    } finally {
      fix.cleanup();
    }
  });

  it('does not turn ready_for_drain replay into the coordinator in-memory queue', async () => {
    const fix = makeFixture({ runtime: 'claude' });
    try {
      const delivery = enqueueMessage(fix, 'claude replay');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'thinking',
          }),
        ],
      };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_parsed_event',
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        parsed: {
          kind: 'tool_call',
          name: 'shell',
          input: { cmd: 'sleep' },
          toolCallId: 'tool-1',
        },
        ts: 1700000000000,
      }, 'conn-1');
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');

      await waitFor(() => fix.transport.deliverCalls().length === 1);
      expect(fix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('sweeps old-connection in-flight rows before replaying on the new connection', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'connection swap');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.deferNextDeliver();

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.deliverCalls().length === 1);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);

      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.connectionId = 'conn-2';
      fix.transport.rejectDeferredDeliver(new Error('transport_disconnected'));
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-2');
      await waitFor(() => fix.transport.calls.filter(call => call.kind === 'runtime_status').length >= 2);
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-2');

      await waitFor(() => fix.transport.deliverCalls().length === 2);
      expect(fix.transport.deliverCalls()[1]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('spawns-with-batch via runtime_deliver when no runtime exists, and admits via runtime_deliver when ready', async () => {
    const startFix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(startFix, 'start me');
      await expect(
        startFix.fanout.deliverPending(startFix.channelId, startFix.agentId),
      ).resolves.toBe(true);
      expect(startFix.transport.deliverCalls()[0]?.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      // No bare runtime_start — delivery goes through the deliver plane.
      expect(
        startFix.transport.calls.some(call => call.kind === 'runtime_start'),
      ).toBe(false);
    } finally {
      startFix.cleanup();
    }

    const deliveryFix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(deliveryFix, 'wake me');
      deliveryFix.transport.snapshot = {
        runtimes: [
          runtimeDto(deliveryFix.channelId, deliveryFix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: deliveryFix.channelId,
            agentId: deliveryFix.agentId,
            status: 'idle',
          }),
        ],
      };
      deliveryFix.fanout.onEvent(deliveryFix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => deliveryFix.transport.calls.some(call => call.kind === 'runtime_status'));
      deliveryFix.fanout.onEvent(deliveryFix.hostId, readyForDrainEvent(deliveryFix), 'conn-1');
      await waitFor(() => deliveryFix.transport.deliverCalls().length === 1);
      expect(deliveryFix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(deliveryFix.transport.calls.some(call => call.kind === 'runtime_start')).toBe(false);
    } finally {
      deliveryFix.cleanup();
    }
  });

  it('oneShot (cursor) with no live handle spawns-with-batch via runtime_deliver (deliverPending AND deliverMessage)', async () => {
    // #task:1417 Stage 2b (Cindy review #2) — the coordinator no longer
    // short-circuits oneShot to a fake `noop_oneshot_live`. A oneShot with
    // no live handle MUST reach the daemon as a `runtime_deliver`, which
    // spawns-with-batch; the pre-fix short-circuit stranded a no-live
    // oneShot in a pending↔rollback loop that never spawned. Both entry
    // points (deliverPending, deliverMessage) share this delivery plane.
    const pendingFix = makeFixture({ runtime: 'cursor' });
    try {
      const delivery = enqueueMessage(pendingFix, 'spawn me, one-shot');
      await expect(
        pendingFix.fanout.deliverPending(pendingFix.channelId, pendingFix.agentId),
      ).resolves.toBe(true);
      expect(pendingFix.transport.deliverCalls()).toHaveLength(1);
      expect(pendingFix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      // Delivery plane only — no bare lifecycle runtime_start.
      expect(
        pendingFix.transport.calls.some(call => call.kind === 'runtime_start'),
      ).toBe(false);
      // Rows stay in-flight (custody with the daemon) until the async ack.
      expect(
        pendingFix.inbox.listPending(pendingFix.channelId, pendingFix.agentId),
      ).toEqual([]);
    } finally {
      pendingFix.cleanup();
    }

    const msgFix = makeFixture({ runtime: 'cursor' });
    try {
      const msg = msgFix.messages.insertForConversation({
        conversationId: msgFix.channelId,
        fromKind: 'user',
        content: 'deliver me, one-shot',
      });
      const delivery = msgFix.inbox.ensureDelivery(
        msgFix.channelId,
        msgFix.agentId,
        msg.id,
      );
      await msgFix.fanout.deliverMessage(msgFix.channelId, msgFix.agentId, msg.id);
      expect(msgFix.transport.deliverCalls()).toHaveLength(1);
      expect(msgFix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(
        msgFix.transport.calls.some(call => call.kind === 'runtime_start'),
      ).toBe(false);
    } finally {
      msgFix.cleanup();
    }
  });

  it('a live oneShot (cursor) is daemon-refused without an ack; backend rolls back pending, then a non-fatal exit respawns to drain via runtime_deliver', async () => {
    // #task:1417 Stage 2b (Cindy review #2) — a LIVE oneShot can never take a
    // stdin delivery, so the daemon SYNC-refuses (`startup_pending`) rather
    // than `admitted` then async `driver_refused` (which is reserved for a
    // genuine driver programming error). Backend rolls the row back to
    // pending with NO `delivered_at` ack; the oneShot drains on its next
    // `runtime_exit` → respawn-with-batch.
    const fix = makeFixture({ runtime: 'cursor' });
    try {
      const delivery = enqueueMessage(fix, 'refuse then drain');

      // 1. Live oneShot refuses the delivery synchronously (no ack emitted).
      fix.transport.refuseNextDeliver('startup_pending');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      expect(fix.transport.deliverCalls()).toHaveLength(1);
      // Row rolled back to pending — custody returned to the DB, not acked.
      expect(
        fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId),
      ).toEqual([delivery.inboxId]);

      // 2. A non-fatal exit with the row still pending re-drives the drain
      //    via a fresh spawn-with-batch runtime_deliver (default disposition).
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_exit',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          code: 1,
          intentional: false,
          ts: 1700000010000,
        },
        'conn-1',
      );

      await waitFor(() => fix.transport.deliverCalls().length === 2);
      expect(fix.transport.deliverCalls()[1]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('rolls startup_delivery rows back to pending when the spawned child exits before init', async () => {
    const fix = makeFixture();
    try {
      const delivery = enqueueMessage(fix, 'do not lose me');

      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
      expect(
        fix.inbox.countInFlightForPairOwner(
          fix.channelId,
          fix.agentId,
          'conn-1',
        ),
      ).toBe(1);

      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_delivery_failed',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          delivery_ids: [delivery.inboxId],
          reason: 'child_exit',
          ts: 1700000001000,
        },
        'conn-1',
      );

      expect(
        fix.inbox.countInFlightForPairOwner(
          fix.channelId,
          fix.agentId,
          'conn-1',
        ),
      ).toBe(0);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId))
        .toEqual([delivery.inboxId]);
    } finally {
      fix.cleanup();
    }
  });

  it('keeps stale-resume startup_delivery pending and suppresses auto-respawn on fatal parsed error', async () => {
    const fix = makeFixture();
    try {
      const delivery = enqueueMessage(fix, 'wake after idle');

      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      const initialDelivers = fix.transport.deliverCalls().length;

      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_parsed_event',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          parsed: {
            kind: 'error',
            code: 'session_not_found',
            fatal: true,
            message: 'No conversation found with session ID: stale',
          },
          ts: 1700000001000,
        },
        'conn-1',
      );
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_delivery_failed',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          delivery_ids: [delivery.inboxId],
          reason: 'child_exit',
          ts: 1700000001001,
        },
        'conn-1',
      );
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_exit',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          code: 1,
          intentional: false,
          ts: 1700000001002,
        },
        'conn-1',
      );

      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(fix.row().status).toBe('crashed');
      expect(fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId))
        .toEqual([delivery.inboxId]);
      // Respawn suppressed (fatalError) → no additional runtime_deliver.
      expect(fix.transport.deliverCalls()).toHaveLength(initialDelivers);
    } finally {
      fix.cleanup();
    }
  });

  it('wires coordinator.respawn → a non-fatal runtime_exit with pending inbox re-runs startup_delivery (D5.a-3 respawn-wiring regression)', async () => {
    // Regression pin: the D5.a-3 unification onto OutboundRuntimeEventFanout
    // dropped the `respawn` callback, so a runtime that exited with pending
    // inbox logged "no respawn callback wired" and never drained. The
    // coordinator's onRuntimeExit gate (intentional===false AND !initTimedOut
    // AND !fatalError AND hasPendingInbox) must auto-respawn via
    // `deliverPending` — the ONLY correct redelivery path for an exited
    // runtime (a `runtime_deliver` with no live handle spawns-with-batch to
    // drain a dead child). The gate is driver-agnostic, so codex stands in.
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'drain me after crash');

      // Crash exit: intentional=false, code!=0, and no prior init-timeout /
      // fatal-error flag → meta is { intentional:false, initTimedOut:false,
      // fatalError:false } with pending inbox. This is exactly the gate.
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_exit',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          code: 1,
          intentional: false,
          ts: 1700000010000,
        },
        'conn-1',
      );

      // respawn fires on a microtask (Promise.resolve().then in the
      // coordinator); the spawn path dispatches a fresh runtime_deliver.
      await waitFor(() => fix.transport.deliverCalls().length === 1);
      // It drains the still-pending row via spawn-with-batch runtime_deliver.
      expect(fix.transport.deliverCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('does NOT respawn on an intentional runtime_exit even with pending inbox', async () => {
    // Complement to the wiring pin: the gate must stay closed for an
    // intentional stop so a deliberate shutdown isn't immediately undone.
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'stay pending on intentional stop');
      emitRuntimeExit(fix); // intentional: true

      // Give any errant microtask-scheduled respawn a chance to run.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(fix.transport.deliverCalls()).toHaveLength(0);
      expect(
        fix.transport.calls.some(call => call.kind === 'runtime_start'),
      ).toBe(false);
      // Row remains pending — durable, to be drained on the next deliberate start.
      expect(
        fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId),
      ).toEqual([delivery.inboxId]);
    } finally {
      fix.cleanup();
    }
  });

  it('mid-turn is NOT special at the backend: deliver dispatches (daemon defers); a bare runtime_exit does NOT roll back — rollback is daemon-driven via runtime_delivery_failed (#task:1417 Stage 3)', async () => {
    // Stage 3 moved the mid-turn queue AND the child-exit rollback INTO the
    // daemon. So at the backend the mid-turn distinction disappears: a live
    // deliver while the runtime is mid-turn dispatches a single
    // `runtime_deliver` exactly like any other, and the daemon reports
    // `deferred` (it parked the write in its own queue). The row stays
    // in-flight. Critically, a bare `runtime_exit` no longer triggers a
    // backend rollback+respawn — the daemon owns that queue, so it is the
    // daemon's `runtime_delivery_failed{child_exit}` that returns the row to
    // pending. This test pins both halves of the cutover.
    const fix = makeFixture({ runtime: 'claude' });
    try {
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'thinking',
          }),
        ],
      };
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_status'),
      );

      // Drive the runtime mid-turn (outstanding tool use → not a safe
      // boundary). Under Stage 2b this queued in the backend; under Stage 3
      // it is irrelevant to the backend's dispatch decision.
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_parsed_event',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          parsed: {
            kind: 'tool_call',
            name: 'shell',
            input: { cmd: 'sleep' },
            toolCallId: 'tool-1',
          },
          ts: 1700000000000,
        },
        'conn-1',
      );

      // The daemon will report `deferred` (it parked the write mid-turn).
      fix.transport.setNextDeliverDisposition('deferred');
      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'delivered mid-turn',
      });
      const delivery = fix.inbox.ensureDelivery(
        fix.channelId,
        fix.agentId,
        msg.id,
      );
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);

      // Stage 3: mid-turn dispatches ONE runtime_deliver (not queued at the
      // backend), and the `deferred` disposition keeps the row in-flight —
      // NOT pending.
      await waitFor(() => fix.transport.deliverCalls().length === 1);
      expect(fix.transport.deliverCalls()[0]!.params).toMatchObject({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
      });
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);

      // A bare non-fatal child exit: the backend must NOT roll back or
      // respawn — the daemon owns the deferred queue now.
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_exit',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          code: 1,
          intentional: false,
          ts: 1700000010000,
        },
        'conn-1',
      );
      await wait(30);
      // No respawn-driven second deliver, and the row is still in-flight
      // (backend did not roll it back on exit).
      expect(fix.transport.deliverCalls()).toHaveLength(1);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);

      // Rollback is daemon-driven: the daemon's onChildExit emits
      // `runtime_delivery_failed{child_exit}` for the queued entry, which the
      // backend applies by returning the row to durable pending.
      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_delivery_failed',
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
          delivery_ids: [delivery.inboxId],
          reason: 'child_exit',
          ts: 1700000011000,
        },
        'conn-1',
      );
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toMatchObject([
        { inboxId: delivery.inboxId },
      ]);
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1612 — runtime_deliver dispatches NO workspace_provision, and spawn_options carry NO host paths', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);

      const kinds = fix.transport.calls.map(c => c.kind);
      // The spawn path performs NO provision (the registry is the sole
      // authority; realization happened at creation/membership time).
      expect(kinds).not.toContain('workspace_provision');
      const deliverIdx = kinds.indexOf('runtime_deliver');
      expect(deliverIdx).toBeGreaterThanOrEqual(0);

      // The runtime_deliver spawn_options are SEMANTIC-only: no
      // path/home_dir anywhere in the options tree.
      const deliver = fix.transport.calls[deliverIdx]!.params;
      const spawnOptions = deliver.spawn_options as {
        workspace: Record<string, unknown>;
        agent: Record<string, unknown>;
        workspace_memory_index: Record<string, unknown>[];
      };
      const json = JSON.stringify(spawnOptions);
      expect(json).not.toMatch(/"path"/);
      expect(json).not.toMatch(/"home_dir"/);
      expect(Object.keys(spawnOptions.workspace).sort()).toEqual(['id', 'kind', 'name']);
      expect(Object.keys(spawnOptions.agent).sort()).toEqual(['id', 'name']);
      for (const entry of spawnOptions.workspace_memory_index) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'kind', 'name']);
      }
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1612 — a cross-host ACTIVE workspace spawns with ZERO provision too: guest realization is membership-time, not spawn-time', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      agentL2SeedEnsurer: ({ transport }) =>
        new AgentL2SeedEnsurer({
          outboundFrameAdapter: () =>
            transport as unknown as OutboundFrameAdapter,
        }),
    });
    try {
      enqueueMessage(fix, 'start me');
      const otherHostId = new HostRepo(fix.db).create('host-other', 'local').id;
      fix.db
        .prepare(`UPDATE workspaces SET workspace_host_id = ?`)
        .run(otherHostId);
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      expect(
        fix.transport.calls.filter(c => c.kind === 'workspace_provision'),
      ).toHaveLength(0);
      expect(fix.transport.deliverCalls()).toHaveLength(1);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1596/#task:1612 — strict pre-spawn order: agent_l2_seed → runtime_deliver, zero provision', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      agentL2SeedEnsurer: ({ transport }) =>
        new AgentL2SeedEnsurer({
          outboundFrameAdapter: () =>
            transport as unknown as OutboundFrameAdapter,
        }),
    });
    try {
      enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      const kinds = fix.transport.calls.map(c => c.kind);
      const seedIdx = kinds.indexOf('agent_l2_seed');
      const deliverIdx = kinds.indexOf('runtime_deliver');
      expect(kinds).not.toContain('workspace_provision');
      expect(seedIdx).toBeGreaterThanOrEqual(0);
      expect(deliverIdx).toBeGreaterThan(seedIdx);
      const seed = fix.transport.calls[seedIdx]!.params;
      expect(seed).toMatchObject({
        agent_id: fix.agentId,
        template_choice: 'default',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1596 — a failed L2 seed BLOCKS runtime_deliver and keeps the rows pending for retry', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      agentL2SeedEnsurer: () =>
        ({
          ensure: async () => ({
            ok: false,
            failure: {
              code: 'daemon_unavailable' as const,
              message: 'seed failed',
              retriable: true,
            },
          }),
        }) as unknown as AgentL2SeedEnsurer,
    });
    try {
      const delivery = enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).rejects.toThrow(/filesystem ensure incomplete/);
      expect(fix.transport.deliverCalls()).toHaveLength(0);
      expect(
        fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId),
      ).toEqual([delivery.inboxId]);
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1612 — a MISSING registry binding (typed workspace_not_provisioned from the seed) blocks the spawn; no provision heals it', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      agentL2SeedEnsurer: () =>
        ({
          ensure: async () => ({
            ok: false,
            failure: {
              code: 'workspace_not_provisioned' as const,
              message: 'workspace has no registry binding on this computer',
              retriable: true,
            },
          }),
        }) as unknown as AgentL2SeedEnsurer,
    });
    try {
      const delivery = enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).rejects.toThrow(/filesystem ensure incomplete/);
      // Fail closed: NO provision was dispatched to mint a fresh root over
      // the missing binding, no deliver reached the daemon, rows retry.
      expect(
        fix.transport.calls.some(c => c.kind === 'workspace_provision'),
      ).toBe(false);
      expect(fix.transport.deliverCalls()).toHaveLength(0);
      expect(
        fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId),
      ).toEqual([delivery.inboxId]);
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1596 — peer workspaces never enter the pre-spawn ensure: only the ACTIVE workspace is seeded', async () => {
    const seeded: string[] = [];
    const fix = makeFixture({
      runtime: 'codex',
      agentL2SeedEnsurer: () =>
        ({
          ensure: async (_h: string, workspaceId: string) => {
            seeded.push(workspaceId);
            return { ok: true };
          },
        }) as unknown as AgentL2SeedEnsurer,
    });
    try {
      const workspaces = new WorkspaceRepo(fix.db);
      const peer = workspaces.insert({
        name: 'peer-ws',
        description: null,
        workspacePath: testWorkspacePath('peer-ws'),
        workspaceHostId: fix.hostId,
      });
      fix.db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
            VALUES (?, ?, ?)`,
        )
        .run(peer.id, fix.agentId, Date.now());

      enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      expect(seeded).toEqual([fix.workspaceId]);
      expect(
        fix.transport.calls.some(c => c.kind === 'workspace_provision'),
      ).toBe(false);
    } finally {
      fix.cleanup();
    }
  });

  it('#task:1596/#task:1612 — a regular-workspace spawn with an UNWIRED seed dep fails closed (no dispatch)', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      agentL2SeedEnsurer: null,
    });
    try {
      const delivery = enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).rejects.toThrow(/filesystem ensure incomplete/);
      expect(
        fix.transport.calls.some(c => c.kind === 'workspace_provision'),
      ).toBe(false);
      expect(
        fix.transport.calls.some(c => c.kind === 'agent_l2_seed'),
      ).toBe(false);
      expect(fix.transport.deliverCalls()).toHaveLength(0);
      expect(
        fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId),
      ).toEqual([delivery.inboxId]);
    } finally {
      fix.cleanup();
    }
  });

  it('fails before wire when the agent host is revoked', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      enqueueMessage(fix, 'no revoked host send');
      new HostRepo(fix.db).revoke(fix.hostId);

      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).rejects.toThrow(/revoked/);
      expect(fix.transport.calls).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  // ── D5.a-3 boundary pins (Cindy `Ixbm39eKMSQpZ-LW`) ──
  //
  // After D5.a unified embedded + standalone onto this single fanout +
  // OutboundFrameAdapter there is exactly ONE runtime/materialize code
  // path. These pins therefore lock the cross-mode contract: the only
  // permitted divergence is the transport instance behind
  // `transport()` — the dispatch decisions below are mode-agnostic.

  // Pin 1 — `start` is delivery-backed. An EMPTY pending inbox dispatches
  // NOTHING (no `runtime_start`) and returns false. The pending→
  // runtime_start arm is covered by 'uses startup_delivery when no
  // runtime exists …' above. Pre-D5.a the embedded path could spawn on
  // an empty inbox; both modes now agree on "no pending ⇒ no dispatch".
  it('deliverPending with an empty pending inbox dispatches nothing (delivery-backed; identical embedded/standalone)', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(false);
      expect(fix.transport.calls).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('reclaims stale in-flight rows before treating explicit start as idempotent success', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'stuck behind old owner');
      fix.inbox.claimPending(fix.channelId, fix.agentId, 'old-conn');

      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);

      const deliver = fix.transport.deliverCalls()[0];
      expect(deliver).toBeDefined();
      expect(deliver?.opts?.expectedConnectionId).toBe('conn-1');
      expect(deliver?.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(fix.inbox.listInFlightForOwner('old-conn')).toEqual([]);
      expect(
        fix.inbox.countInFlightForPairOwner(
          fix.channelId,
          fix.agentId,
          'conn-1',
        ),
      ).toBe(1);
    } finally {
      fix.cleanup();
    }
  });

  it('explicit start with an empty pending inbox dispatches runtime_start without startup_delivery', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      await expect(
        fix.fanout.start(fix.channelId, fix.agentId),
      ).resolves.toBeUndefined();
      const start = fix.transport.calls.find(c => c.kind === 'runtime_start');
      expect(start).toBeDefined();
      expect(start?.opts?.expectedConnectionId).toBe('conn-1');
      expect(start?.params).not.toHaveProperty('startup_delivery');
    } finally {
      fix.cleanup();
    }
  });

  it('runtime_deliver spawn_options never carry server_url; the daemon injects host-local URL', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.deliverPending(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      const deliver = fix.transport.deliverCalls()[0];
      expect(deliver).toBeDefined();
      expect(
        (
          deliver!.params as {
            spawn_options: { env_policy: { silverhand: Record<string, unknown> } };
          }
        ).spawn_options.env_policy.silverhand,
      ).not.toHaveProperty('server_url');
    } finally {
      fix.cleanup();
    }
  });

  it('sends the server silverhand CLI launcher only to the co-located host', async () => {
    const colocated = makeFixture({ runtime: 'codex' });
    const remote = makeFixture({ runtime: 'codex', coLocatedHostId: null });
    try {
      await expect(
        colocated.fanout.start(colocated.channelId, colocated.agentId),
      ).resolves.toBeUndefined();
      const colocatedStart = colocated.transport.calls.find(
        c => c.kind === 'runtime_start',
      );
      expect(colocatedStart).toBeDefined();
      expect(
        (
          colocatedStart!.params as {
            options: { env_policy: Record<string, unknown> };
          }
        ).options.env_policy,
      ).toHaveProperty('silverhand_cli');

      await expect(
        remote.fanout.start(remote.channelId, remote.agentId),
      ).resolves.toBeUndefined();
      const remoteStart = remote.transport.calls.find(
        c => c.kind === 'runtime_start',
      );
      expect(remoteStart).toBeDefined();
      expect(
        (
          remoteStart!.params as {
            options: { env_policy: Record<string, unknown> };
          }
        ).options.env_policy,
      ).not.toHaveProperty('silverhand_cli');
    } finally {
      colocated.cleanup();
      remote.cleanup();
    }
  });

  // Pin 3 — bulk shutdown dispatches the EXISTING outbound commands to
  // every connected host (never a silent no-op, which would orphan daemon
  // children). `connectedHostIds()` is the fan-out set; the fake reports
  // one host ('local').
  it('stopAll dispatches runtime_stop_all to every connected host', async () => {
    const fix = makeFixture();
    try {
      await fix.fanout.stopAll();
      const stopAlls = fix.transport.calls.filter(
        c => c.kind === 'runtime_stop_all',
      );
      expect(stopAlls).toHaveLength(1);
      expect(stopAlls[0]!.hostId).toBe('local');
      expect(stopAlls[0]!.params).toEqual({});
    } finally {
      fix.cleanup();
    }
  });

  it('closeActivityLog dispatches runtime_close_activity_log to every connected host', async () => {
    const fix = makeFixture();
    try {
      await fix.fanout.closeActivityLog();
      const closes = fix.transport.calls.filter(
        c => c.kind === 'runtime_close_activity_log',
      );
      expect(closes).toHaveLength(1);
      expect(closes[0]!.hostId).toBe('local');
      expect(closes[0]!.params).toEqual({});
    } finally {
      fix.cleanup();
    }
  });

  it('stop dispatches the hard-only wire shape (#task:1558 — soft arm deleted)', async () => {
    const fix = makeFixture();
    try {
      await fix.fanout.stop(fix.channelId, fix.agentId);

      const stops = fix.transport.calls.filter(c => c.kind === 'runtime_stop');
      expect(stops).toHaveLength(1);
      expect(stops[0]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'hard',
      });
      expect('soft_directive' in stops[0]!.params).toBe(false);
    } finally {
      fix.cleanup();
    }
  });

  // #task:1616 — the delete-computer / delete-workspace cascade stops its runs
  // AFTER the commit that deleted the `agents` + `hosts` rows (nothing
  // destructive may precede the commit decision point). On THIS path — the
  // production, placement-aware dispatcher, not a test double — the default
  // routing (`hostIdForAgent`) re-reads exactly those deleted rows, so a stop
  // that does not carry the captured host is a silent no-op: it throws, the
  // caller's best-effort `catch` degrades it to a warning, and the daemon's
  // child keeps running while the backend marks the run terminal.
  it('stop routes by the captured hostId after the agent and host rows are deleted', async () => {
    const fix = makeFixture();
    try {
      const capturedHostId = fix.hostId;
      // The cascade's own deletes, reproduced: by teardown time no row that
      // could name the route exists.
      deleteComputerRows(fix);

      await fix.fanout.stop(fix.channelId, fix.agentId, {
        hostId: capturedHostId,
      });

      const stops = fix.transport.calls.filter(c => c.kind === 'runtime_stop');
      expect(stops).toHaveLength(1);
      expect(stops[0]!.hostId).toBe(capturedHostId);
      expect(stops[0]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'hard',
      });
    } finally {
      fix.cleanup();
    }
  });

  // The falsifier for the line above: drop the captured route and the same
  // post-cascade stop dispatches NOTHING. This is what the cascade did before
  // `StopOptions.hostId` existed, and it is why the capture — not just the
  // `(conversation, agent)` identity — is load-bearing.
  it('stop without the captured hostId cannot dispatch once the rows are gone', async () => {
    const fix = makeFixture();
    try {
      deleteComputerRows(fix);

      await expect(
        fix.fanout.stop(fix.channelId, fix.agentId),
      ).rejects.toThrow(/not found/);
      expect(fix.transport.calls.filter(c => c.kind === 'runtime_stop')).toEqual(
        [],
      );
    } finally {
      fix.cleanup();
    }
  });

  it('reapIdleRuntimes stops only stale live-idle runtimes and pins the connection', async () => {
    const fix = makeFixture();
    try {
      await hydrateRuntime(fix, 'ready', {
        status: 'idle',
        lastActivityAt: 1700000000000,
      });

      await expect(
        fix.fanout.reapIdleRuntimes({
          ttlMs: 30 * 60_000,
          now: 1700000000000 + 31 * 60_000,
        }),
      ).resolves.toMatchObject({
        considered: 1,
        eligible: 1,
        reaped: 1,
        failed: 0,
      });

      const stop = fix.transport.stopCalls()[0]!;
      expect(stop.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'hard',
      });
      expect(stop.opts?.expectedConnectionId).toBe('conn-1');
    } finally {
      fix.cleanup();
    }
  });

  it('reapIdleRuntimes skips active, disabled, and undelivered-inbox runtimes', async () => {
    const active = makeFixture();
    try {
      await hydrateRuntime(active, 'ready', {
        status: 'thinking',
        lastActivityAt: 1700000000000,
      });
      await active.fanout.reapIdleRuntimes({
        ttlMs: 30 * 60_000,
        now: 1700000000000 + 31 * 60_000,
      });
      expect(active.transport.stopCalls()).toHaveLength(0);
    } finally {
      active.cleanup();
    }

    const disabled = makeFixture({ runtime: 'claude' });
    try {
      await hydrateRuntime(disabled, 'ready', {
        status: 'idle',
        lastActivityAt: 1700000000000,
      });
      await disabled.fanout.reapIdleRuntimes({
        ttlMs: 30 * 60_000,
        now: 1700000000000 + 31 * 60_000,
        runtimeEnabled: runtime => runtime !== 'claude',
      });
      expect(disabled.transport.stopCalls()).toHaveLength(0);
    } finally {
      disabled.cleanup();
    }

    const inFlight = makeFixture();
    try {
      enqueueMessage(inFlight, 'already claimed');
      inFlight.inbox.claimPending(inFlight.channelId, inFlight.agentId, 'conn-1');
      await hydrateRuntime(inFlight, 'ready', {
        status: 'idle',
        lastActivityAt: 1700000000000,
      });
      await inFlight.fanout.reapIdleRuntimes({
        ttlMs: 30 * 60_000,
        now: 1700000000000 + 31 * 60_000,
      });
      expect(inFlight.transport.stopCalls()).toHaveLength(0);
    } finally {
      inFlight.cleanup();
    }
  });

  it('reapIdleRuntimes rechecks undelivered inbox before stop', async () => {
    const fix = makeFixture();
    const original = ConversationInboxRepo.prototype.hasUndeliveredForPair;
    let checksForPair = 0;
    const spy = vi
      .spyOn(ConversationInboxRepo.prototype, 'hasUndeliveredForPair')
      .mockImplementation(function (
        this: ConversationInboxRepo,
        conversationId,
        agentId,
      ) {
        if (conversationId === fix.channelId && agentId === fix.agentId) {
          checksForPair++;
          if (checksForPair === 1) return false;
          if (checksForPair === 2) {
            enqueueMessage(fix, 'raced in');
            this.claimPending(conversationId, agentId, 'conn-race');
          }
        }
        return original.call(this, conversationId, agentId);
      });
    try {
      await hydrateRuntime(fix, 'ready', {
        status: 'idle',
        lastActivityAt: 1700000000000,
      });

      await fix.fanout.reapIdleRuntimes({
        ttlMs: 30 * 60_000,
        now: 1700000000000 + 31 * 60_000,
      });

      expect(fix.transport.stopCalls()).toHaveLength(0);
      expect(checksForPair).toBe(2);
    } finally {
      spy.mockRestore();
      fix.cleanup();
    }
  });

  it('reapIdleRuntimes re-reads live cache before each stop after await gaps', async () => {
    const fix = makeFixture();
    try {
      const secondAgent = new AgentRepo(fix.db).create(
        { name: 'agent-2', runtime: 'claude', host_id: fix.hostId },
        fix.hostId,
        fix.viewerUserId,
      );
      new ConversationRepo(fix.db).addAgent(fix.channelId, secondAgent.id);
      new ConversationRepo(fix.db).updateAgentRuntime(fix.channelId, secondAgent.id, {
        status: 'active',
      });
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
            lastActivityAt: 1700000000000,
          }),
          runtimeDto(fix.channelId, secondAgent.id, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: secondAgent.id,
            status: 'idle',
            lastActivityAt: 1700000000000,
          }),
        ],
      };
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.fanout.getAgentRunStates(fix.channelId).length === 2);

      fix.transport.deferNextStop();
      const sweep = fix.fanout.reapIdleRuntimes({
        ttlMs: 30 * 60_000,
        now: 1700000000000 + 31 * 60_000,
      });
      await waitFor(() => fix.transport.stopCalls().length === 1);

      fix.fanout.onEvent(
        fix.hostId,
        {
          direction: 'daemon_to_server',
          type: 'event',
          kind: 'runtime_state',
          conversation_id: fix.channelId,
          agent_id: secondAgent.id,
          state: {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: secondAgent.id,
            status: 'thinking',
            updatedAt: 1700000001000,
            lastActivityAt: 1700000001000,
          },
          ts: 1700000001000,
        },
        'conn-1',
      );

      fix.transport.resolveDeferredStop({});
      await expect(sweep).resolves.toMatchObject({
        considered: 2,
        eligible: 1,
        reaped: 1,
        failed: 0,
      });
      expect(fix.transport.stopCalls()).toHaveLength(1);
      expect(fix.transport.stopCalls()[0]!.params).toMatchObject({
        agent_id: fix.agentId,
      });
    } finally {
      fix.cleanup();
    }
  });

  it('reapIdleRuntimes logs stop failures and continues other candidates', async () => {
    const fix = makeFixture();
    try {
      const secondAgent = new AgentRepo(fix.db).create(
        { name: 'agent-2', runtime: 'claude', host_id: fix.hostId },
        fix.hostId,
        fix.viewerUserId,
      );
      new ConversationRepo(fix.db).addAgent(fix.channelId, secondAgent.id);
      new ConversationRepo(fix.db).updateAgentRuntime(fix.channelId, secondAgent.id, {
        status: 'active',
      });
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
            lastActivityAt: 1700000000000,
          }),
          runtimeDto(fix.channelId, secondAgent.id, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: secondAgent.id,
            status: 'idle',
            lastActivityAt: 1700000000000,
          }),
        ],
      };
      fix.transport.rejectNextStop(new Error('stop failed'));
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.fanout.getAgentRunStates(fix.channelId).length === 2);

      const result = await fix.fanout.reapIdleRuntimes({
        ttlMs: 30 * 60_000,
        now: 1700000000000 + 31 * 60_000,
      });

      expect(result).toMatchObject({
        considered: 2,
        eligible: 2,
        reaped: 1,
        failed: 1,
      });
      expect(fix.transport.stopCalls()).toHaveLength(2);
    } finally {
      fix.cleanup();
    }
  });

  // D4.c C7 — clearSession bounded-wait for runtime_exit projection.
  // Cindy `szDHSdeKwtEUlxZb` P1 + `nPqEVJjCLjuNDH-6` final.
  //
  // Four behaviors pinned here:
  //
  //   1. ack → exit lands → DB falls (prev session id cleared, audit
  //      message inserted, agent_status SSE published).
  //   2. ack → exit timeout → typed `ClearSessionExitTimeoutError`,
  //      DB UNCHANGED (no cli_session_id clear, no audit row).
  //   3. wasRunning=false fast path: cache empty → skip wait,
  //      proceed to DB tx; audit still fires when prev session id
  //      was non-null.
  //   4. concurrent same-(cid, aid) → fail-fast typed
  //      `ClearSessionInProgressError`. After the first call's
  //      `finally` cleanup runs, the lock releases and a third call
  //      can succeed.
  describe('clearSession (D4.c C7)', () => {
    it('clears cli_session_id + inserts audit + publishes SSE when runtime_exit lands within bound', async () => {
      const fix = makeFixture({ clearSessionExitTimeoutMs: 200 });
      try {
        // 1. Seed a running runtime (cache shows phase='ready').
        fix.transport.snapshot = {
          runtimes: [
            runtimeDto(fix.channelId, fix.agentId, 'ready', {
              ...RUN_STATE,
              conversationId: fix.channelId,
              agentId: fix.agentId,
              status: 'thinking',
            }),
          ],
        };
        fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
        await waitFor(
          () => fix.fanout.getAgentRunStates(fix.channelId).length === 1,
        );

        // 2. Seed a known cli_session_id so the audit row fires.
        new ConversationRepo(fix.db).updateAgentRuntime(
          fix.channelId,
          fix.agentId,
          { cliSessionId: 'sess-abcdef-12345' },
        );

        // 3. Capture only post-clearSession events.
        fix.events.length = 0;

        // 4. Kick off clearSession; it parks on the runtime_exit
        //    waiter. After dispatch microtasks settle, emit the exit
        //    event so the waiter resolves.
        const promise = fix.fanout.clearSession(
          fix.channelId,
          fix.agentId,
          null,
        );
        await new Promise(resolve => setImmediate(resolve));
        emitRuntimeExit(fix);

        const result = await promise;
        expect(result).toEqual({
          prevCliSessionId: 'sess-abcdef-12345',
          wasRunning: true,
        });

        // 5. Wire shape — `runtime_clear_session` was dispatched
        //    with the exact (cid, aid) pair, no extra fields.
        const clearCalls = fix.transport.clearSessionCalls();
        expect(clearCalls).toHaveLength(1);
        expect(clearCalls[0]!.params).toEqual({
          conversation_id: fix.channelId,
          agent_id: fix.agentId,
        });

        // 6. DB tx landed.
        expect(fix.row().cli_session_id).toBeNull();

        // 7. Audit message published as a `message` SSE.
        const messageEvents = fix.events.filter(
          e => e.kind === 'message' && e.conv === fix.channelId,
        );
        expect(messageEvents).toHaveLength(1);
        const auditMessage = (
          messageEvents[0]!.payload as {
            message: { metadata: Record<string, unknown> | null };
          }
        ).message;
        expect(auditMessage.metadata).toMatchObject({
          subtype: 'session_cleared',
          previous_cli_session_id_prefix: 'sess-abc',
          was_running: true,
        });

        // 8. agent_status SSE includes a payload with cli_session_id=null.
        const statusEvents = fix.events.filter(
          e => e.kind === 'agent_status' && e.conv === fix.channelId,
        );
        expect(
          statusEvents.some(
            e =>
              (e.payload as { cli_session_id: string | null })
                .cli_session_id === null,
          ),
        ).toBe(true);
      } finally {
        fix.cleanup();
      }
    });

    it('rejects with ClearSessionExitTimeoutError when runtime_exit does not land in time; DB UNCHANGED', async () => {
      const fix = makeFixture({ clearSessionExitTimeoutMs: 30 });
      try {
        fix.transport.snapshot = {
          runtimes: [
            runtimeDto(fix.channelId, fix.agentId, 'ready', {
              ...RUN_STATE,
              conversationId: fix.channelId,
              agentId: fix.agentId,
              status: 'thinking',
            }),
          ],
        };
        fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
        await waitFor(
          () => fix.fanout.getAgentRunStates(fix.channelId).length === 1,
        );

        new ConversationRepo(fix.db).updateAgentRuntime(
          fix.channelId,
          fix.agentId,
          { cliSessionId: 'sess-old' },
        );

        fix.events.length = 0;

        // No emitRuntimeExit — the waiter must time out.
        await expect(
          fix.fanout.clearSession(fix.channelId, fix.agentId, null),
        ).rejects.toBeInstanceOf(ClearSessionExitTimeoutError);

        // DB UNCHANGED: prev cli_session_id intact, no audit.
        expect(fix.row().cli_session_id).toBe('sess-old');
        expect(
          fix.events.filter(e => e.kind === 'message'),
        ).toHaveLength(0);
        expect(
          fix.events.filter(e => e.kind === 'agent_status'),
        ).toHaveLength(0);

        // The waiter map must have been cleaned up via `finally`,
        // so a follow-up clearSession on the same pair gets past
        // the in-progress check (it'll then time out again, which
        // is fine — we only assert it does NOT reject as
        // `ClearSessionInProgressError`).
        await expect(
          fix.fanout.clearSession(fix.channelId, fix.agentId, null),
        ).rejects.not.toBeInstanceOf(ClearSessionInProgressError);
      } finally {
        fix.cleanup();
      }
    });

    it('skips bounded wait when cache shows runtime is not running; DB tx still fires audit if prevCliSessionId !== null', async () => {
      const fix = makeFixture({ clearSessionExitTimeoutMs: 5_000 });
      try {
        // Hydrate empty snapshot — cache stays empty so wasRunning=false.
        fix.transport.snapshot = { runtimes: [] };
        fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
        // No need to wait — empty hydrate is a no-op for cache.

        new ConversationRepo(fix.db).updateAgentRuntime(
          fix.channelId,
          fix.agentId,
          { cliSessionId: 'sess-orphan' },
        );

        // Daemon authoritatively reports `cleared:false` — handle
        // absent on its side. Backend's fast path skips the bounded
        // wait. Cindy `Z3drVLxYkw5GUvGd` P1: only `cleared:false`
        // is a legitimate fast-path source; cache state alone is
        // not.
        fix.transport.setNextClearResult({ cleared: false });

        fix.events.length = 0;

        const result = await fix.fanout.clearSession(
          fix.channelId,
          fix.agentId,
          null,
        );
        expect(result).toEqual({
          prevCliSessionId: 'sess-orphan',
          wasRunning: false,
        });

        // DB still cleared, audit still fires (prevCliSessionId was
        // non-null — the user explicitly asked for a fresh session).
        expect(fix.row().cli_session_id).toBeNull();
        expect(
          fix.events.filter(e => e.kind === 'message'),
        ).toHaveLength(1);
      } finally {
        fix.cleanup();
      }
    });

    // D4.c C7 round-2 (Cindy `Z3drVLxYkw5GUvGd` P1) regression.
    //
    // The earlier C7 implementation gated the bounded wait on
    // backend cache state (`wasRunning && stillRunningAfterDispatch`).
    // That broke the contract whenever the cache was stale: a
    // backend restart / pre-hydrate window / recent disconnect can
    // leave the cache empty even though the daemon still owns a
    // live handle. With `cleared:true` from the daemon, the DB tx
    // would commit before `runtime_exit` landed — defeating the
    // reason C7 introduced the bounded wait at all.
    //
    // Round-2 fix: only `result.cleared === false` is a legitimate
    // fast-path skip. `cleared:true` always enters the wait, even
    // when the cache currently reports nothing. This regression
    // pins the new behavior — without it, the previous logic
    // would silently 200 + clear the DB.
    it('cache empty + daemon ack {cleared:true} + no runtime_exit → ClearSessionExitTimeoutError + DB UNCHANGED (Cindy round-2 P1 regression)', async () => {
      const fix = makeFixture({ clearSessionExitTimeoutMs: 30 });
      try {
        // Empty snapshot — cache is empty across the entire test.
        // No `readyEvent` either, so we don't even hydrate; the
        // daemon-instance key is unset. This simulates a
        // backend-restart-style stale view where the cache cannot
        // be trusted as a "no live runtime" oracle.
        fix.transport.snapshot = { runtimes: [] };

        new ConversationRepo(fix.db).updateAgentRuntime(
          fix.channelId,
          fix.agentId,
          { cliSessionId: 'sess-pre-restart' },
        );

        // Daemon authoritatively says it DID hold a handle and
        // triggered the kill — a `runtime_exit` is on its way.
        fix.transport.setNextClearResult({ cleared: true });

        fix.events.length = 0;

        // No `emitRuntimeExit(fix)` — the bound must elapse and
        // `clearSession` must throw, NOT fast-path via the
        // (formerly cache-derived) `wasRunning` check.
        await expect(
          fix.fanout.clearSession(fix.channelId, fix.agentId, null),
        ).rejects.toBeInstanceOf(ClearSessionExitTimeoutError);

        // DB UNCHANGED: cli_session_id intact, no audit row, no SSE.
        expect(fix.row().cli_session_id).toBe('sess-pre-restart');
        expect(
          fix.events.filter(e => e.kind === 'message'),
        ).toHaveLength(0);
        expect(
          fix.events.filter(e => e.kind === 'agent_status'),
        ).toHaveLength(0);
      } finally {
        fix.cleanup();
      }
    });

    it('rejects concurrent clearSession on same (cid, aid) with ClearSessionInProgressError; finally cleanup releases the lock', async () => {
      const fix = makeFixture({ clearSessionExitTimeoutMs: 30 });
      try {
        fix.transport.snapshot = {
          runtimes: [
            runtimeDto(fix.channelId, fix.agentId, 'ready', {
              ...RUN_STATE,
              conversationId: fix.channelId,
              agentId: fix.agentId,
              status: 'thinking',
            }),
          ],
        };
        fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
        await waitFor(
          () => fix.fanout.getAgentRunStates(fix.channelId).length === 1,
        );

        // First call parks on the waiter (no runtime_exit emitted).
        const first = fix.fanout.clearSession(
          fix.channelId,
          fix.agentId,
          null,
        );

        // Concurrent same-pair call must fast-fail typed.
        await expect(
          fix.fanout.clearSession(fix.channelId, fix.agentId, null),
        ).rejects.toBeInstanceOf(ClearSessionInProgressError);

        // Drain the first call's timeout so its `finally` runs.
        await expect(first).rejects.toBeInstanceOf(
          ClearSessionExitTimeoutError,
        );

        // After `finally`, the lock is released. Demonstrate by
        // running a third call on the same pair that lands the
        // happy path: emit runtime_exit so it resolves.
        const third = fix.fanout.clearSession(
          fix.channelId,
          fix.agentId,
          null,
        );
        await new Promise(resolve => setImmediate(resolve));
        emitRuntimeExit(fix);
        await expect(third).resolves.toEqual({
          // runtime_exit clears the cache → wasRunning depends on
          // whether the cache was still 'ready' at clearSession entry.
          // For this assertion we only care it didn't reject as
          // ClearSessionInProgress.
          prevCliSessionId: null,
          wasRunning: expect.any(Boolean),
        });
      } finally {
        fix.cleanup();
      }
    });
  });
});

function emitRuntimeExit(fix: Fixture): void {
  fix.fanout.onEvent(
    fix.hostId,
    {
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_exit',
      conversation_id: fix.channelId,
      agent_id: fix.agentId,
      code: 0,
      intentional: true,
      ts: 1700000010000,
    },
    'conn-1',
  );
}

/**
 * The state the delete-computer cascade leaves behind at teardown time
 * (#task:1616): its workspaces, agents and the host row are all gone, committed
 * as one transaction. Order follows the FK graph (agents and workspaces both
 * reference `hosts`).
 */
function deleteComputerRows(fix: Fixture): void {
  fix.db.prepare('DELETE FROM agents WHERE host_id = ?').run(fix.hostId);
  fix.db
    .prepare('DELETE FROM workspaces WHERE workspace_host_id = ?')
    .run(fix.hostId);
  fix.db.prepare('DELETE FROM hosts WHERE id = ?').run(fix.hostId);
}

async function hydrateRuntime(
  fix: Fixture,
  phase: 'idle' | 'spawning' | 'startup_pending' | 'ready' | 'draining' | 'exited',
  runState: Partial<AgentRunState>,
): Promise<void> {
  fix.transport.snapshot = {
    runtimes: [
      runtimeDto(fix.channelId, fix.agentId, phase, {
        ...RUN_STATE,
        conversationId: fix.channelId,
        agentId: fix.agentId,
        ...runState,
      }),
    ],
  };
  fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
  await waitFor(() => fix.fanout.getAgentRunStates(fix.channelId).length === 1);
}

interface Fixture {
  db: ReturnType<typeof openTestDb>['db'];
  hostId: string;
  viewerUserId: string;
  channelId: string;
  workspaceId: string;
  agentId: string;
  events: Array<{ conv: string; kind: string; payload: unknown }>;
  messages: MessageRepo;
  inbox: ConversationInboxRepo;
  conversations: ConversationRepo;
  transport: FakeTransport;
  fanout: OutboundRuntimeEventFanout;
  row(): { status: string; pid: number | null; cli_session_id: string | null };
  cleanup(): void;
}

function makeFixture(
  opts: {
    runtime?: RuntimeKind;
    clearSessionExitTimeoutMs?: number;
    logger?: typeof SILENT_LOGGER;
    agentL2SeedEnsurer?:
      | ((ctx: { transport: FakeTransport }) => AgentL2SeedEnsurer)
      | null;
    coLocatedHostId?: string | null;
    publishHostScopeEvent?: (
      ownerUserId: string,
      kind: string,
      payload: unknown,
    ) => void;
    onHostReady?: (hostId: string) => void;
  } = {},
): Fixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspacePath = testWorkspacePath('fanout-ws');
  const workspace = workspaces.insert({
    name: 'fanout-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 'fanout',
  });
  const agent = new AgentRepo(db).create(
    { name: 'agent', runtime: opts.runtime ?? 'claude', host_id: localHostId },
    localHostId,
    viewerUserId,
  );
  conversations.addAgent(channel.id, agent.id);
  conversations.updateAgentRuntime(channel.id, agent.id, {
    status: 'starting',
  });

  const events: Fixture['events'] = [];
  const publisher: EventPublisher = {
    publish: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
    publishSide: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
  };
  const transport = new FakeTransport();
  // #task:1596/#task:1612 — the L2 seed dep is LOAD-BEARING for regular
  // spawns (missing → fail closed), so the fixture defaults to a
  // permissive in-memory fake. A test opts into the real class (wired to
  // the fake transport) or into `null` to exercise the fail-closed arm.
  const seedEnsurer =
    opts.agentL2SeedEnsurer === null
      ? undefined
      : opts.agentL2SeedEnsurer?.({ transport }) ??
        ({
          ensure: async () => ({ ok: true }),
        } as unknown as AgentL2SeedEnsurer);
  const fanout = new OutboundRuntimeEventFanout({
    db,
    events: publisher,
    transport: () => transport,
    logger: opts.logger ?? SILENT_LOGGER,
    silverhandCli: { command: 'silverhand', args: [] },
    ...(opts.coLocatedHostId === null
      ? {}
      : { coLocatedHostId: opts.coLocatedHostId ?? localHostId }),
    agentTokens: new AgentTokenStore(),
    activityLog: null,
    ...(seedEnsurer ? { agentL2SeedEnsurer: seedEnsurer } : {}),
    ...(opts.clearSessionExitTimeoutMs !== undefined
      ? { clearSessionExitTimeoutMs: opts.clearSessionExitTimeoutMs }
      : {}),
    ...(opts.publishHostScopeEvent
      ? { publishHostScopeEvent: opts.publishHostScopeEvent }
      : {}),
    ...(opts.onHostReady ? { onHostReady: opts.onHostReady } : {}),
  });
  const messages = new MessageRepo(db);
  const inbox = new ConversationInboxRepo(db);

  return {
    db,
    hostId: localHostId,
    viewerUserId,
    channelId: channel.id,
    workspaceId: workspace.id,
    agentId: agent.id,
    events,
    messages,
    inbox,
    conversations,
    transport,
    fanout,
    row: () => {
      const row = conversations.getAgent(channel.id, agent.id);
      if (!row) throw new Error('conversation agent row missing');
      return {
        status: row.status,
        pid: row.pid,
        cli_session_id: row.cli_session_id,
      };
    },
    cleanup: () => {
      db.close();
    },
  };
}

function makeUnixHandler(fix: Fixture): RuntimeEventHandler {
  return new RuntimeEventHandler({
    client: { subscribe: () => () => {}, onReconnect: () => () => {} } as never,
    bridge: { runtimeStatus: async () => ({ runtimes: [] }) },
    cache: new RunStateCache(),
    events: {
      publish: (conv, payload) =>
        fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
      publishSide: (conv, payload) =>
        fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
    },
    inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
    statusProjector: new DbRuntimeStatusProjector(
      new ConversationRepo(fix.db),
      {
        publish: (conv, payload) =>
          fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
        publishSide: (conv, payload) =>
          fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
      },
    ),
    conversationActivity: new ConversationEventRepo(fix.db),
    logger: SILENT_LOGGER,
  });
}

function normalizeEvents(events: Fixture['events'], fix: Fixture): Fixture['events'] {
  return events.map(event => ({
    conv: event.conv === fix.channelId ? '<conversation>' : event.conv,
    kind: event.kind,
    payload: replaceIds(event.payload, fix),
  }));
}

function replaceIds(value: unknown, fix: Fixture): unknown {
  if (Array.isArray(value)) return value.map(item => replaceIds(item, fix));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === fix.agentId) out[key] = '<agent>';
    else if (raw === fix.channelId) out[key] = '<conversation>';
    else out[key] = replaceIds(raw, fix);
  }
  return out;
}

function enqueueMessage(fix: Fixture, content: string): { inboxId: number } {
  const msg = fix.messages.insertForConversation({
    conversationId: fix.channelId,
    fromKind: 'user',
    content,
  });
  return fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);
}

class FakeTransport implements HostWsServerController {
  calls: Array<{
    hostId: string;
    kind: string;
    params: Record<string, unknown>;
    opts?: { expectedConnectionId?: string };
  }> = [];
  snapshot: RuntimeStatusResult = { runtimes: [] };
  connectionId = 'conn-1';
  private deferredDeliver:
    | {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
      }
    | null = null;
  private nextDeliverError: Error | null = null;
  private nextDeliverRefusal:
    | {
        reason: 'startup_pending' | 'draining' | 'cooldown';
        cooldownUntil?: number;
      }
    | null = null;
  // When set, the next `runtime_deliver` returns this custody disposition
  // instead of the default `spawning`. `admitted` models a live handle that
  // accepted the batch; `spawning` models a fresh spawn-with-batch. Both are
  // `dispatched` to the backend (rows stay in-flight until the async
  // `runtime_delivery_consumed`).
  private nextDeliverDisposition: 'spawning' | 'admitted' | 'deferred' | null = null;
  private nextClearResult: { cleared: boolean } | null = null;
  private nextStopError: Error | null = null;
  private deferredStop:
    | {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
      }
    | null = null;
  // When set, the next `runtime_status` reply hangs until `resolveDeferredStatus`
  // — models the fire-and-forget ready→hydrate window during which the daemon is
  // connected (`currentDaemonKey` set) but `RunStateCache` has NOT yet latched a
  // daemon key. Lets a test drive a `runtime_start` reply into that exact gap.
  private deferredStatus:
    | {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
      }
    | null = null;

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['local'];
  }

  connectionIdForHost(_hostId: string): string | null {
    return this.connectionId;
  }

  getAttachment(hostId: string): HostWsAttachment | null {
    // Fanout-coordinator tests don't depend on boot-readiness wiring, so the
    // default is null. A #task:1486 send-gate test sets `attachmentCapabilities`
    // to model the live daemon's advertised capability set.
    if (this.attachmentCapabilities === null) return null;
    return {
      hostId,
      connectionId: this.connectionId,
      attachedAt: 0,
      hostname: null,
      capabilities: this.attachmentCapabilities,
    };
  }

  attachmentCapabilities: readonly string[] | null = null;

  getAdmissionFailure(): null {
    return null;
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    if (opts?.expectedConnectionId && opts.expectedConnectionId !== this.connectionId) {
      return Promise.reject(new Error('connection changed'));
    }
    this.calls.push({
      hostId,
      kind,
      params: params as Record<string, unknown>,
      ...(opts ? { opts: { expectedConnectionId: opts.expectedConnectionId } } : {}),
    });
    if (kind === 'runtime_status') {
      if (this.deferredStatus) {
        return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
          this.deferredStatus = {
            resolve: value => resolve(value as OutboundServerCommandResult<K>),
            reject,
          };
        });
      }
      return Promise.resolve(this.snapshot) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_deliver') {
      // #task:1417 Stage 2b — `runtime_deliver` is the SOLE message delivery
      // command. Its sync result is a custody DISPOSITION; the daemon owns
      // spawn-vs-admit-vs-refuse. The async ack is `runtime_delivery_consumed`.
      if (this.nextDeliverError) {
        const err = this.nextDeliverError;
        this.nextDeliverError = null;
        return Promise.reject(err);
      }
      if (this.nextDeliverRefusal) {
        const refusal = this.nextDeliverRefusal;
        this.nextDeliverRefusal = null;
        return Promise.resolve(
          refusal.reason === 'cooldown'
            ? {
                disposition: 'refused',
                reason: 'cooldown',
                cooldown_until: refusal.cooldownUntil ?? 9_999_999,
              }
            : { disposition: 'refused', reason: refusal.reason },
        ) as Promise<OutboundServerCommandResult<K>>;
      }
      if (this.deferredDeliver) {
        return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
          this.deferredDeliver = {
            resolve: value => resolve(value as OutboundServerCommandResult<K>),
            reject,
          };
        });
      }
      const disposition = this.nextDeliverDisposition ?? 'spawning';
      this.nextDeliverDisposition = null;
      return Promise.resolve({
        disposition,
        pid: 123,
        started_at: 1700000000000,
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_start') {
      // #task:1417 Stage 2b — `runtime_start` is now a PURE lifecycle spawn
      // (no `startup_delivery`; delivery goes through `runtime_deliver`). Used
      // only by `startDirect` for an explicit start with an empty inbox.
      return Promise.resolve({
        started: true,
        pid: 123,
        started_at: 1700000000000,
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'workspace_provision') {
      // Establishment-time provision ack (#task:1612 — the only provision
      // flows left are workspace creation and guest membership); the daemon
      // ack is the authoritative bound path (here, the requested path,
      // idempotently).
      const requested = (params as { requested_path?: string }).requested_path;
      return Promise.resolve({
        ok: true,
        provisioned: true,
        bound_workspace_path: requested ?? '/host/ws/provisioned',
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'agent_l2_seed') {
      // #task:1596 — the pre-spawn L2 seed on the dispatch host; idempotent
      // daemon-side (writeIfMissing).
      return Promise.resolve({
        ok: true,
        seeded: true,
        l2_present: true,
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_clear_session') {
      // D4.c C7 — `runtime_clear_session` returns `{ cleared }`.
      // Tests inject `nextClearResult` to drive `cleared:false`
      // (handle absent) without rewriting the whole transport.
      const next = this.nextClearResult ?? { cleared: true };
      this.nextClearResult = null;
      return Promise.resolve(next) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_stop' && this.nextStopError) {
      const err = this.nextStopError;
      this.nextStopError = null;
      return Promise.reject(err);
    }
    if (kind === 'runtime_stop' && this.deferredStop) {
      return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
        this.deferredStop = {
          resolve: value => resolve(value as OutboundServerCommandResult<K>),
          reject,
        };
      });
    }
    return Promise.resolve({}) as Promise<OutboundServerCommandResult<K>>;
  }

  setNextClearResult(result: { cleared: boolean }): void {
    this.nextClearResult = result;
  }

  clearSessionCalls(): Array<{ params: Record<string, unknown> }> {
    return this.calls.filter(call => call.kind === 'runtime_clear_session');
  }

  deliverCalls(): Array<{ params: Record<string, unknown>; opts?: { expectedConnectionId?: string } }> {
    return this.calls.filter(call => call.kind === 'runtime_deliver');
  }

  stopCalls(): Array<{
    params: Record<string, unknown>;
    opts?: { expectedConnectionId?: string };
  }> {
    return this.calls.filter(call => call.kind === 'runtime_stop');
  }

  deferNextDeliver(): void {
    this.deferredDeliver = {
      resolve: () => {},
      reject: () => {},
    };
  }

  resolveDeferredDeliver(value: unknown): void {
    const deferred = this.deferredDeliver;
    this.deferredDeliver = null;
    deferred?.resolve(value);
  }

  rejectDeferredDeliver(err: Error): void {
    const deferred = this.deferredDeliver;
    this.deferredDeliver = null;
    deferred?.reject(err);
  }

  rejectNextDeliver(err: Error): void {
    this.nextDeliverError = err;
  }

  rejectNextStop(err: Error): void {
    this.nextStopError = err;
  }

  deferNextStop(): void {
    this.deferredStop = {
      resolve: () => {},
      reject: () => {},
    };
  }

  resolveDeferredStop(value: unknown): void {
    const deferred = this.deferredStop;
    this.deferredStop = null;
    deferred?.resolve(value);
  }

  deferNextStatus(): void {
    this.deferredStatus = {
      resolve: () => {},
      reject: () => {},
    };
  }

  resolveDeferredStatus(value: unknown): void {
    const deferred = this.deferredStatus;
    this.deferredStatus = null;
    deferred?.resolve(value);
  }

  /** Next `runtime_deliver` refuses custody with this reason (rows roll
   *  back to pending, retriable). `cooldown` carries a future epoch ms. */
  refuseNextDeliver(
    reason: 'startup_pending' | 'draining' | 'cooldown',
    cooldownUntil?: number,
  ): void {
    this.nextDeliverRefusal = { reason, ...(cooldownUntil !== undefined ? { cooldownUntil } : {}) };
  }

  /** Next `runtime_deliver` reports this disposition (`admitted` = live
   *  handle accepted; `spawning` = fresh spawn-with-batch; `deferred` = live
   *  handle parked the write in its own mid-turn queue, #task:1417 Stage 3).
   *  All three are `dispatched` at the backend (row stays in-flight until the
   *  async `runtime_delivery_consumed` / `runtime_delivery_failed`). Defaults
   *  to `spawning`. */
  setNextDeliverDisposition(
    disposition: 'spawning' | 'admitted' | 'deferred',
  ): void {
    this.nextDeliverDisposition = disposition;
  }

  startCalls(): Array<{ params: Record<string, unknown> }> {
    return this.calls.filter(call => call.kind === 'runtime_start');
  }

  // D4.c C2 — fanout-coordinator tests don't drive the revoke route.
  disconnectHost(_hostId: string): boolean {
    return false;
  }

  async close(): Promise<void> {
    // no-op
  }
}

const RUN_STATE: AgentRunState = {
  runId: 'r1',
  agentId: 'agent',
  conversationId: 'conversation',
  status: 'thinking',
  startedAt: 1700000000000,
  updatedAt: 1700000000000,
  lastActivityAt: 1700000000000,
};

function runtimeDto(
  conversationId: string,
  agentId: string,
  phase: 'idle' | 'spawning' | 'startup_pending' | 'ready' | 'draining' | 'exited',
  runState: AgentRunState,
): RuntimeStatusResult['runtimes'][number] {
  return {
    conversation_id: conversationId,
    agent_id: agentId,
    pid: 123,
    phase,
    run_state: runState,
    started_at: 1700000000000,
  };
}

function readyEvent(overrides?: {
  capabilities?: string[];
  started_at?: number;
}): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: OUTBOUND_PROTOCOL_VERSION,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: 'instance-1',
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: overrides?.capabilities ?? [...KNOWN_CAPABILITIES_V1],
    daemon_pid: 123,
    started_at: overrides?.started_at ?? 1700000000000,
  };
}

function readyForDrainEvent(fix: Fixture): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_ready_for_drain',
    conversation_id: fix.channelId,
    agent_id: fix.agentId,
    ts: 1700000001000,
  };
}

function outboundEventFixture(kind: OutboundDaemonEventKind): OutboundDaemonToServerEventFrame {
  switch (kind) {
    case 'ready':
      return readyEvent();
    case 'shutting_down':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        reason: 'test',
      };
    case 'runtime_state':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        state: RUN_STATE,
        ts: 1700000000000,
      };
    case 'runtime_output':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        stream: 'stdout',
        chunk: 'hello',
        ts: 1700000000000,
      };
    case 'runtime_exit':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        code: 0,
        intentional: true,
        ts: 1700000000000,
      };
    case 'runtime_ready_for_drain':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        ts: 1700000000000,
      };
    case 'runtime_delivery_consumed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        ts: 1700000000000,
      };
    case 'runtime_delivery_failed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        reason: 'write_failed',
        ts: 1700000000000,
      };
    case 'runtime_init_timeout':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        timeout_reason: 'silence',
        elapsed_ms: 1000,
        timeout_ms: 30000,
        retrying: true,
        retry_attempt: 1,
        max_retries: 3,
        ts: 1700000000000,
      };
    case 'runtime_init_retrying':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        retry_attempt: 1,
        max_retries: 3,
        delay_ms: 1000,
        ts: 1700000000000,
      };
    case 'runtime_init_cooldown':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        cooldown_until: 1700000100000,
        attempts_exhausted: 3,
        ts: 1700000000000,
      };
    case 'runtime_compaction_stale':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        elapsed_ms: 1000,
        ts: 1700000000000,
      };
    case 'runtime_output_dropped':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        dropped_count: 1,
        bytes_dropped: 100,
        since_ts: 1700000000000,
      };
    case 'runtime_output_paused':
    case 'runtime_output_resumed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
      };
    case 'runtime_parsed_event':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed: { kind: 'session_init', sessionId: 'sess-1' },
        ts: 1700000000000,
      };
    case 'runtime_parsed_event_dropped':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed_kind: 'tool_call',
        encoded_bytes: 1000000,
        reason: 'frame_too_large',
        ts: 1700000000000,
      };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled outbound event kind ${_exhaustive}`);
    }
  }
}

const SILENT_LOGGER = {
  info(..._args: unknown[]) {},
  warn(..._args: unknown[]) {},
  error(..._args: unknown[]) {},
};

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('layout-v2 migration observation log (#task:1613)', () => {
  // The wire tokens are pinned LITERALLY here (not via the host helper) so
  // a silent rename on either side of the capability contract fails a test.
  const MIGRATED_TOKEN = 'layout_migration.v2.migrated';
  const ALREADY_CURRENT_TOKEN = 'layout_migration.v2.already_current';

  function collectingLogger() {
    const entries: { fields: Record<string, unknown>; msg: unknown }[] = [];
    return {
      entries,
      logger: {
        info(...args: unknown[]) {
          entries.push({
            fields: args[0] as Record<string, unknown>,
            msg: args[1],
          });
        },
        warn(..._args: unknown[]) {},
        error(..._args: unknown[]) {},
      },
    };
  }

  function layoutLogs(entries: { fields: Record<string, unknown> }[]) {
    return entries.filter(e => e.fields?.action === 'layout_migration_status');
  }

  it('logs migrated ONCE per daemon boot — a reconnect of the same boot does not re-log', async () => {
    const { entries, logger } = collectingLogger();
    const fix = makeFixture({ logger });
    try {
      const caps = [...KNOWN_CAPABILITIES_V1, MIGRATED_TOKEN];
      fix.fanout.onEvent(fix.hostId, readyEvent({ capabilities: caps }), 'conn-1');
      expect(layoutLogs(entries)).toHaveLength(1);
      expect(layoutLogs(entries)[0]!.fields).toMatchObject({
        action: 'layout_migration_status',
        hostId: fix.hostId,
        outcome: 'migrated',
        layoutVersion: 2,
        daemonVersion: '0.0.0-test',
      });

      // Same daemon boot (same pid+started_at) reconnecting on a fresh
      // socket must NOT produce a second observation line.
      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(fix.hostId, readyEvent({ capabilities: caps }), 'conn-2');
      expect(layoutLogs(entries)).toHaveLength(1);
    } finally {
      fix.cleanup();
    }
  });

  it('logs already_current, and a NEW daemon boot is logged again', async () => {
    const { entries, logger } = collectingLogger();
    const fix = makeFixture({ logger });
    try {
      const caps = [...KNOWN_CAPABILITIES_V1, ALREADY_CURRENT_TOKEN];
      fix.fanout.onEvent(fix.hostId, readyEvent({ capabilities: caps }), 'conn-1');
      expect(layoutLogs(entries)).toHaveLength(1);
      expect(layoutLogs(entries)[0]!.fields).toMatchObject({
        outcome: 'already_current',
      });

      // A different boot generation (new started_at) is a new observation.
      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(
        fix.hostId,
        readyEvent({ capabilities: caps, started_at: 1700000009999 }),
        'conn-2',
      );
      expect(layoutLogs(entries)).toHaveLength(2);
    } finally {
      fix.cleanup();
    }
  });

  it('a ready WITHOUT a layout token (pre-#1613 daemon) logs nothing — unobserved, never migrated', async () => {
    const { entries, logger } = collectingLogger();
    const fix = makeFixture({ logger });
    try {
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      expect(layoutLogs(entries)).toHaveLength(0);
    } finally {
      fix.cleanup();
    }
  });

  it('BOTH tokens at once is malformed evidence: warned, never logged as a success status', async () => {
    const entries: { level: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      info(...args: unknown[]) {
        entries.push({ level: 'info', fields: args[0] as Record<string, unknown> });
      },
      warn(...args: unknown[]) {
        entries.push({ level: 'warn', fields: args[0] as Record<string, unknown> });
      },
      error(..._args: unknown[]) {},
    };
    const fix = makeFixture({ logger });
    try {
      const caps = [...KNOWN_CAPABILITIES_V1, MIGRATED_TOKEN, ALREADY_CURRENT_TOKEN];
      fix.fanout.onEvent(fix.hostId, readyEvent({ capabilities: caps }), 'conn-1');
      // No success status may land for contradictory evidence.
      expect(
        entries.filter(
          e => e.level === 'info' && e.fields?.action === 'layout_migration_status',
        ),
      ).toHaveLength(0);
      const warns = entries.filter(
        e =>
          e.level === 'warn' &&
          e.fields?.action === 'layout_migration_status_contradictory',
      );
      expect(warns).toHaveLength(1);
      expect(warns[0]!.fields).toMatchObject({ hostId: fix.hostId });

      // Reconnect of the same boot does not repeat the warn either.
      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(fix.hostId, readyEvent({ capabilities: caps }), 'conn-2');
      expect(
        entries.filter(
          e => e.fields?.action === 'layout_migration_status_contradictory',
        ),
      ).toHaveLength(1);
    } finally {
      fix.cleanup();
    }
  });
});

describe('host agent liveness event + eager seed (#task:1588 slice 2)', () => {
  function stateEvent(
    fix: Fixture,
    status: 'thinking',
    ts: number,
  ): OutboundDaemonToServerEventFrame {
    return {
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_state',
      conversation_id: fix.channelId,
      agent_id: fix.agentId,
      state: {
        ...RUN_STATE,
        conversationId: fix.channelId,
        agentId: fix.agentId,
        status,
        updatedAt: ts,
        lastActivityAt: ts,
      },
      ts,
    };
  }

  function exitEvent(fix: Fixture, ts: number): OutboundDaemonToServerEventFrame {
    return {
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_exit',
      conversation_id: fix.channelId,
      agent_id: fix.agentId,
      code: 0,
      intentional: true,
      ts,
    };
  }

  it('fires onHostReady on every daemon ready event', () => {
    const readyHosts: string[] = [];
    const fix = makeFixture({ onHostReady: hostId => readyHosts.push(hostId) });
    fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
    expect(readyHosts).toEqual([fix.hostId]);
    fix.transport.connectionId = 'conn-2';
    fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-2');
    expect(readyHosts).toEqual([fix.hostId, fix.hostId]);
  });

  /** The fixture's local host starts unclaimed (`user_id` null) — an
   *  ownerless host publishes nothing (nobody to notify). Claim it for
   *  the viewer so the owner-scope publish path is exercised. */
  function claimHostForViewer(fix: Fixture): void {
    fix.db
      .prepare('UPDATE hosts SET user_id = ? WHERE id = ?')
      .run(fix.viewerUserId, fix.hostId);
  }

  it('publishes host_agent_liveness_changed to the owner scope only on real set transitions', async () => {
    const published: Array<{ owner: string; kind: string; payload: unknown }> = [];
    const fix = makeFixture({
      publishHostScopeEvent: (owner, kind, payload) =>
        published.push({ owner, kind, payload }),
    });
    claimHostForViewer(fix);

    fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
    // Wait for the async hydrate to land (pre-latch runtime events are
    // dropped by the cache's daemon-key gate).
    await waitFor(
      () =>
        fix.fanout.hostRuntimeView(fix.hostId)?.hydratedForCurrentDaemon ===
        true,
    );
    // Hydrate FORCE-publishes exactly once (Cindy P1-2: the read
    // model's seed→cache authority switch must be observable even when
    // the cache signature didn't move — the seed={A} → hydrate={} shape).
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      owner: fix.viewerUserId,
      kind: 'host_agent_liveness_changed',
      payload: { host_id: fix.hostId },
    });

    // First live runtime → set gains the agent → ONE event.
    fix.fanout.onEvent(fix.hostId, stateEvent(fix, 'thinking', 1700000001000), 'conn-1');
    expect(published).toHaveLength(2);

    // Another state event for the SAME agent: set unchanged → no event
    // (never a per-runtime_state broadcast).
    fix.fanout.onEvent(fix.hostId, stateEvent(fix, 'thinking', 1700000002000), 'conn-1');
    expect(published).toHaveLength(2);

    // Last runtime exits → set empties → ONE more event.
    fix.fanout.onEvent(fix.hostId, exitEvent(fix, 1700000003000), 'conn-1');
    expect(published).toHaveLength(3);
  });

  it('every hydrate force-publishes once even when the cache signature is unchanged (P1-2 authority switch)', async () => {
    const published: string[] = [];
    const fix = makeFixture({
      publishHostScopeEvent: (_owner, kind) => published.push(kind),
    });
    claimHostForViewer(fix);

    fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
    await waitFor(
      () =>
        fix.fanout.hostRuntimeView(fix.hostId)?.hydratedForCurrentDaemon ===
        true,
    );
    expect(published).toHaveLength(1); // empty→empty signature, still forced

    // A NEW daemon generation (different pid) rehydrates: empty→empty
    // again, and the forced publish still fires — clients holding a
    // seed-based response for the new generation must be invalidated.
    fix.transport.connectionId = 'conn-2';
    fix.fanout.onEvent(
      fix.hostId,
      { ...readyEvent(), daemon_pid: 456 } as OutboundDaemonToServerEventFrame,
      'conn-2',
    );
    await waitFor(() => published.length >= 2);
    expect(published).toHaveLength(2);
  });

  it('disconnect empties the set and publishes once', async () => {
    const published: string[] = [];
    const fix = makeFixture({
      publishHostScopeEvent: (_owner, kind) => published.push(kind),
    });
    claimHostForViewer(fix);

    fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
    await waitFor(
      () =>
        fix.fanout.hostRuntimeView(fix.hostId)?.hydratedForCurrentDaemon ===
        true,
    );
    // 1 forced hydrate publish + 1 for the runtime coming up.
    fix.fanout.onEvent(fix.hostId, stateEvent(fix, 'thinking', 1700000001000), 'conn-1');
    expect(published).toHaveLength(2);

    fix.fanout.onDisconnect(fix.hostId, 'conn-1');
    expect(published).toHaveLength(3);

    // A second disconnect for an already-empty set publishes nothing.
    fix.fanout.onDisconnect(fix.hostId, 'conn-1');
    expect(published).toHaveLength(3);
  });
});
