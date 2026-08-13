import { describe, expect, it, vi } from 'vitest';
import { decodeTransportEpoch, decodeTransportSeq } from '@silverhand/shared';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { createMentionCcAdapter, createMentionCcComposition } from '../../src/adapters/mention-cc.js';
import { ccMentionsFromUserMessage } from '../../src/application/mention-cc.js';
import type { WorkspaceRosterUnitOfWork } from '../../src/application/membership-ports.js';
import { overrideScope } from '../utils/tx-fault.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import type { MessageDto } from '@silverhand/shared';

class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];
  deliverError: Error | null = null;

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    if (this.deliverError) throw this.deliverError;
    this.delivered.push({ conversationId, agentId, messageId });
  }
}

function bootstrap() {
  const { db, localHostId } = openTestDb();
  // Drop the test fixture autoseed triggers — we want to observe the
  // exact membership rows mention-cc writes, not the bulk fixture seed.
  db.exec(
    `DROP TRIGGER IF EXISTS test_seed_workspace_users;
     DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
  );

  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const notifications = new NotificationRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // Source workspace + channel — created via the repo, autoseed-trigger
  // is gone so no membership rows get written automatically.
  const sourceWorkspace = workspaces.insert({
    name: 'eng',
    description: null,
  });
  const sourceChannel = conversations.insertChannel({
    workspaceId: sourceWorkspace.id,
    title: 'general',
  });

  // Recipient agent ("alice") with their agent_home + Onboarding DM.
  // mention-cc looks up the agent's primary DM and uses its workspace
  // as the home for the new Mentions DM.
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const aliceHome = workspaces.insertAgentHome({
    agent: { id: alice.id, name: alice.name },
  });
  const aliceDm = conversations.insertDmChannel({
    workspaceId: aliceHome.id,
    title: 'Onboarding',
    agentId: alice.id,
  });
  conversations.addAgent(aliceDm.id, alice.id);

  return {
    db,
    tmp,
    agents,
    workspaces,
    conversations,
    messages,
    notifications,
    events,
    fake,
    logger,
    sourceWorkspace,
    sourceChannel,
    alice,
    aliceHome,
    aliceDm,
    cleanup: tmp.cleanup,
  };
}

async function runMentionCc(t: ReturnType<typeof bootstrap>, message: MessageDto) {
  // Wired through the real adapter: the use case takes ports now, and the
  // adapter is the only place that turns a `db` into them, so composing it
  // here keeps this suite testing the production path end to end.
  await createMentionCcAdapter({
    db: t.db,
    runtimeHost: t.fake as unknown as AgentRuntimeHost,
    events: t.events,
    logger: t.logger,
  }).ccMentionsFromUserMessage({
    message,
    sourceConversation: t.sourceChannel,
    sourceWorkspace: t.sourceWorkspace,
    // The send boundary derives this once and hands it across the port
    // (#task:2000); this harness stands in for that caller.
    references: extractMessageReferences(message.content),
  });
}

describe('ccMentionsFromUserMessage — agent-home DM admission / ACL repair', () => {
  it('writes message-author user_id into Mentions conversation_users + workspace_users', async () => {
    const t = bootstrap();
    try {
      // Source message authored by 'teammate' (a fixture user that is
      // NOT the registered viewer 'local'). The CC path must add the
      // *author*, not the viewer, to the lazy Mentions DM.
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey <silverhand://agent/alice> take a look',
      });

      await runMentionCc(t, userMsg);

      // The Mentions DM must now exist under alice's home workspace.
      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      expect(mentionsDm!.workspace_id).toBe(t.aliceHome.id);

      // conversation_users for that DM must contain the *author*.
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id)
        .map(r => r.user_id);
      expect(dmMembers).toEqual(['teammate']);

      // workspace_users for alice's home must also contain the author.
      const homeMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM workspace_users WHERE workspace_id = ?`,
        )
        .all(t.aliceHome.id)
        .map(r => r.user_id);
      expect(homeMembers).toContain('teammate');
      // …as a plain member. Mentioning an agent must not confer governance over
      // the recipient's home workspace (the delegation passes no role and the
      // method's default is `member`).
      expect(t.workspaces.getUserRole(t.aliceHome.id, 'teammate')).toBe('member');
    } finally {
      t.cleanup();
    }
  });

  it('falls back to the source conversation sole human member when message has no from_user_id', async () => {
    const t = bootstrap();
    try {
      t.conversations.addUser(t.sourceChannel.id, 'local');
      // Legacy null-author message — pre-v25 messages may carry
      // from_user_id = null. The fallback chain resolves to the sole
      // human member in the source conversation ('local').
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: null,
        content: 'hey <silverhand://agent/alice> legacy null author',
      });

      await runMentionCc(t, userMsg);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id)
        .map(r => r.user_id);
      expect(dmMembers).toEqual(['local']);
    } finally {
      t.cleanup();
    }
  });

  it('logs and skips membership writes when no user id is resolvable', async () => {
    // Per Cindy's instruction: "如果最终仍拿不到 user id, 宁可
    // log+skip user membership, 不要写空 membership". With a legacy
    // null author and no source-conversation human member, the function
    // must NOT insert any conversation_users / workspace_users rows for
    // the lazily-created Mentions DM.
    const t = bootstrap();
    try {
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: null,
        content: 'hey <silverhand://agent/alice> no resolvable human',
      });

      await runMentionCc(t, userMsg);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      // No conversation_users rows for the new Mentions DM.
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id);
      expect(dmMembers).toHaveLength(0);
      // No workspace_users rows added either.
      const homeMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM workspace_users WHERE workspace_id = ?`,
        )
        .all(t.aliceHome.id);
      expect(homeMembers).toHaveLength(0);
      // The skip path must log a warning so this isn't silent.
      expect(t.logger.warn).toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it('logs and skips membership writes when a null-author source has multiple human members', async () => {
    const t = bootstrap();
    try {
      t.conversations.addUser(t.sourceChannel.id, 'local');
      t.conversations.addUser(t.sourceChannel.id, 'teammate');

      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: null,
        content: 'hey <silverhand://agent/alice> ambiguous human',
      });

      await runMentionCc(t, userMsg);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id);
      expect(dmMembers).toHaveLength(0);
      expect(t.logger.warn).toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it('does not write a duplicate user_id row when the same author is mentioned twice', async () => {
    const t = bootstrap();
    try {
      // First mention seeds the Mentions DM + adds 'teammate'.
      const m1 = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first <silverhand://agent/alice>',
      });
      await runMentionCc(t, m1);
      // Second mention — addUser must be idempotent.
      const m2 = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second <silverhand://agent/alice>',
      });
      await runMentionCc(t, m2);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id)
        .map(r => r.user_id);
      expect(dmMembers).toEqual(['teammate']);
    } finally {
      t.cleanup();
    }
  });

  it('repairs agent-home DM ACL scaffolding that is missing on a later mention', async () => {
    // #task:1989 — the product contract: a mention is an agent-home DM
    // admission / ACL repair, NOT a workspace invitation. There is no durable
    // deny state, so an ABSENT workspace_users / conversation_users row means
    // "never provisioned / needs repair", not "revoked". A later mention from
    // a still-legal source conversation must therefore rebuild the scaffolding
    // idempotently — the workspace row at the fixed plain `member` role and the
    // two role-less conversation edges — without conferring governance over the
    // recipient's home workspace.
    const t = bootstrap();
    try {
      // First mention seeds the Mentions DM + adds 'teammate'.
      const m1 = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first <silverhand://agent/alice>',
      });
      await runMentionCc(t, m1);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      // Simulate the absence the repair must heal: both ACL rows are gone.
      // (No product route removes them today — see #task:1989 — but a raw
      // delete / legacy migration / broken seam can leave exactly this state,
      // and membership-row absence must not be read as durable revocation.)
      // The pure-DELETE repo methods stand in for that removal without
      // emitting any audit/event side effects.
      t.conversations.removeUser(mentionsDm!.id, 'teammate');
      t.workspaces.removeUserMember(t.aliceHome.id, 'teammate');

      // A new mention from the same still-legal source conversation rebuilds
      // the scaffolding — this is the repair half of the contract.
      const m2 = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second <silverhand://agent/alice> after ACL removal',
      });
      await runMentionCc(t, m2);

      const dmMembers = t.conversations
        .listUsers(mentionsDm!.id)
        .map(m => m.user_id);
      expect(dmMembers).toEqual(['teammate']);

      const homeMembers = t.workspaces
        .listUserMembers(t.aliceHome.id)
        .map(m => m.id);
      expect(homeMembers).toContain('teammate');
      // The repair never upgrades the author's governance: the fixed role is
      // plain `member`, never owner/admin — mentioning an agent grants only
      // DM admission, never governance over the recipient's home workspace.
      expect(t.workspaces.getUserRole(t.aliceHome.id, 'teammate')).toBe('member');
    } finally {
      t.cleanup();
    }
  });
});

describe('ccMentionsFromUserMessage — realtime events and skip logging', () => {
  it('publishes topology, message, unread, and notification events for a newly visible Mentions DM', async () => {
    const t = bootstrap();
    try {
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'please review this <silverhand://agent/alice>',
      });

      await runMentionCc(t, userMsg);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      const workspaceEvents = t.events.replay(
        `workspace:${t.aliceHome.id}`,
        decodeTransportSeq(0),
        decodeTransportEpoch('test-epoch'),
      );
      expect(workspaceEvents).toEqual([
        expect.objectContaining({
          kind: 'workspace_channels_changed',
          payload: {
            workspace_id: t.aliceHome.id,
            channel_id: mentionsDm!.id,
          },
        }),
      ]);

      const conversationEvents = t.events.replay(
        `conversation:${mentionsDm!.id}`,
        decodeTransportSeq(0),
        decodeTransportEpoch('test-epoch'),
      );
      expect(conversationEvents).toHaveLength(1);
      expect(conversationEvents[0]).toEqual(
        expect.objectContaining({
          kind: 'message',
          payload: {
            message: expect.objectContaining({
              conversation_id: mentionsDm!.id,
              from_kind: 'system',
            }),
          },
        }),
      );

      const viewerEvents = t.events.replay('viewer:teammate', decodeTransportSeq(0), decodeTransportEpoch('test-epoch'));
      // `unread_updated` and `attention_badge_updated` are ONE fact emitted as
      // two frames (#task:1870) — the seam that publishes the first always
      // publishes the second, so the badge can never be left behind by a client
      // that holds it without refetching. For a `Mentions` DM (an `agent_home`
      // workspace, which carries neither a channel tier nor the workspace
      // suppressor) the badge simply equals the positional unread.
      expect(viewerEvents.map(e => e.kind)).toEqual([
        'unread_updated',
        'attention_badge_updated',
        'notification',
      ]);
      expect(viewerEvents[0]!.payload).toMatchObject({
        conversation_id: mentionsDm!.id,
        conversation_unread_count: expect.any(Number),
        workspace_unread_count: expect.any(Number),
      });
      expect(viewerEvents[2]!.payload).toEqual(
        expect.objectContaining({
          kind: 'mention_external',
          conversation_id: mentionsDm!.id,
        }),
      );
    } finally {
      t.cleanup();
    }
  });

  it('does not republish workspace_channels_changed when reusing the same Mentions DM membership', async () => {
    const t = bootstrap();
    try {
      const first = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first <silverhand://agent/alice>',
      });
      await runMentionCc(t, first);
      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      const second = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second <silverhand://agent/alice>',
      });
      await runMentionCc(t, second);

      expect(t.events.currentSeq(`workspace:${t.aliceHome.id}`)).toBe(1);
      expect(t.events.currentSeq(`conversation:${mentionsDm!.id}`)).toBe(2);
      expect(t.events.replay('viewer:teammate', decodeTransportSeq(0), decodeTransportEpoch('test-epoch')).map(e => e.kind))
        .toEqual([
          'unread_updated',
          'attention_badge_updated',
          'notification',
          'unread_updated',
          'attention_badge_updated',
          'notification',
        ]);
    } finally {
      t.cleanup();
    }
  });

  it('skips unread_updated when the viewer read cursor already covers the wrapped message seq', async () => {
    const t = bootstrap();
    try {
      const first = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first <silverhand://agent/alice>',
      });
      await runMentionCc(t, first);
      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      t.db
        .prepare(
          `INSERT INTO conversation_reads
             (user_id, conversation_id, last_read_seq, read_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('teammate', mentionsDm!.id, 99, Date.now());
      const viewerSeqBeforeSecond = t.events.currentSeq('viewer:teammate');

      const second = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second <silverhand://agent/alice>',
      });
      await runMentionCc(t, second);

      expect(
        t.events
          .replay('viewer:teammate', viewerSeqBeforeSecond, decodeTransportEpoch('test-epoch'))
          .map(e => e.kind),
      ).toEqual(['notification']);
    } finally {
      t.cleanup();
    }
  });

  it('persists notification and publishes viewer events before runtime delivery can fail', async () => {
    const t = bootstrap();
    try {
      t.fake.deliverError = new Error('transport_no_connection');
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'please review even if delivery fails <silverhand://agent/alice>',
      });

      await runMentionCc(t, userMsg);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      const wrappedEvents = t.events.replay(
        `conversation:${mentionsDm!.id}`,
        decodeTransportSeq(0),
        decodeTransportEpoch('test-epoch'),
      );
      expect(wrappedEvents).toHaveLength(1);

      const notifications = t.notifications.list({ userId: 'teammate' });
      expect(notifications).toEqual([
        expect.objectContaining({
          kind: 'mention_external',
          conversation_id: mentionsDm!.id,
          message_id: expect.any(String),
        }),
      ]);
      expect(t.events.replay('viewer:teammate', decodeTransportSeq(0), decodeTransportEpoch('test-epoch')).map(e => e.kind))
        .toEqual(['unread_updated', 'attention_badge_updated', 'notification']);
      expect(t.fake.delivered).toHaveLength(0);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: 'alice',
          sourceConversationId: t.sourceChannel.id,
          sourceMessageId: userMsg.id,
          err: t.fake.deliverError,
        }),
        'mention-cc: delivery failed for one recipient; continuing',
      );
    } finally {
      t.cleanup();
    }
  });

  it('logs unknown mention handles at info level', async () => {
    const t = bootstrap();
    try {
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey <silverhand://agent/ghost>',
      });

      await runMentionCc(t, userMsg);

      expect(t.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mention_cc.skip',
          reason: 'unknown_handle',
          handle: 'ghost',
        }),
        expect.any(String),
      );
      expect(t.fake.delivered).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it('logs source-member mentions at info level instead of duplicating into a DM', async () => {
    const t = bootstrap();
    try {
      t.conversations.addAgent(t.sourceChannel.id, t.alice.id);
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey <silverhand://agent/alice>',
      });

      await runMentionCc(t, userMsg);

      expect(t.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mention_cc.skip',
          reason: 'already_member',
          handle: 'alice',
          agentId: t.alice.id,
        }),
        expect.any(String),
      );
      expect(
        t.conversations.findDmChannelForAgent(t.alice.id, { title: 'Mentions' }),
      ).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('logs missing agent DM channels at warn level', async () => {
    const t = bootstrap();
    try {
      const bob = t.agents.create(
        { name: 'bob', runtime: 'claude' },
        t.alice.host_id,
        'local',
      );
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey <silverhand://agent/bob>',
      });

      await runMentionCc(t, userMsg);

      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mention_cc.skip',
          reason: 'missing_agent_dm',
          handle: 'bob',
          agentId: bob.id,
        }),
        expect.any(String),
      );
      expect(t.fake.delivered).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});

/**
 * The two statements this use case no longer prepares itself (#task:1982 W2).
 * Moving them onto existing repo methods is only safe if the methods carry the
 * SAME semantics, and neither property is visible from the mention-cc scenarios
 * above: the role default is invisible while nothing reads it, and the cursor
 * lookup is stream-qualified in a way a mainline-only test cannot distinguish.
 * These pin both so a later change to either method reddens HERE rather than
 * silently granting governance or reading an arbitrary thread's cursor.
 */
describe('mention-cc — the equivalence its delegations rest on', () => {
  it('addUserMember defaults to plain member and is idempotent over an existing row', () => {
    const t = bootstrap();
    try {
      const first = t.workspaces.addUserMember(t.aliceHome.id, 'teammate');
      // The bare INSERT this replaced omitted `role` and took the column's
      // DEFAULT 'member'; the method's default argument must be the same.
      expect(first.role).toBe('member');

      // Idempotent in the INSERT OR IGNORE sense: an existing row is left
      // ALONE, not overwritten. A method that upserted would silently demote a
      // human who had since been promoted — mention-cc runs on every mention.
      t.workspaces.setOwnerUserId(t.aliceHome.id, 'teammate');
      const again = t.workspaces.addUserMember(t.aliceHome.id, 'teammate');
      expect(again.role).toBe('owner');
      expect(again.joined_at).toBe(first.joined_at);
      expect(t.workspaces.getUserRole(t.aliceHome.id, 'teammate')).toBe('owner');
    } finally {
      t.cleanup();
    }
  });

  it('getLastReadSeq answers per stream — mainline and a thread root are distinct cursors', () => {
    const t = bootstrap();
    try {
      const reads = new ConversationReadRepo(t.db);
      const root = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'thread root',
      });

      // No cursor row yet → 0, on both streams. This is the `?? 0` the old
      // inline SELECT applied, and it is what makes an unread mention publish.
      expect(reads.getLastReadSeq('teammate', t.sourceChannel.id, null)).toBe(0);
      expect(reads.getLastReadSeq('teammate', t.sourceChannel.id, root.id)).toBe(0);

      reads.markRead({
        viewerUserId: 'teammate',
        conversationId: t.sourceChannel.id,
        threadRootId: null,
        seq: 7,
      });
      // `thread_root_id IS ?` — a mainline cursor must NOT answer for a thread,
      // and vice versa. An unqualified lookup would return an arbitrary row.
      expect(reads.getLastReadSeq('teammate', t.sourceChannel.id, null)).toBe(7);
      expect(reads.getLastReadSeq('teammate', t.sourceChannel.id, root.id)).toBe(0);

      reads.markRead({
        viewerUserId: 'teammate',
        conversationId: t.sourceChannel.id,
        threadRootId: root.id,
        seq: 3,
      });
      expect(reads.getLastReadSeq('teammate', t.sourceChannel.id, root.id)).toBe(3);
      expect(reads.getLastReadSeq('teammate', t.sourceChannel.id, null)).toBe(7);

      // Another viewer shares neither cursor.
      expect(reads.getLastReadSeq('other', t.sourceChannel.id, null)).toBe(0);
    } finally {
      t.cleanup();
    }
  });
});

/**
 * What the generic roster-adapter rollback test CANNOT show (#task:1987): that
 * this use case's own orchestration keeps all three placement writes inside the
 * one transaction, and keeps every effect after it. Move one write out of the
 * callback and the scenarios above stay green — they only ever observe the happy
 * path. So the fault is injected into the PRODUCTION composition's roster scope
 * (every other port stays the real one) and the assertion is about what did NOT
 * happen.
 */
describe('ccMentionsFromUserMessage — the placement is one unit, and effects follow it', () => {
  type RosterFace = 'addConversationMember' | 'addWorkspaceHumanMembership';

  /** Wrap the real roster UnitOfWork so the nth call of one face throws INSIDE
   *  the transaction. Calls before it delegate for real, which is what makes the
   *  rollback observable rather than vacuous. */
  function rosterFailingAt(
    roster: WorkspaceRosterUnitOfWork,
    failOn: (face: RosterFace, nth: number) => boolean,
  ): WorkspaceRosterUnitOfWork {
    return {
      atomicallyForWorkspace: (workspaceId, fn) =>
        roster.atomicallyForWorkspace(workspaceId, tx => {
          const seen: Record<RosterFace, number> = {
            addConversationMember: 0,
            addWorkspaceHumanMembership: 0,
          };
          const gate = (face: RosterFace): void => {
            seen[face] += 1;
            if (failOn(face, seen[face])) {
              throw new Error(`injected ${face} #${seen[face]} failure`);
            }
          };
          return fn(
            overrideScope(tx, {
              roster: overrideScope(tx.roster, {
                addConversationMember: (conversationId, member) => {
                  gate('addConversationMember');
                  return tx.roster.addConversationMember(conversationId, member);
                },
                addWorkspaceHumanMembership: userId => {
                  gate('addWorkspaceHumanMembership');
                  tx.roster.addWorkspaceHumanMembership(userId);
                },
              }),
            }),
          );
        }),
    };
  }

  async function runWithRosterFault(
    t: ReturnType<typeof bootstrap>,
    message: MessageDto,
    failOn: (face: RosterFace, nth: number) => boolean,
  ): Promise<void> {
    const composition = createMentionCcComposition({
      db: t.db,
      runtimeHost: t.fake as unknown as AgentRuntimeHost,
      events: t.events,
      logger: t.logger,
    });
    await ccMentionsFromUserMessage({
      ...composition,
      roster: rosterFailingAt(composition.roster, failOn),
      message,
      sourceConversation: t.sourceChannel,
      sourceWorkspace: t.sourceWorkspace,
      references: extractMessageReferences(message.content),
    });
  }

  /** Everything the placement transaction and its follow-up effects would have
   *  produced, read back through repos (no new native SQL) / the event bus.
   *
   *  The Mentions DM is located WITHOUT the agent-membership join
   *  `findDmChannelForAgent` uses: after a rolled-back placement the row exists
   *  with no member, so that finder cannot see it — and the assertions below are
   *  about the rows inside it, which would silently pass against `null`. */
  function observeAftermath(t: ReturnType<typeof bootstrap>) {
    const mentionsDm =
      t.conversations
        .list()
        .find(
          c =>
            c.kind === 'dm_channel'
            && c.workspace_id === t.aliceHome.id
            && c.title === 'Mentions',
        ) ?? null;
    const inDm = <T>(read: (conversationId: string) => T, fallback: T): T =>
      mentionsDm ? read(mentionsDm.id) : fallback;
    return {
      mentionsDm,
      agentMembers: inDm(id => t.conversations.listAgents(id).length, 0),
      humanMembers: inDm(id => t.conversations.listUsers(id).length, 0),
      homeHumanMembers: t.workspaces.listUserMembers(t.aliceHome.id).length,
      wrappedMessages: inDm(id => t.messages.listForConversation(id).length, 0),
      notifications: t.notifications.list({ userId: 'teammate' }).length,
      topologySeq: Number(t.events.currentSeq(`workspace:${t.aliceHome.id}`)),
      conversationSeq: inDm(id => Number(t.events.currentSeq(`conversation:${id}`)), 0),
      viewerSeq: Number(t.events.currentSeq('viewer:teammate')),
      delivered: t.fake.delivered.length,
    };
  }

  for (const [label, failOn] of [
    [
      // The 2nd face: the agent's conversation edge is already written when the
      // human's fails.
      'the human conversation edge (2nd write)',
      (face: RosterFace, nth: number) => face === 'addConversationMember' && nth === 2,
    ],
    [
      // The 3rd face: BOTH conversation edges are written when the workspace row
      // fails — the case that used to leave a Mentions DM its own author could
      // not open.
      'the workspace membership row (3rd write)',
      (face: RosterFace) => face === 'addWorkspaceHumanMembership',
    ],
  ] as const) {
    it(`rolls the whole placement back when ${label} fails, and fires no effect`, async () => {
      const t = bootstrap();
      try {
        const userMsg = t.messages.insertForConversation({
          conversationId: t.sourceChannel.id,
          fromKind: 'user',
          fromUserId: 'teammate',
          content: 'hey <silverhand://agent/alice> take a look',
        });

        await runWithRosterFault(t, userMsg, failOn);

        const after = observeAftermath(t);
        // The lazy `Mentions` DM itself is created BEFORE the placement
        // transaction, so it survives — a documented residual of this pass
        // (#task:1987), sharpened by this test: because every lookup of it goes
        // through the agent-membership join, the surviving row is UNREACHABLE and
        // the next mention allocates a fresh DM instead of reusing it. Inert
        // (empty, invisible) rather than wrong, and the price of fixing it is
        // widening the membership roster scope with a conversation-creation face.
        expect(after.mentionsDm).not.toBeNull();
        expect(
          t.conversations.findDmChannelForAgent(t.alice.id, { title: 'Mentions' }),
        ).toBeNull();
        expect({
          agentMembers: after.agentMembers,
          humanMembers: after.humanMembers,
          homeHumanMembers: after.homeHumanMembers,
        }).toEqual({ agentMembers: 0, humanMembers: 0, homeHumanMembers: 0 });
        // …and no effect downstream of it may have happened: no wrapped message,
        // no notification row, no topology / message / viewer frame, no runtime
        // delivery. Each of these sits AFTER the callback in `deliverOne`, so a
        // write moved out of the transaction would show up here as a landed row
        // next to a rolled-back membership.
        expect({
          wrappedMessages: after.wrappedMessages,
          notifications: after.notifications,
          topologySeq: after.topologySeq,
          conversationSeq: after.conversationSeq,
          viewerSeq: after.viewerSeq,
          delivered: after.delivered,
        }).toEqual({
          wrappedMessages: 0,
          notifications: 0,
          topologySeq: 0,
          conversationSeq: 0,
          viewerSeq: 0,
          delivered: 0,
        });
        // The failure is swallowed per recipient (one bad mention must not fail
        // the user's send) — but it is LOGGED, not silent.
        expect(t.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ handle: 'alice', err: expect.any(Error) }),
          'mention-cc: delivery failed for one recipient; continuing',
        );
      } finally {
        t.cleanup();
      }
    });
  }
});
