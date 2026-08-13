import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/auth/principal.js';
import { observe, type ObserveDeps } from '../../src/application/observe.js';
import type {
  ObservationPersistence,
  ObservedStream,
} from '../../src/application/observation-ports.js';
import { createSqliteObservationPersistence } from '../../src/repos/observation-persistence.js';
import { AttentionBadgeRepo } from '../../src/repos/attention-badge-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * The observation WRITE BOUNDARY (#task:1987 E) — properties of the mechanism,
 * not of the endpoint. What `tests/routes/attention-observe.test.ts` already
 * covers (positions, per-source auth, the §3 overlap, the coalesced events) is
 * deliberately not repeated here; these pin the three claims
 * `application/observation-ports.ts` makes and that no route test can see:
 *
 *   1. ATOMIC — the whole batch commits together, so the §3 overlap cannot
 *      half-apply (cursor advanced, mention still unread → the non-derived
 *      notification badge would linger as a second truth).
 *   2. VIEWER-BOUND — the scope's face closes over the key's viewer, so clearing
 *      someone else's read state is not expressible, not merely filtered.
 *   3. LOCK-FREE BUT SAFE — the scope takes no write lock at BEGIN. A pre-write
 *      read does exist (the cursor face reads the current cursor) but no invariant
 *      rests on it: the upsert is monotone, so an already-higher cursor survives
 *      and a stale "did this call move it" boolean is harmless. Cross-connection
 *      safety rests on that `max(existing, new)` contract — the test below
 *      interleaves on ONE connection and claims nothing more.
 */

const LOCAL: Principal = { kind: 'user', userId: 'local' };

async function createChannel(
  t: TestApp,
  label = 'a',
): Promise<{ channelId: string; agentId: string }> {
  const agent = (await (
    await http(t).post('/api/agents', { name: `agent-${label}`, runtime: 'claude' })
  ).json()) as any;
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: `ws-observe-uow-${label}`,
      member_agent_ids: [agent.agent.id],
    })
  ).json()) as any;
  return { channelId: workspace.onboarding_channel_id, agentId: agent.agent.id };
}

/** Real deps, with the real adapter unless a wrapper is supplied. */
function observeDeps(
  t: TestApp,
  observations: ObservationPersistence = createSqliteObservationPersistence(t.ctx.db),
): ObserveDeps {
  return {
    ctx: t.ctx,
    conversations: new ConversationRepo(t.ctx.db),
    messages: new MessageRepo(t.ctx.db),
    conversationReads: new ConversationReadRepo(t.ctx.db),
    attentionBadges: new AttentionBadgeRepo(t.ctx.db),
    observations,
  };
}

describe('observation write boundary (#task:1987 E)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('is ONE transaction: a throw after the overlap rolls back the cursor AND the clear', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);
    const reads = new ConversationReadRepo(t.ctx.db);
    const observations = createSqliteObservationPersistence(t.ctx.db);

    const msg = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: '@local hello',
    });
    const mention = notifications.insert({
      kind: 'mention_self',
      userId: 'local',
      conversationId: channelId,
      messageId: msg.id,
    });

    const stream: ObservedStream = {
      conversationId: channelId,
      threadRootId: null,
      targetSeq: msg.seq,
    };
    expect(() =>
      observations.uow.atomicallyForViewer({ viewerUserId: 'local' }, tx => {
        expect(tx.viewer.advanceStreamCursor(stream)).toBe(true);
        // both halves of the §3 overlap really happened inside the scope…
        expect(tx.viewer.clearStreamMentions(stream)).toEqual([mention.id]);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // …and neither survives the abort.
    expect(reads.getLastReadSeq('local', channelId, null)).toBe(0);
    expect(notifications.get(mention.id)?.read_at).toBeNull();
  });

  it('is viewer-bound: a notification id belonging to another viewer is an idempotent no-op', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);
    const observations = createSqliteObservationPersistence(t.ctx.db);

    const msg = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: '@other hello',
    });
    const foreign = notifications.insert({
      kind: 'mention_self',
      userId: 'other',
      conversationId: channelId,
      messageId: msg.id,
    });

    // The endpoint takes arbitrary notification ids and the notification arm has
    // no pre-validation on purpose, so this is the request a hostile client makes.
    const result = await observe(observeDeps(t, observations), {
      principal: LOCAL,
      viewerUserId: 'local',
      sources: [{ kind: 'notification', notification_id: foreign.id }],
    });
    expect(result).toEqual({ ok: true, changed: false });
    expect(notifications.get(foreign.id)?.read_at).toBeNull();

    // Directly on the face: the outcome carries no facts to attribute a badge
    // with, because nothing was cleared.
    observations.uow.atomicallyForViewer({ viewerUserId: 'local' }, tx => {
      expect(tx.viewer.clearNotification(foreign.id)).toEqual({ cleared: false });
      // …and the viewer is not a parameter anything can get wrong: the face is
      // bound to the key, so there is no argument to aim at another user.
      // @ts-expect-error - clearNotification takes ONLY a notification id
      tx.viewer.clearNotification(foreign.id, 'other');
    });
    expect(notifications.get(foreign.id)?.read_at).toBeNull();
  });

  it('cursor advance is monotone: an already-higher (interleaved) cursor is never clobbered', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const reads = new ConversationReadRepo(t.ctx.db);
    const real = createSqliteObservationPersistence(t.ctx.db);

    const first = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'one',
    });
    const second = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'two',
    });

    // A higher cursor is already in place when our (older) target reaches the
    // write. INTERLEAVED, NOT CONCURRENT: this runs on the same connection inside
    // the same transaction, so it does not simulate a second connection or pooled
    // scheduling — it pins the state our write sees, i.e. a stale pre-read and a
    // lower target. The load-bearing evidence for cross-connection safety is
    // `markRead`'s `max(existing, new)` contract, not this arrangement.
    const interleaved: ObservationPersistence = {
      uow: {
        atomicallyForViewer(key, fn) {
          return real.uow.atomicallyForViewer(key, tx => {
            reads.markRead({
              viewerUserId: 'local',
              conversationId: channelId,
              threadRootId: null,
              seq: second.seq,
            });
            return fn(tx);
          });
        },
      },
    };

    const events: string[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => events.push(e.kind));
    const result = await observe(observeDeps(t, interleaved), {
      principal: LOCAL,
      viewerUserId: 'local',
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: null,
          position: { kind: 'at_seq', seq: first.seq },
        },
      ],
    });
    unsub();

    // No regression to our lower target, and no event: the observer that put the
    // cursor there already published the strictly newer state.
    expect(reads.getLastReadSeq('local', channelId, null)).toBe(second.seq);
    expect(result).toEqual({ ok: true, changed: false });
    expect(events).toEqual([]);
  });

  it('overlap still fires when the cursor does NOT move (the two-method split)', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);
    const deps = observeDeps(t);

    const msg = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: '@local hello',
    });
    const source = {
      kind: 'stream' as const,
      conversation_id: channelId,
      thread_root_id: null,
      position: { kind: 'stream_head' as const },
    };
    expect(await observe(deps, { principal: LOCAL, viewerUserId: 'local', sources: [source] }))
      .toEqual({ ok: true, changed: true });

    // A mention BELOW the cursor arrives late (mention_cc delivery, a backfill).
    // The cursor has nowhere to move, so a merged "observeStream" would report
    // nothing changed and leave the non-derived badge lit.
    const late = notifications.insert({
      kind: 'mention_self',
      userId: 'local',
      conversationId: channelId,
      messageId: msg.id,
    });
    expect(await observe(deps, { principal: LOCAL, viewerUserId: 'local', sources: [source] }))
      .toEqual({ ok: true, changed: true });
    expect(notifications.get(late.id)?.read_at).not.toBeNull();
  });
});
