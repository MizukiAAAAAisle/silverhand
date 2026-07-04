import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import {
  LegacyThreadPurgeAbort,
  runLegacyThreadPurge,
} from '../../src/maintenance/legacy-thread-purge.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const conversations = new ConversationRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const messages = new MessageRepo(db);
  const agents = new AgentRepo(db);
  const agent = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const workspacePath = join(tmp.workspacesRoot, 'eng');
  const workspace = workspaces.insert({
    name: 'eng',
    description: '',
    workspacePath,
    workspaceHostId: localHostId,
  });
  workspaces.insertMembership(workspace.id, agent.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 'Planning',
  });
  conversations.addAgent(channel.id, agent.id);
  return { db, conversations, messages, channel, workspace, cleanup: tmp.cleanup };
}

const countThreads = (db: Db): number =>
  (db.prepare(`SELECT count(*) FROM conversations WHERE kind='thread'`).pluck().get() as number) ??
  0;
const countReplyCluster = (db: Db): number =>
  (db
    .prepare(`SELECT count(*) FROM messages WHERE thread_root_id IS NOT NULL`)
    .pluck()
    .get() as number) ?? 0;

let seedSeq = 0;
const nextId = (prefix: string): string => `${prefix}_${(seedSeq += 1)}`;

/**
 * Seed a fossil `kind='thread'` conversation via raw SQL. The producer
 * (`ConversationRepo.insertThread`) and the `thread` kind were retired in
 * #task:1303 phase 2, but the purge device must still handle old/remote DBs
 * that physically contain such rows. This helper reproduces that reality
 * WITHOUT touching the narrowed domain model (no ConversationKindSchema, no
 * repo mapper, no DTO) — exactly the decoupling the device relies on.
 *
 * The `conversations_thread_parent_*` triggers only require the parent to be
 * a channel-like conversation, which `channel` is, so no trigger drop is
 * needed here (contrast the external-guard test, which drops
 * `messages_thread_root_*` to simulate a corrupt row).
 */
function insertFossilThread(
  db: Db,
  channel: { id: string; workspace_id: string; workspace_path: string },
): { id: string } {
  const id = nextId('thread');
  db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, workspace_path, kind, parent_conversation_id,
        title, status, created_at, updated_at, latest_message_seq)
     VALUES (?, ?, ?, 'thread', ?, 'Fossil', 'idle', ?, ?, 0)`,
  ).run(
    id,
    channel.workspace_id,
    channel.workspace_path,
    channel.id,
    Date.now(),
    Date.now(),
  );
  return { id };
}

function insertNotification(
  db: Db,
  cols: {
    conversationId?: string;
    sourceConversationId?: string;
    messageId?: string;
    sourceMessageId?: string;
  },
): string {
  const id = nextId('notif');
  db.prepare(
    `INSERT INTO notifications (id, kind, conversation_id, source_conversation_id, message_id, source_message_id, created_at)
     VALUES (?, 'test', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    cols.conversationId ?? null,
    cols.sourceConversationId ?? null,
    cols.messageId ?? null,
    cols.sourceMessageId ?? null,
    Date.now(),
  );
  return id;
}

function insertAttachment(
  db: Db,
  cols: { channelId: string; sourceConversationId?: string },
): string {
  const id = nextId('att');
  db.prepare(
    `INSERT INTO attachments (id, channel_id, source_conversation_id, filename, size, content_type, storage, storage_key, created_by_kind, created_by_id, created_at)
     VALUES (?, ?, ?, 'f.txt', 1, 'text/plain', 'fs', ?, 'user', 'local', ?)`,
  ).run(id, cols.channelId, cols.sourceConversationId ?? null, `key/${id}`, Date.now());
  return id;
}

function insertSavedMessage(
  db: Db,
  cols: { messageId: string; conversationId: string; workspaceId: string },
): string {
  const id = nextId('saved');
  db.prepare(
    `INSERT INTO saved_messages (id, message_id, conversation_id, workspace_id, saved_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, cols.messageId, cols.conversationId, cols.workspaceId, Date.now());
  return id;
}

const rowExists = (db: Db, table: string, id: string): boolean =>
  ((db.prepare(`SELECT count(*) FROM ${table} WHERE id=?`).pluck().get(id) as number) ?? 0) > 0;

describe('runLegacyThreadPurge', () => {
  it('dry-run reports inventory and writes nothing', () => {
    const t = bootstrap();
    try {
      const thread = insertFossilThread(t.db, t.channel);
      t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f1',
      });
      t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f2',
      });
      expect(countThreads(t.db)).toBe(1);

      const dry = runLegacyThreadPurge(t.db, { apply: false });
      expect(dry.applied).toBe(false);
      expect(dry.inventory.legacyConversations).toBe(1);
      expect(dry.inventory.legacyMessages).toBe(2);
      expect(dry.guard.ok).toBe(true);
      expect(dry.proof).toBeUndefined();
      // nothing written
      expect(countThreads(t.db)).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('apply purges fossils, proves count=0, and leaves the canonical reply-cluster intact', () => {
    const t = bootstrap();
    try {
      // Canonical reply-cluster in the CHANNEL (must survive).
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'root',
      });
      t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'reply-in-thread-cluster',
        threadRootId: root.id,
      });
      expect(countReplyCluster(t.db)).toBe(1);

      // Legacy fossil thread + its messages + referencing stream-head rows
      // (insertForConversation bumps the per-stream head → real refs to purge).
      const thread = insertFossilThread(t.db, t.channel);
      t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f1',
      });
      t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f2',
      });
      expect(countThreads(t.db)).toBe(1);
      const streamHeadsForThread = (): number =>
        (t.db
          .prepare(`SELECT count(*) FROM conversation_stream_heads WHERE conversation_id=?`)
          .pluck()
          .get(thread.id) as number) ?? 0;
      expect(streamHeadsForThread()).toBeGreaterThan(0);

      const res = runLegacyThreadPurge(t.db, { apply: true });
      expect(res.applied).toBe(true);
      expect(res.proof?.remainingLegacyConversations).toBe(0);
      expect(res.proof?.canonicalReplyClusterAfter).toBe(res.proof?.canonicalReplyClusterBefore);
      expect(Object.values(res.proof?.orphans ?? {}).every((n) => n === 0)).toBe(true);

      // fossils gone, canonical reply-cluster untouched
      expect(countThreads(t.db)).toBe(0);
      expect(
        (t.db
          .prepare(`SELECT count(*) FROM messages WHERE conversation_id=?`)
          .pluck()
          .get(thread.id) as number) ?? 0,
      ).toBe(0);
      expect(streamHeadsForThread()).toBe(0);
      expect(countReplyCluster(t.db)).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('aborts (guard fails) when a non-legacy message is rooted at a legacy message', () => {
    const t = bootstrap();
    try {
      const thread = insertFossilThread(t.db, t.channel);
      const fossilMsg = t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f1',
      });
      // Pathological: a live CHANNEL message whose thread_root_id points at a
      // fossil message. Deleting the fossil would CASCADE this live row away.
      // The `messages_thread_root_*` triggers normally forbid cross-conversation
      // roots, so drop them to simulate a corrupt/pre-trigger legacy row — which
      // is exactly the defense-in-depth case the purge guard exists for.
      const channelMsg = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'live',
      });
      t.db.exec(`
        DROP TRIGGER IF EXISTS messages_thread_root_insert;
        DROP TRIGGER IF EXISTS messages_thread_root_update;
      `);
      t.db
        .prepare(`UPDATE messages SET thread_root_id=? WHERE id=?`)
        .run(fossilMsg.id, channelMsg.id);

      const dry = runLegacyThreadPurge(t.db, { apply: false });
      expect(dry.guard.ok).toBe(false);
      expect(dry.guard.externalThreadRootRefs.messages).toBe(1);

      expect(() => runLegacyThreadPurge(t.db, { apply: true })).toThrow(LegacyThreadPurgeAbort);
      // aborted — fossil still present, nothing deleted
      expect(countThreads(t.db)).toBe(1);
      expect(
        (t.db.prepare(`SELECT count(*) FROM messages WHERE id=?`).pluck().get(channelMsg.id) as number) ??
          0,
      ).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('deletes notifications referencing the legacy set via all four ref columns, keeps unrelated ones', () => {
    const t = bootstrap();
    try {
      const thread = insertFossilThread(t.db, t.channel);
      const fossilMsg = t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f1',
      });
      const liveMsg = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'live',
      });
      // One notification per ref column that points into the legacy set…
      insertNotification(t.db, { conversationId: thread.id });
      insertNotification(t.db, { sourceConversationId: thread.id });
      insertNotification(t.db, { messageId: fossilMsg.id });
      insertNotification(t.db, { sourceMessageId: fossilMsg.id });
      // …and a control that only references live rows (must survive).
      const control = insertNotification(t.db, {
        conversationId: t.channel.id,
        messageId: liveMsg.id,
      });

      const dry = runLegacyThreadPurge(t.db, { apply: false });
      expect(dry.inventory.perTable.notifications).toBe(4);

      const res = runLegacyThreadPurge(t.db, { apply: true });
      expect(res.applied).toBe(true);
      expect(res.proof?.orphans.notifications).toBe(0);
      // control notification untouched; the four legacy ones gone.
      expect(rowExists(t.db, 'notifications', control)).toBe(true);
      expect(
        (t.db.prepare(`SELECT count(*) FROM notifications`).pluck().get() as number) ?? 0,
      ).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('deletes saved_messages saved on a legacy message', () => {
    const t = bootstrap();
    try {
      const thread = insertFossilThread(t.db, t.channel);
      const fossilMsg = t.messages.insertForConversation({
        conversationId: thread.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'f1',
      });
      const saved = insertSavedMessage(t.db, {
        messageId: fossilMsg.id,
        conversationId: thread.id,
        workspaceId: t.workspace.id,
      });

      const dry = runLegacyThreadPurge(t.db, { apply: false });
      expect(dry.inventory.perTable.saved_messages).toBe(1);

      const res = runLegacyThreadPurge(t.db, { apply: true });
      expect(res.proof?.orphans.saved_messages).toBe(0);
      expect(rowExists(t.db, 'saved_messages', saved)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('nulls attachment.source_conversation_id sourced from a legacy conversation, keeps the body', () => {
    const t = bootstrap();
    try {
      const thread = insertFossilThread(t.db, t.channel);
      // Attachment lives in the LIVE channel but was sourced from the fossil.
      const att = insertAttachment(t.db, {
        channelId: t.channel.id,
        sourceConversationId: thread.id,
      });

      const dry = runLegacyThreadPurge(t.db, { apply: false });
      expect(dry.inventory.perTable['attachments(null source_conversation_id)']).toBe(1);
      expect(dry.guard.ok).toBe(true); // channel_id is NOT legacy → no abort

      const res = runLegacyThreadPurge(t.db, { apply: true });
      expect(res.proof?.orphans.attachments_source).toBe(0);
      // body kept, dangling source pointer nulled.
      expect(rowExists(t.db, 'attachments', att)).toBe(true);
      expect(
        t.db.prepare(`SELECT source_conversation_id FROM attachments WHERE id=?`).pluck().get(att),
      ).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('aborts when an attachment physically lives in a legacy conversation (channel_id)', () => {
    const t = bootstrap();
    try {
      const thread = insertFossilThread(t.db, t.channel);
      const att = insertAttachment(t.db, { channelId: thread.id });

      const dry = runLegacyThreadPurge(t.db, { apply: false });
      expect(dry.guard.ok).toBe(false);
      expect(dry.guard.legacyChannelAttachments).toBe(1);

      expect(() => runLegacyThreadPurge(t.db, { apply: true })).toThrow(LegacyThreadPurgeAbort);
      // aborted — fossil + attachment still present.
      expect(countThreads(t.db)).toBe(1);
      expect(rowExists(t.db, 'attachments', att)).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
