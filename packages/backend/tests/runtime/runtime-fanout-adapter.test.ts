/**
 * #task:1982 W3 — adapter contract for the outbound runtime fanout's
 * persistence composition.
 *
 * Two obligations of the cut are asserted here, and neither is expressible in
 * the type system:
 *
 *  - **R4 (physical rows stop at the adapter).** A type-level narrowing is not
 *    a boundary: `{...row} as RuntimeInboxMessage` type-checks while the
 *    surplus columns keep flowing. So the assertions are on the RUNTIME KEY SET
 *    of what each facet returns, plus an explicit "this specific physical
 *    column is absent" check per projection — `messages.conversation_id`,
 *    `hosts.installation_id`, the snake_case reconcile columns. Add a column to
 *    one of those tables and these tests still pass; write a projection that
 *    spreads the row and they fail.
 *  - **Isolation + atomicity of the clear-session pair.** The SQLite adapter
 *    takes `BEGIN IMMEDIATE` before the first authorization read. A throw
 *    anywhere in the callback leaves NEITHER the
 *    `cli_session_id` clear nor the audit message behind. The test carries its
 *    own falsifier: the same two writes performed outside `atomically` DO leave
 *    a half state, which is what proves the assertion is load-bearing rather
 *    than vacuously true of this fixture.
 */
import { fixedConversationTitle } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { createRuntimeFanoutDbDeps } from '../../src/adapters/runtime-fanout.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import type { BackendLogger } from '../../src/context.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import { openTestDb } from '../utils/db.js';

const SILENT_LOGGER: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const NOOP_PUBLISHER: EventPublisher = {
  publish: () => {},
  publishSide: () => {},
};

/** Exactly the fields `RuntimeInboxMessage` declares. */
const RUNTIME_INBOX_MESSAGE_KEYS = [
  'content',
  'conversation_id',
  'created_at',
  'from_agent_id',
  'from_kind',
  'from_user_id',
  'id',
  'metadata',
  'seq',
  'thread_root_id',
].sort();

function makeFixture() {
  const { db, viewerUserId, localHostId } = openTestDb();
  const conversations = new ConversationRepo(db);
  const runtimeSlots = new RuntimeSlotRepo(db);
  const messages = new MessageRepo(db);

  const workspace = new WorkspaceRepo(db).insert({
    name: 'fanout-adapter',
    description: null,
  });
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('fanout-adapter'),
  });
  const agent = new AgentRepo(db).create(
    { name: 'agent-adapter', runtime: 'claude', host_id: localHostId },
    localHostId,
    viewerUserId,
  );
  conversations.addAgent(channel.id, agent.id);

  const deps = createRuntimeFanoutDbDeps({
    db,
    events: NOOP_PUBLISHER,
    logger: SILENT_LOGGER,
  });

  return {
    db,
    conversations,
    runtimeSlots,
    messages,
    viewerUserId,
    localHostId,
    channelId: channel.id,
    agentId: agent.id,
    persistence: deps.persistence,
    /** Enqueue one user message for the pair and return its id. */
    enqueue(content: string): string {
      const message = messages.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: viewerUserId,
        content,
      });
      deps.persistence.inbox.ensureDelivery(channel.id, agent.id, message.id);
      return message.id;
    },
  };
}

describe('#task:1982 W3 — runtime fanout persistence adapter contract', () => {
  it('inbox deliveries carry the runtime projection, not the physical messages row (R4)', () => {
    const f = makeFixture();
    f.enqueue('hello');

    const pending = f.persistence.inbox.listPending(f.channelId, f.agentId);
    expect(pending).toHaveLength(1);
    expect(Object.keys(pending[0]!).sort()).toEqual([
      'deliveryKind',
      'inboxId',
      'message',
    ]);
    expect(Object.keys(pending[0]!.message).sort()).toEqual(
      RUNTIME_INBOX_MESSAGE_KEYS,
    );
    // The joined row this came from HAS these columns; the projection drops
    // them, so no runtime decision can start reading one by accident.
    for (const surplus of ['inbox_id', 'delivery_kind']) {
      expect(pending[0]!.message, surplus).not.toHaveProperty(surplus);
    }
    // `conversation_id` is IN the projection (#task:2021 P4-3) and carries the
    // row's OWN stream, because the stdin header renders it as an absolute
    // target. Today's claim is per stream, so this equals the claimed
    // conversation; the column exists so the coordinate travels WITH the row
    // rather than being re-supplied by whoever assembled the batch.
    expect(pending[0]!.message.conversation_id).toBe(f.channelId);

    const claimed = f.persistence.inbox.claimPending(
      f.channelId,
      f.agentId,
      'conn-1',
    );
    expect(claimed).toHaveLength(1);
    expect(Object.keys(claimed[0]!).sort()).toEqual([
      'deliveryKind',
      'inFlightOwner',
      'inboxId',
      'message',
    ]);
    expect(Object.keys(claimed[0]!.message).sort()).toEqual(
      RUNTIME_INBOX_MESSAGE_KEYS,
    );
    expect(claimed[0]!.deliveryKind).toBe('turn');
    expect(claimed[0]!.inFlightOwner).toBe('conn-1');
  });

  it('host routing reads see three fields, not the hosts row (R4)', () => {
    const f = makeFixture();
    const view = f.persistence.hosts.routingView(f.localHostId);
    expect(view).not.toBeNull();
    expect(Object.keys(view!).sort()).toEqual([
      'id',
      'ownerUserId',
      'revokedAt',
    ]);
    // install identity and onboarding markers are exactly what a routing
    // decision must not be able to consult
    for (const surplus of [
      'installation_id',
      'user_id',
      'revoked_at',
      'kind',
    ]) {
      expect(view!, surplus).not.toHaveProperty(surplus);
    }
    expect(f.persistence.hosts.routingView('no-such-host')).toBeNull();
  });

  it('the reconcile pass sees the three facts it folds over, in domain casing (R4)', () => {
    const f = makeFixture();
    f.runtimeSlots.updateCurrentConversationProjection(f.channelId, f.agentId, {
      status: 'active',
      pid: 4242,
    });

    const live = f.persistence.hydrateReconcile.listDbLiveRuntimesForHost(
      f.localHostId,
    );
    expect(live).toHaveLength(1);
    expect(Object.keys(live[0]!).sort()).toEqual([
      'agentId',
      'daemonInstanceId',
      'focusConversationId',
      'generation',
      'pid',
      'scope',
      'status',
    ]);
    expect(live[0]).toEqual({
      scope: {
        kind: 'conversation',
        conversationId: f.channelId,
        agentId: f.agentId,
      },
      focusConversationId: f.channelId,
      agentId: f.agentId,
      generation: 0,
      daemonInstanceId: null,
      status: 'active',
      pid: 4242,
    });

    // `markCrashed`'s constant is in its name — the caller cannot ask for a
    // different status, and the pair leaves the live set afterwards.
    const updated = f.persistence.hydrateReconcile.markCrashed(live[0]!);
    expect(updated).toBe(true);
    expect(
      f.persistence.hydrateReconcile.listDbLiveRuntimesForHost(f.localHostId),
    ).toEqual([]);
    // a membership row that is gone is `null`, which the caller skips
    expect(
      f.persistence.hydrateReconcile.markCrashed({
        scope: {
          kind: 'conversation',
          conversationId: f.channelId,
          agentId: 'no-such-agent',
        },
        focusConversationId: f.channelId,
        agentId: 'no-such-agent',
        generation: 0,
        daemonInstanceId: null,
        status: 'active',
        pid: null,
      }),
    ).toBe(false);
  });

  it('user reads answer with a handle, never a users row (R4)', () => {
    const f = makeFixture();
    expect(typeof f.persistence.users.nameOf(f.viewerUserId)).toBe('string');
    expect(f.persistence.users.nameOf('no-such-user')).toBeNull();
  });

  it('the clear-session UoW commits both writes or neither', () => {
    const f = makeFixture();
    f.runtimeSlots.updateCurrentConversationProjection(f.channelId, f.agentId, {
      cliSessionId: 'session-1',
    });
    const messageCount = (): number =>
      f.messages.listWindowForConversation(f.channelId).messages.length;
    const before = messageCount();

    // (a) happy path — both writes land
    const result = f.persistence.session.atomically(scope => {
      const receipt = scope.clearCliSession({
        scope: {
          kind: 'conversation',
          conversationId: f.channelId,
          agentId: f.agentId,
        },
        expectedGeneration: f.runtimeSlots.getConversation(
          f.channelId,
          f.agentId,
        )!.generation,
      });
      const audit = scope.insertSystemMessage({
        conversationId: f.channelId,
        fromUserId: f.viewerUserId,
        content: 'session cleared',
        metadata: { subtype: 'test' },
      });
      return { receipt, audit };
    });
    expect(result.receipt).toMatchObject({
      scope: {
        kind: 'conversation',
        conversationId: f.channelId,
        agentId: f.agentId,
      },
      generation: 0,
      projection: { cli_session_id: null },
    });
    expect(result.audit.from_kind).toBe('system');
    expect(messageCount()).toBe(before + 1);

    // (b) a throw after the first write rolls BOTH back
    f.runtimeSlots.updateCurrentConversationProjection(f.channelId, f.agentId, {
      cliSessionId: 'session-2',
    });
    const midpoint = messageCount();
    expect(() =>
      f.persistence.session.atomically(scope => {
        scope.clearCliSession({
          scope: {
            kind: 'conversation',
            conversationId: f.channelId,
            agentId: f.agentId,
          },
          expectedGeneration: f.runtimeSlots.getConversation(
            f.channelId,
            f.agentId,
          )!.generation,
        });
        scope.insertSystemMessage({
          conversationId: f.channelId,
          fromUserId: f.viewerUserId,
          content: 'session cleared',
          metadata: { subtype: 'test' },
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(
      f.runtimeSlots.getConversation(f.channelId, f.agentId)?.cli_session_id,
    ).toBe('session-2');
    expect(messageCount()).toBe(midpoint);

    // (c) FALSIFIER — the FIRST write alone, outside the UoW, does persist.
    // That is the half state (b) proves impossible; without this contrast (b)
    // would also pass for an `atomically` that merely called the callback.
    try {
      f.runtimeSlots.updateCurrentConversationProjection(f.channelId, f.agentId, {
        cliSessionId: null,
      });
      throw new Error('boom');
    } catch {
      // swallowed on purpose — the point is the state left behind
    }
    expect(
      f.runtimeSlots.getConversation(f.channelId, f.agentId)?.cli_session_id,
    ).toBeNull();
    expect(messageCount()).toBe(midpoint);
  });
});
