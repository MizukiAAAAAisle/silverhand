import { describe, expect, it } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspace = workspaces.insert({
    name: 'inbox-ws',
    description: null,
  });
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('s'),
  });
  const messages = new MessageRepo(db);
  const inbox = new ConversationInboxRepo(db);
  const agents = new AgentRepo(db);
  const a = agents.create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  const b = agents.create({ name: 'b', runtime: 'claude' }, localHostId, 'local');
  return { db, channel, messages, inbox, agentA: a.id, agentB: b.id };
}

describe('ConversationInboxRepo', () => {
  it('listPending joins messages and returns them in enqueue order', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'first',
    });
    const m2 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'second',
    });

    inbox.enqueue(channel.id, agentA, m1.id);
    inbox.enqueue(channel.id, agentA, m2.id);

    const pending = inbox.listPending(channel.id, agentA);
    expect(pending.map(p => p.message.content)).toEqual(['first', 'second']);
    expect(pending[0]!.message.conversation_id).toBe(channel.id);
    expect(typeof pending[0]!.inboxId).toBe('number');
  });

  it('isolates inboxes per (conversation, agent) pair', () => {
    const { channel, messages, inbox, agentA, agentB } = bootstrap();
    const m = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'x',
    });
    inbox.enqueue(channel.id, agentA, m.id);

    expect(inbox.listPending(channel.id, agentA)).toHaveLength(1);
    expect(inbox.listPending(channel.id, agentB)).toHaveLength(0);
  });

  it('ensureDelivery is idempotent per (conversation, agent, message)', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'same delivery',
    });

    const first = inbox.ensureDelivery(channel.id, agentA, m.id);
    const second = inbox.ensureDelivery(channel.id, agentA, m.id);

    expect(second.inboxId).toBe(first.inboxId);
    expect(second.deliveredAt).toBeNull();
    expect(inbox.listPending(channel.id, agentA)).toHaveLength(1);
  });

  it('enqueue is idempotent under the delivery uniqueness constraint', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'same enqueue',
    });

    const first = inbox.enqueue(channel.id, agentA, m.id);
    const second = inbox.enqueue(channel.id, agentA, m.id);

    expect(second.inboxId).toBe(first.inboxId);
    expect(inbox.listPending(channel.id, agentA)).toHaveLength(1);
  });

  it('settleDelivered requires the exact origin and lease; empty input is a no-op', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: '1',
    });
    const m2 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: '2',
    });
    inbox.enqueue(channel.id, agentA, m1.id);
    inbox.enqueue(channel.id, agentA, m2.id);

    expect(inbox.settleDelivered({
      conversationId: channel.id,
      agentId: agentA,
      inFlightOwner: 'conn-1',
      inboxIds: [],
    })).toBe(false);
    expect(inbox.listPending(channel.id, agentA)).toHaveLength(2);

    const claimed = inbox.claimPending(channel.id, agentA, 'conn-1');
    expect(inbox.settleDelivered({
      conversationId: channel.id,
      agentId: agentA,
      inFlightOwner: 'conn-1',
      inboxIds: [claimed[0]!.inboxId],
    })).toBe(true);
    inbox.rollbackInFlight([claimed[1]!.inboxId], 'conn-1');
    const remaining = inbox.listPending(channel.id, agentA);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.message.content).toBe('2');
  });

  it('claims pending rows FIFO and rolls in-flight rows back to pending', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: '1',
    });
    const m2 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: '2',
    });
    inbox.enqueue(channel.id, agentA, m1.id);
    inbox.enqueue(channel.id, agentA, m2.id);

    const claimed = inbox.claimPending(channel.id, agentA, 'conn-1');
    expect(claimed.map(row => row.message.content)).toEqual(['1', '2']);
    expect(inbox.listPending(channel.id, agentA)).toEqual([]);
    expect(inbox.claimPending(channel.id, agentA, 'conn-2')).toEqual([]);

    inbox.rollbackInFlight([claimed[0]!.inboxId], 'conn-1');
    expect(inbox.listPending(channel.id, agentA).map(row => row.message.content)).toEqual([
      '1',
    ]);

    expect(inbox.settleDelivered({
      conversationId: channel.id,
      agentId: agentA,
      inFlightOwner: 'conn-1',
      inboxIds: [claimed[1]!.inboxId],
    })).toBe(true);
    expect(inbox.listInFlightForOwner('conn-1')).toEqual([]);
  });

  it('reclaims stale in-flight rows for a pair without touching the live owner', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'old',
    });
    const m2 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'live',
    });
    inbox.enqueue(channel.id, agentA, m1.id);
    inbox.enqueue(channel.id, agentA, m2.id);

    const [oldClaim, liveClaim] = inbox.claimPending(channel.id, agentA, 'old-conn');
    inbox.rollbackInFlight([liveClaim!.inboxId], 'old-conn');
    inbox.claimPending(channel.id, agentA, 'conn-1');

    expect(
      inbox.rollbackInFlightForPairExceptOwner(channel.id, agentA, 'conn-1'),
    ).toBe(1);
    expect(inbox.listPending(channel.id, agentA).map(row => row.inboxId)).toEqual([
      oldClaim!.inboxId,
    ]);
    expect(inbox.listInFlightForOwner('conn-1').map(row => row.inboxId)).toEqual([
      liveClaim!.inboxId,
    ]);
    expect(
      inbox.countInFlightForPairOwner(channel.id, agentA, 'conn-1'),
    ).toBe(1);
  });

  it('hasUndeliveredForPair includes pending and in-flight rows but excludes delivered rows', () => {
    const { channel, messages, inbox, agentA } = bootstrap();
    const m = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'undelivered',
    });
    inbox.enqueue(channel.id, agentA, m.id);

    expect(inbox.hasUndeliveredForPair(channel.id, agentA)).toBe(true);

    const [claimed] = inbox.claimPending(channel.id, agentA, 'conn-1');
    expect(inbox.listPending(channel.id, agentA)).toEqual([]);
    expect(inbox.hasUndeliveredForPair(channel.id, agentA)).toBe(true);

    expect(inbox.settleDelivered({
      conversationId: channel.id,
      agentId: agentA,
      inFlightOwner: 'conn-1',
      inboxIds: [claimed!.inboxId],
    })).toBe(true);
    expect(inbox.hasUndeliveredForPair(channel.id, agentA)).toBe(false);
  });

  it('settles an all-or-nothing set only under the exact origin, agent, and lease', () => {
    const { db, channel, messages, inbox, agentA, agentB } = bootstrap();
    const channelB = new ConversationRepo(db).insertChannel({
      workspaceId: channel.workspace_id!,
      title: fixedConversationTitle('second'),
    });
    const enqueue = (conversationId: string, agentId: string, content: string) => {
      const message = messages.insertForConversation({
        conversationId,
        fromKind: 'user',
        content,
      });
      return inbox.ensureDelivery(conversationId, agentId, message.id).inboxId;
    };
    const aId = enqueue(channel.id, agentA, 'origin A');
    const bId = enqueue(channelB.id, agentA, 'origin B');
    const otherAgentId = enqueue(channelB.id, agentB, 'other agent');
    inbox.claimPending(channel.id, agentA, 'conn-1');
    inbox.claimPending(channelB.id, agentA, 'conn-1');
    inbox.claimPending(channelB.id, agentB, 'conn-1');

    const row = (id: number) => db.prepare(
      `SELECT id, conversation_id, agent_id, delivered_at, failed_at,
              in_flight_owner, in_flight_at
         FROM conversation_inboxes WHERE id = ?`,
    ).get(id);
    const before = new Map([
      [aId, row(aId)],
      [bId, row(bId)],
      [otherAgentId, row(otherAgentId)],
    ]);
    const authority = (inboxIds: readonly number[], inFlightOwner = 'conn-1') => ({
      conversationId: channelB.id,
      agentId: agentA,
      inFlightOwner,
      inboxIds,
    });

    expect(inbox.settleDelivered(authority([aId]))).toBe(false);
    expect(inbox.settleDelivered(authority([bId, aId]))).toBe(false);
    expect(inbox.settleDelivered(authority([bId, otherAgentId]))).toBe(false);
    expect(inbox.settleDelivered(authority([bId], 'conn-2'))).toBe(false);
    expect(row(aId)).toEqual(before.get(aId));
    expect(row(bId)).toEqual(before.get(bId));
    expect(row(otherAgentId)).toEqual(before.get(otherAgentId));

    expect(inbox.settleDelivered(authority([bId]))).toBe(true);
    expect(row(bId)).toMatchObject({
      delivered_at: expect.any(Number),
      failed_at: null,
      in_flight_owner: null,
      in_flight_at: null,
    });
    expect(row(aId)).toEqual(before.get(aId));
    expect(row(otherAgentId)).toEqual(before.get(otherAgentId));

    const retryId = enqueue(channelB.id, agentA, 'retry B');
    inbox.claimPending(channelB.id, agentA, 'conn-1');
    expect(inbox.settleUndelivered(authority([retryId]))).toBe(true);
    expect(row(retryId)).toMatchObject({
      delivered_at: null,
      failed_at: null,
      in_flight_owner: null,
      in_flight_at: null,
    });
  });
});
