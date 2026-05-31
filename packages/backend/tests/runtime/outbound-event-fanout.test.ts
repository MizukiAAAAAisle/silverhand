import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import type { AgentRunState, RuntimeKind } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
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
  DEFAULT_SOFT_DIRECTIVE,
} from '../../src/runtime/agent-runtime-host.js';
import {
  OutboundRuntimeEventFanout,
  outboundEventToEventFrame,
} from '../../src/runtime/outbound-event-fanout.js';
import { WorkspaceRegistryBackfiller } from '../../src/runtime/workspace-registry-backfill.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { DbRuntimeStatusProjector } from '../../src/runtime/status-projector.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
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

  it('marks startup delivery consumed rows delivered from outbound events', () => {
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
        kind: 'runtime_startup_delivery_consumed',
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

  it('leaves startup delivery failed rows pending for backend retry policy', () => {
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
        kind: 'runtime_startup_delivery_failed',
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

  it('drops stale ready_for_drain events and does not pin a live wake to the old connection', async () => {
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
      // state.currentConnectionId back to conn-1 or dispatch a wake
      // pinned to that dead connection.
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await wait(25);
      expect(fix.transport.wakeCalls()).toHaveLength(0);

      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'live after stale event',
      });
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, msg.id);
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_start'),
      );
      const start = fix.transport.calls.find(call => call.kind === 'runtime_start');
      expect(start?.opts?.expectedConnectionId).toBe('conn-2');
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
      expect(fix.transport.calls.some(call => call.kind === 'runtime_wake')).toBe(false);

      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_wake'));

      const wake = fix.transport.calls.find(call => call.kind === 'runtime_wake');
      expect(wake?.params).toMatchObject({
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
      // derived from DB pending. Neither a spawn nor a wake.
      expect(
        fix.transport.calls.some(call => call.kind === 'runtime_start'),
      ).toBe(false);
      expect(fix.transport.wakeCalls()).toHaveLength(0);
      // The backlog stays a durable pending inbox, untouched.
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toHaveLength(1);

      // The user actually sends into this conversation. THAT — and only
      // that — is the activation trigger: exactly one runtime_start for
      // this one pair (the backlog drains with it via startup_delivery).
      const live = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'live send',
      });
      await fix.fanout.deliverMessage(fix.channelId, fix.agentId, live.id);
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_start'),
      );
      expect(
        fix.transport.calls.filter(call => call.kind === 'runtime_start'),
      ).toHaveLength(1);
    } finally {
      fix.cleanup();
    }
  });

  it('claims replay rows FIFO and does not issue concurrent wakes for repeated ready_for_drain', async () => {
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
      fix.transport.deferNextWake();

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.wakeCalls().length === 1);
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await new Promise(resolve => setTimeout(resolve, 25));

      expect(fix.transport.wakeCalls()).toHaveLength(1);
      expect(fix.transport.wakeCalls()[0]!.params).toMatchObject({
        delivery_ids: [first.inboxId, second.inboxId],
      });

      fix.transport.resolveDeferredWake({
        delivered: true,
        delivery_ids: [first.inboxId, second.inboxId],
      });
      await waitFor(() => fix.inbox.listPending(fix.channelId, fix.agentId).length === 0);
    } finally {
      fix.cleanup();
    }
  });

  it('rolls in-flight replay rows back to pending when wake dispatch fails', async () => {
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
      fix.transport.rejectNextWake(new Error('transport_timeout'));

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

  it('keeps replay rows pending when daemon refuses wake delivery', async () => {
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
      fix.transport.refuseNextWake('driver_not_ready');

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

      await waitFor(() => fix.transport.wakeCalls().length === 1);
      expect(fix.transport.wakeCalls()[0]!.params).toMatchObject({
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
      fix.transport.deferNextWake();

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.wakeCalls().length === 1);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);

      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.connectionId = 'conn-2';
      fix.transport.rejectDeferredWake(new Error('transport_disconnected'));
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-2');
      await waitFor(() => fix.transport.calls.filter(call => call.kind === 'runtime_status').length >= 2);
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-2');

      await waitFor(() => fix.transport.wakeCalls().length === 2);
      expect(fix.transport.wakeCalls()[1]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('uses startup_delivery when no runtime exists and wake when the runtime is ready', async () => {
    const startFix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(startFix, 'start me');
      await expect(
        startFix.fanout.startDeliveryBacked(startFix.channelId, startFix.agentId),
      ).resolves.toBe(true);
      expect(startFix.transport.calls.find(call => call.kind === 'runtime_start')?.params)
        .toMatchObject({
          startup_delivery: {
            delivery_ids: [delivery.inboxId],
          },
        });
    } finally {
      startFix.cleanup();
    }

    const wakeFix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(wakeFix, 'wake me');
      wakeFix.transport.snapshot = {
        runtimes: [
          runtimeDto(wakeFix.channelId, wakeFix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: wakeFix.channelId,
            agentId: wakeFix.agentId,
            status: 'idle',
          }),
        ],
      };
      wakeFix.fanout.onEvent(wakeFix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => wakeFix.transport.calls.some(call => call.kind === 'runtime_status'));
      wakeFix.fanout.onEvent(wakeFix.hostId, readyForDrainEvent(wakeFix), 'conn-1');
      await waitFor(() => wakeFix.transport.wakeCalls().length === 1);
      expect(wakeFix.transport.wakeCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(wakeFix.transport.calls.some(call => call.kind === 'runtime_start')).toBe(false);
    } finally {
      wakeFix.cleanup();
    }
  });

  it('wires coordinator.respawn → a non-fatal runtime_exit with pending inbox re-runs startup_delivery (D5.a-3 respawn-wiring regression)', async () => {
    // Regression pin: the D5.a-3 unification onto OutboundRuntimeEventFanout
    // dropped the `respawn` callback, so a runtime that exited with pending
    // inbox logged "no respawn callback wired" and never drained. The
    // coordinator's onRuntimeExit gate (intentional===false AND !initTimedOut
    // AND !fatalError AND hasPendingInbox) must auto-respawn via
    // `startDeliveryBacked` — the ONLY correct redelivery path for an exited
    // runtime (a fresh runtime_start + startup_delivery; a direct wake cannot
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
      // coordinator); the spawn path dispatches a fresh runtime_start.
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_start'),
      );
      const start = fix.transport.calls.find(
        call => call.kind === 'runtime_start',
      )!.params;
      // It drains the still-pending row via startup_delivery, not a wake.
      expect(start).toMatchObject({
        startup_delivery: { delivery_ids: [delivery.inboxId] },
      });
      expect(fix.transport.calls.some(call => call.kind === 'runtime_wake')).toBe(
        false,
      );
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

  it('D4.e-6 — re-binds a legacy regular workspace (workspace_provision) BEFORE runtime_start, and the runtime_start frame carries NO host paths', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      workspaceRegistryBackfiller: ({ transport, workspaces }) =>
        new WorkspaceRegistryBackfiller({
          workspaces,
          outboundFrameAdapter: () =>
            transport as unknown as OutboundFrameAdapter,
        }),
    });
    try {
      enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
      ).resolves.toBe(true);

      const kinds = fix.transport.calls.map(c => c.kind);
      const provIdx = kinds.indexOf('workspace_provision');
      const startIdx = kinds.indexOf('runtime_start');
      // The legacy regular workspace is re-bound FIRST, then runtime_start.
      expect(provIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(provIdx);

      // The provision forwards the stored path as `requested_path` (the
      // backfiller never assembles a path) — this is a provision/backfill
      // seam, where carrying a host path is still legitimate.
      const prov = fix.transport.calls[provIdx]!.params;
      expect(prov).toMatchObject({ kind: 'regular' });
      expect(typeof prov.requested_path).toBe('string');

      // But the runtime_start frame is SEMANTIC-only: no path/home_dir
      // anywhere in the options tree (carve-out revoked, D4.e-6).
      const start = fix.transport.calls[startIdx]!.params;
      const json = JSON.stringify(start);
      expect(json).not.toMatch(/"path"/);
      expect(json).not.toMatch(/"home_dir"/);
      const options = start.options as {
        workspace: Record<string, unknown>;
        agent: Record<string, unknown>;
        workspace_memory_index: Record<string, unknown>[];
      };
      expect(Object.keys(options.workspace).sort()).toEqual(['id', 'kind', 'name']);
      expect(Object.keys(options.agent).sort()).toEqual(['id', 'name']);
      for (const entry of options.workspace_memory_index) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'kind', 'name']);
      }
    } finally {
      fix.cleanup();
    }
  });

  it('D4.e-6 — a failed backfill BLOCKS runtime_start and keeps the rows pending for retry', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      workspaceRegistryBackfiller: () =>
        ({
          ensure: (hostId: string, rows: { id: string; workspace_path: string }[]) =>
            Promise.resolve({
              hostId,
              status: 'failed' as const,
              provisioned: [],
              alreadyBound: [],
              failed: rows.map(r => ({
                id: r.id,
                code: 'daemon_unavailable' as const,
                message: 'daemon offline',
                retriable: true,
              })),
            }),
        }) as unknown as WorkspaceRegistryBackfiller,
    });
    try {
      const delivery = enqueueMessage(fix, 'start me');
      // No registry binding ⇒ do NOT dispatch runtime_start (would jam the
      // daemon-side fail-closed); bail and keep the rows pending.
      await expect(
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
      ).resolves.toBe(false);
      expect(fix.transport.calls.some(c => c.kind === 'runtime_start')).toBe(false);
      // The claimed rows are rolled back to pending: a retry anchor, not a loss.
      expect(
        fix.inbox.listPending(fix.channelId, fix.agentId).map(p => p.inboxId),
      ).toEqual([delivery.inboxId]);
    } finally {
      fix.cleanup();
    }
  });

  it('D4.e-6 — fails closed (I4) when a referenced workspace is owned by a different host: no workspace_provision, no runtime_start', async () => {
    const fix = makeFixture({
      runtime: 'codex',
      workspaceRegistryBackfiller: ({ transport, workspaces }) =>
        new WorkspaceRegistryBackfiller({
          workspaces,
          outboundFrameAdapter: () =>
            transport as unknown as OutboundFrameAdapter,
        }),
    });
    try {
      const delivery = enqueueMessage(fix, 'start me');
      // Forge an I4 violation: the conversation's (only) workspace now claims a
      // DIFFERENT (real) host than the agent's. The host-equality gate must
      // fire BEFORE the backfill, so neither workspace_provision nor
      // runtime_start is dispatched, and the rows stay pending.
      const otherHostId = new HostRepo(fix.db).create('host-other', 'local').id;
      fix.db
        .prepare(`UPDATE workspaces SET workspace_host_id = ?`)
        .run(otherHostId);
      await expect(
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
      ).resolves.toBe(false);
      expect(fix.transport.calls.some(c => c.kind === 'workspace_provision')).toBe(false);
      expect(fix.transport.calls.some(c => c.kind === 'runtime_start')).toBe(false);
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
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
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
  it('startDeliveryBacked with an empty pending inbox dispatches nothing (delivery-backed; identical embedded/standalone)', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      await expect(
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
      ).resolves.toBe(false);
      expect(fix.transport.calls).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  // P1-2 — the dispatched `runtime_start` carries the resolved server URL,
  // never a placeholder. The fanout reads `serverUrl()` lazily at dispatch
  // time; production index.ts wires `() => ctx.serverConfig.url` and only
  // connects the embedded adapter AFTER the port is bound, so the first
  // `runtime_start` already ships the real URL.
  it('runtime_start options.server_url is the resolved serverUrl(), not a placeholder (P1-2)', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      enqueueMessage(fix, 'start me');
      await expect(
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
      ).resolves.toBe(true);
      const start = fix.transport.calls.find(c => c.kind === 'runtime_start');
      expect(start).toBeDefined();
      expect(
        (
          start!.params as {
            options: { env_policy: { silverhand: { server_url: string } } };
          }
        ).options.env_policy.silverhand.server_url,
      ).toBe('http://127.0.0.1:1');
    } finally {
      fix.cleanup();
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

  // ── P2 (D4.b post-review) — soft stop default directive ──
  //
  // Pins the `RuntimeStopParamsSchema.superRefine` contract that
  // soft stops MUST carry `soft_directive`. Pre-fix,
  // `OutboundRuntimeEventFanout.stop` forwarded `softDirective`
  // only when not undefined — so `stop(..., 'soft')` with no
  // directive sent `{mode:'soft'}` and got rejected daemon-side
  // (`runtime_stop_params_invalid`). The fix mirrors
  // `DaemonAgentRuntimeHost.stop` and substitutes
  // `DEFAULT_SOFT_DIRECTIVE` when the caller omits one — both
  // deployment adapters now produce the same wire envelope (R4 —
  // same envelope, transport-only divergence).
  //
  // Three arms: hard MUST omit `soft_directive`; soft with no
  // directive substitutes the default; soft with explicit
  // directive forwards it verbatim.
  it('soft stop without directive substitutes DEFAULT_SOFT_DIRECTIVE; hard stop omits it', async () => {
    const fix = makeFixture();
    try {
      await fix.fanout.stop(fix.channelId, fix.agentId, 'hard');
      await fix.fanout.stop(fix.channelId, fix.agentId, 'soft');
      await fix.fanout.stop(
        fix.channelId,
        fix.agentId,
        'soft',
        'explicit caller directive',
      );

      const stops = fix.transport.calls.filter(c => c.kind === 'runtime_stop');
      expect(stops).toHaveLength(3);

      // Arm 1: hard — soft_directive must NOT appear on the wire
      // (superRefine treats its presence on hard as invalid).
      expect(stops[0]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'hard',
      });
      expect('soft_directive' in stops[0]!.params).toBe(false);

      // Arm 2: soft, no caller directive — substitute default.
      // Pin the exact text so a future module rename / refactor
      // that silently swaps the constant fails this assertion.
      expect(stops[1]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'soft',
        soft_directive: DEFAULT_SOFT_DIRECTIVE,
      });
      expect(stops[1]!.params.soft_directive).toBe(
        '[user requested a course correction — pause your current direction and ' +
          'wait for the next instruction]',
      );

      // Arm 3: soft, explicit caller directive — forward verbatim.
      expect(stops[2]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'soft',
        soft_directive: 'explicit caller directive',
      });
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

interface Fixture {
  db: ReturnType<typeof openTestDb>['db'];
  hostId: string;
  channelId: string;
  agentId: string;
  events: Array<{ conv: string; kind: string; payload: unknown }>;
  messages: MessageRepo;
  inbox: ConversationInboxRepo;
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
    workspaceRegistryBackfiller?: (ctx: {
      transport: FakeTransport;
      workspaces: WorkspaceRepo;
    }) => WorkspaceRegistryBackfiller;
  } = {},
): Fixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const workspacesRoot = join(tmpdir(), 'silverhand-outbound-fanout-test');
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const workspacePath = workspaces.workspacePathFor('fanout-ws');
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
  };
  const transport = new FakeTransport();
  const backfiller = opts.workspaceRegistryBackfiller?.({ transport, workspaces });
  const fanout = new OutboundRuntimeEventFanout({
    db,
    events: publisher,
    transport: () => transport,
    logger: opts.logger ?? SILENT_LOGGER,
    workspacesRoot,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens: new AgentTokenStore(),
    serverUrl: () => 'http://127.0.0.1:1',
    proxyPolicy: () => ({ url: null, allowlist: [] }),
    activityLog: null,
    ...(backfiller ? { workspaceRegistryBackfiller: backfiller } : {}),
    ...(opts.clearSessionExitTimeoutMs !== undefined
      ? { clearSessionExitTimeoutMs: opts.clearSessionExitTimeoutMs }
      : {}),
  });
  const messages = new MessageRepo(db);
  const inbox = new ConversationInboxRepo(db);

  return {
    db,
    hostId: localHostId,
    channelId: channel.id,
    agentId: agent.id,
    events,
    messages,
    inbox,
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
    },
    inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
    statusProjector: new DbRuntimeStatusProjector(
      new ConversationRepo(fix.db),
      {
        publish: (conv, payload) =>
          fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
      },
    ),
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
  private deferredWake:
    | {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
      }
    | null = null;
  private nextWakeError: Error | null = null;
  private nextWakeRefusal:
    | {
        reason: 'driver_not_ready';
      }
    | null = null;
  private nextClearResult: { cleared: boolean } | null = null;

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['local'];
  }

  connectionIdForHost(_hostId: string): string | null {
    return this.connectionId;
  }

  getAttachment(): null {
    // Fanout-coordinator tests don't depend on boot-readiness wiring.
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
      return Promise.resolve(this.snapshot) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_wake') {
      if (this.nextWakeError) {
        const err = this.nextWakeError;
        this.nextWakeError = null;
        return Promise.reject(err);
      }
      if (this.nextWakeRefusal) {
        const refusal = this.nextWakeRefusal;
        this.nextWakeRefusal = null;
        return Promise.resolve({
          delivered: false,
          delivery_ids: [...((params as { delivery_ids: number[] }).delivery_ids)],
          reason: refusal.reason,
        }) as Promise<OutboundServerCommandResult<K>>;
      }
      if (this.deferredWake) {
        return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
          this.deferredWake = {
            resolve: value => resolve(value as OutboundServerCommandResult<K>),
            reject,
          };
        });
      }
      return Promise.resolve({
        delivered: true,
        delivery_ids: [...((params as { delivery_ids: number[] }).delivery_ids)],
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_start') {
      return Promise.resolve({
        started: true,
        pid: 123,
        started_at: 1700000000000,
        ...((params as { startup_delivery?: unknown }).startup_delivery
          ? { startup_delivery_accepted: true }
          : {}),
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'workspace_provision') {
      // D4.e-6 — the lazy backfill re-binds a legacy regular workspace by
      // re-provisioning it with its stored path; the daemon ack is the
      // authoritative bound path (here, the requested path, idempotently).
      const requested = (params as { requested_path?: string }).requested_path;
      return Promise.resolve({
        ok: true,
        provisioned: true,
        bound_workspace_path: requested ?? '/host/ws/provisioned',
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
    return Promise.resolve({}) as Promise<OutboundServerCommandResult<K>>;
  }

  setNextClearResult(result: { cleared: boolean }): void {
    this.nextClearResult = result;
  }

  clearSessionCalls(): Array<{ params: Record<string, unknown> }> {
    return this.calls.filter(call => call.kind === 'runtime_clear_session');
  }

  wakeCalls(): Array<{ params: Record<string, unknown> }> {
    return this.calls.filter(call => call.kind === 'runtime_wake');
  }

  deferNextWake(): void {
    this.deferredWake = {
      resolve: () => {},
      reject: () => {},
    };
  }

  resolveDeferredWake(value: unknown): void {
    const deferred = this.deferredWake;
    this.deferredWake = null;
    deferred?.resolve(value);
  }

  rejectDeferredWake(err: Error): void {
    const deferred = this.deferredWake;
    this.deferredWake = null;
    deferred?.reject(err);
  }

  rejectNextWake(err: Error): void {
    this.nextWakeError = err;
  }

  refuseNextWake(reason: 'driver_not_ready'): void {
    this.nextWakeRefusal = { reason };
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

function readyEvent(): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: 1,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: 'instance-1',
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    daemon_pid: 123,
    started_at: 1700000000000,
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
    case 'runtime_startup_delivery_consumed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        ts: 1700000000000,
      };
    case 'runtime_startup_delivery_failed':
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
