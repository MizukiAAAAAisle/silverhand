import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import {
  AttachmentRepo,
  InvalidAttachmentListCursorError,
  decodeAttachmentListCursor,
  encodeAttachmentListCursor,
  rowToDto,
  rowToSnapshot,
} from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspace = workspaces.insert({
    name: fixedWorkspaceName('att-ws'),
    description: null,
  });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('t'),
  });
  conversations.addAgent(channel.id, agent.id);
  return { db, channel, conversations, workspaces, workspace, agentId: agent.id, localHostId };
}

describe('AttachmentRepo', () => {
  it('inserts and retrieves a row by id', () => {
    const { db, channel } = bootstrap();
    const repo = new AttachmentRepo(db);
    const dto = repo.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'x.png',
      size: 12,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/abc.png',
      createdByKind: 'user',
      createdById: 'local',
    });

    expect(dto.id).toBeTruthy();
    expect(dto.filename).toBe('x.png');
    expect(dto.created_by_kind).toBe('user');

    const row = repo.getById(dto.id);
    expect(row).not.toBeNull();
    expect(rowToDto(row!).id).toBe(dto.id);
    expect(rowToSnapshot(row!)).toEqual({
      id: dto.id,
      filename: 'x.png',
      size: 12,
      content_type: 'image/png',
    });
  });

  it('listByIds preserves filtering and listByChannel returns owned rows', () => {
    const { db, channel } = bootstrap();
    const repo = new AttachmentRepo(db);
    const a = repo.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'a.png',
      size: 1,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/a.png',
      createdByKind: 'user',
      createdById: 'local',
    });
    const b = repo.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'b.png',
      size: 1,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/b.png',
      createdByKind: 'user',
      createdById: 'local',
    });

    const fetched = repo.listByIds([a.id, b.id, 'missing']);
    expect(fetched.map(r => r.id).sort()).toEqual([a.id, b.id].sort());

    const owned = repo.listByChannel(channel.id);
    expect(owned).toHaveLength(2);
  });

  it('cascades on channel delete and SET NULL on source conversation delete', () => {
    const { db, channel, conversations, workspace } = bootstrap();
    const sourceConv = conversations.insertChannel({
      workspaceId: workspace.id,
      title: fixedConversationTitle('source'),
    });
    const repo = new AttachmentRepo(db);
    const dto = repo.insert({
      channelId: channel.id,
      sourceConversationId: sourceConv.id,
      filename: 'x.png',
      size: 1,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/x.png',
      createdByKind: 'user',
      createdById: 'local',
    });

    // Source conversation delete → SET NULL on attachments.source_conversation_id.
    db.prepare('DELETE FROM conversations WHERE id = ?').run(sourceConv.id);
    const afterSourceDelete = repo.getById(dto.id);
    expect(afterSourceDelete?.source_conversation_id).toBeNull();

    // Channel delete → CASCADE removes the row.
    db.prepare('DELETE FROM conversations WHERE id = ?').run(channel.id);
    expect(repo.getById(dto.id)).toBeNull();
  });
});

// ── listChannelReferences (#task:1481) ────────────────────────────────────

interface InsertRefOptions {
  channelId: string;
  fromKind?: 'user' | 'agent' | 'system';
  fromUserId?: string | null;
  fromAgentId?: string | null;
  threadRootId?: string | null;
  attachmentIds: string[];
  /** Overrides the message row's `created_at` post-insert so tests can pin
   *  ordering / force ties. */
  createdAt?: number;
}

function insertAttachment(repo: AttachmentRepo, channelId: string, filename: string) {
  return repo.insert({
    channelId,
    sourceConversationId: channelId,
    filename,
    size: 1,
    contentType: filename.endsWith('.png') ? 'image/png' : 'text/plain',
    storage: 'local',
    storageKey: `attachments/${filename}`,
    createdByKind: 'user',
    createdById: 'local',
  });
}

/** Insert a message referencing the given attachment ids. When `createdAt` is
 *  supplied, patches the row's `created_at` after insert so tests can force
 *  specific ordering. */
function insertReferenceMessage(
  db: ReturnType<typeof openTestDb>['db'],
  messages: MessageRepo,
  opts: InsertRefOptions,
) {
  // Build fake AttachmentSnapshot payload — repo query only reads `.id`.
  const attachments = opts.attachmentIds.map(id => ({
    id,
    filename: 'x',
    size: 1,
    content_type: 'text/plain',
  }));
  const msg = messages.insertForConversation({
    conversationId: opts.channelId,
    fromKind: opts.fromKind ?? 'user',
    fromUserId:
      opts.fromUserId ??
      (opts.fromKind === 'agent' || opts.fromKind === 'system' ? null : 'local'),
    fromAgentId: opts.fromAgentId ?? null,
    content: 'msg',
    attachments,
    threadRootId: opts.threadRootId ?? null,
  });
  if (opts.createdAt !== undefined) {
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(
      opts.createdAt,
      msg.id,
    );
    return { ...msg, created_at: opts.createdAt };
  }
  return msg;
}

describe('AttachmentRepo.listChannelReferences', () => {
  it('excludes orphan attachments never referenced by a message', () => {
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const orphan = insertAttachment(attachments, channel.id, 'orphan.png');
    const referenced = insertAttachment(attachments, channel.id, 'used.png');
    const messages = new MessageRepo(db);
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [referenced.id],
    });

    const page = attachments.listChannelReferences(channel.id, { limit: 10 });
    expect(page.items.map(i => i.attachment.id)).toEqual([referenced.id]);
    expect(page.items.find(i => i.attachment.id === orphan.id)).toBeUndefined();
    expect(page.next_cursor).toBeNull();
  });

  it('dedups by attachment id and picks earliest reference deterministically on created_at ties', () => {
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const shared = insertAttachment(attachments, channel.id, 'shared.png');
    const messages = new MessageRepo(db);
    // Two messages, identical created_at — the one with the lexicographically
    // smaller `id` must win as source. Falsifies MIN(created_at) + independent
    // field pick (which would non-deterministically drift message_id).
    const first = insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [shared.id],
      createdAt: 1000,
      fromKind: 'user',
      fromUserId: 'local',
    });
    const second = insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [shared.id],
      createdAt: 1000,
      fromKind: 'user',
      fromUserId: 'local',
    });
    const expectedWinner = first.id < second.id ? first.id : second.id;

    const page = attachments.listChannelReferences(channel.id, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.source.message_id).toBe(expectedWinner);
    expect(page.items[0]!.source.appeared_at).toBe(1000);

    // Repeat the query to catch any non-determinism (a hypothetical
    // MIN(created_at) + independent id pick would surface here as a flake).
    for (let i = 0; i < 3; i++) {
      const again = attachments.listChannelReferences(channel.id, { limit: 10 });
      expect(again.items[0]!.source.message_id).toBe(expectedWinner);
    }
  });

  it('includes thread reply references under the parent channel scan', () => {
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const anchor = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'anchor',
    });
    const threaded = insertAttachment(attachments, channel.id, 'in-thread.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [threaded.id],
      threadRootId: anchor.id,
    });

    const page = attachments.listChannelReferences(channel.id, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.attachment.id).toBe(threaded.id);
    expect(page.items[0]!.source.thread_root_id).toBe(anchor.id);
    expect(page.items[0]!.source.conversation_id).toBe(channel.id);
  });

  it('paginates by (appeared_at DESC, attachment_id DESC) with a stable cursor round-trip', () => {
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    // Four attachments with distinct created_at → deterministic DESC order.
    const a1 = insertAttachment(attachments, channel.id, 'a1.png');
    const a2 = insertAttachment(attachments, channel.id, 'a2.png');
    const a3 = insertAttachment(attachments, channel.id, 'a3.png');
    const a4 = insertAttachment(attachments, channel.id, 'a4.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [a1.id],
      createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [a2.id],
      createdAt: 200,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [a3.id],
      createdAt: 300,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [a4.id],
      createdAt: 400,
    });

    const first = attachments.listChannelReferences(channel.id, { limit: 2 });
    expect(first.items.map(i => i.attachment.id)).toEqual([a4.id, a3.id]);
    expect(first.next_cursor).not.toBeNull();
    expect(first.next_cursor).toEqual({
      appearedAt: 300,
      attachmentId: a3.id,
    });

    const second = attachments.listChannelReferences(channel.id, {
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(second.items.map(i => i.attachment.id)).toEqual([a2.id, a1.id]);
    expect(second.next_cursor).toBeNull();

    // Cursor codec round-trip: base64url JSON tuple that decodes back verbatim.
    const encoded = encodeAttachmentListCursor(first.next_cursor!);
    expect(decodeAttachmentListCursor(encoded)).toEqual(first.next_cursor);
  });

  it('breaks appeared_at ties by attachment_id DESC across pages', () => {
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const shared = 500;
    // Force three tied appeared_at values with attachment ids ordered by
    // the fixed lex order returned in the DTO (attachment ids are random,
    // so we pin the DESC order by post-hoc sorting expectations).
    const att = [
      insertAttachment(attachments, channel.id, 'z1.png'),
      insertAttachment(attachments, channel.id, 'z2.png'),
      insertAttachment(attachments, channel.id, 'z3.png'),
    ];
    for (const a of att) {
      insertReferenceMessage(db, messages, {
        channelId: channel.id,
        attachmentIds: [a.id],
        createdAt: shared,
      });
    }
    const expectedDesc = att.map(a => a.id).sort((a, b) => (a < b ? 1 : -1));

    const first = attachments.listChannelReferences(channel.id, { limit: 2 });
    expect(first.items.map(i => i.attachment.id)).toEqual(expectedDesc.slice(0, 2));
    expect(first.next_cursor).toEqual({
      appearedAt: shared,
      attachmentId: expectedDesc[1],
    });

    const second = attachments.listChannelReferences(channel.id, {
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(second.items.map(i => i.attachment.id)).toEqual([expectedDesc[2]]);
    expect(second.next_cursor).toBeNull();
  });

  it('surfaces the source actor from the reference message, not the blob uploader', () => {
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    // Blob uploader = local user (bootstrap default). Referencing message is
    // sent by the agent — the panel must surface the message sender, not the
    // uploader (they are separate axes: `AttachmentDto.created_by_*` vs
    // `source.from_*`).
    const att = insertAttachment(attachments, channel.id, 'shared.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [att.id],
      fromKind: 'agent',
      fromAgentId: agentId,
    });

    const page = attachments.listChannelReferences(channel.id, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.source.from_kind).toBe('agent');
    expect(page.items[0]!.source.from_agent_id).toBe(agentId);
    expect(page.items[0]!.source.from_user_id).toBeNull();
    // The blob's `created_by_*` axis stays independent — uploader was the
    // local user, not the agent.
    expect(page.items[0]!.attachment.created_by_kind).toBe('user');
    expect(page.items[0]!.attachment.created_by_id).toBe('local');
  });

  it('rejects a tampered cursor with a typed error', () => {
    expect(() => decodeAttachmentListCursor('not-base64url!!!')).toThrow(
      InvalidAttachmentListCursorError,
    );
    expect(() =>
      decodeAttachmentListCursor(Buffer.from('"scalar"', 'utf8').toString('base64url')),
    ).toThrow(InvalidAttachmentListCursorError);
    expect(() =>
      decodeAttachmentListCursor(Buffer.from('[123]', 'utf8').toString('base64url')),
    ).toThrow(InvalidAttachmentListCursorError);
  });

  it('does not fault the list when a channel message holds malformed metadata', () => {
    // Fail-closed JSON guard: a single row with `metadata='not-json'` or a
    // wrong-shape `attachments` field must not throw for the whole channel.
    // A well-formed reference in the same channel still returns.
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    // Seed a regular reference first so the healthy path has data.
    const healthy = insertAttachment(attachments, channel.id, 'healthy.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [healthy.id],
    });
    // Now inject three malformed metadata shapes via direct SQL — mirroring
    // legacy/tampered rows the app-level writers never emit today. Each row
    // shares the healthy row's conversation_id.
    for (const [i, metadata] of [
      'not-json',
      // Valid JSON, but attachments is a scalar not an array.
      JSON.stringify({ attachments: 'oops' }),
      // Valid JSON array, but items are scalar / lack id / have non-text id.
      JSON.stringify({ attachments: ['bare-string', 42, { name: 'no-id' }, { id: 123 }] }),
    ].entries()) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, from_kind, from_user_id, content, metadata, seq, created_at, thread_root_id)
             VALUES (?, ?, 'user', 'local', 'garbage', ?, ?, ?, NULL)`,
      ).run(
        `bad-meta-${i}`,
        channel.id,
        metadata,
        // Fresh seq high enough not to collide with the healthy row.
        100 + i,
        2000 + i,
      );
    }

    const page = attachments.listChannelReferences(channel.id, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.attachment.id).toBe(healthy.id);
    expect(page.next_cursor).toBeNull();
  });

  it('filters cross-channel attachment references — join reasserts channel boundary', () => {
    // A tampered/legacy message in channel B references an attachment that
    // belongs to channel A. The route already gates the caller on B via
    // `canViewConversation`, but the join must independently drop the row
    // so that B's Attachments panel never leaks A's blob metadata (filename,
    // uploader, storage kind, etc.) — this is the DB-side boundary
    // reassertion.
    const { db, workspace, conversations } = bootstrap();
    const channelA = conversations.insertChannel({
      workspaceId: workspace.id,
      title: fixedConversationTitle('A'),
    });
    const channelB = conversations.insertChannel({
      workspaceId: workspace.id,
      title: fixedConversationTitle('B'),
    });
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    // Attachment lives in channel A. A referencing message exists there so
    // channel A's list works normally.
    const attInA = insertAttachment(attachments, channelA.id, 'secret.png');
    insertReferenceMessage(db, messages, {
      channelId: channelA.id,
      attachmentIds: [attInA.id],
    });
    // Channel B holds a message that references A's attachment id — the
    // legacy/tampered shape the guard exists to defend.
    insertReferenceMessage(db, messages, {
      channelId: channelB.id,
      attachmentIds: [attInA.id],
    });

    const pageA = attachments.listChannelReferences(channelA.id, { limit: 10 });
    expect(pageA.items.map(i => i.attachment.id)).toEqual([attInA.id]);
    const pageB = attachments.listChannelReferences(channelB.id, { limit: 10 });
    expect(pageB.items).toEqual([]);
    expect(pageB.next_cursor).toBeNull();
  });
});

// ── Sender / time filters + facets ────────────────────────────────────────

describe('AttachmentRepo.listChannelReferences — filters', () => {
  it('applies the sender filter to the CANONICAL row, not raw refs (no source drift)', () => {
    // `shared` is FIRST referenced by the agent (canonical source), then
    // re-shared by the local user. Filtering by the re-sharer must return
    // NOTHING — the canonical source is the agent's message. This falsifies
    // filter-then-dedup, which would match the user ref, dedup to it, and
    // wrongly surface the attachment with a drifted source (the user's later
    // message) instead of honoring the stable canonical source.
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const shared = insertAttachment(attachments, channel.id, 'shared.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [shared.id],
      fromKind: 'agent',
      fromAgentId: agentId,
      createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [shared.id],
      fromKind: 'user',
      fromUserId: 'local',
      createdAt: 200,
    });

    // Filter by the re-sharer (user) → empty: the canonical source is the agent.
    const byUser = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'user', id: 'local' },
    });
    expect(byUser.items).toEqual([]);

    // Filter by the canonical source (agent) → the attachment, with the
    // canonical (earliest) source preserved.
    const byAgent = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'agent', id: agentId },
    });
    expect(byAgent.items.map(i => i.attachment.id)).toEqual([shared.id]);
    expect(byAgent.items[0]!.source.from_agent_id).toBe(agentId);
    expect(byAgent.items[0]!.source.appeared_at).toBe(100);
  });

  it('filters by each sender kind — user, agent, system', () => {
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const byUserAtt = insertAttachment(attachments, channel.id, 'u.png');
    const byAgentAtt = insertAttachment(attachments, channel.id, 'a.png');
    const bySystemAtt = insertAttachment(attachments, channel.id, 's.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [byUserAtt.id],
      fromKind: 'user',
      fromUserId: 'local',
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [byAgentAtt.id],
      fromKind: 'agent',
      fromAgentId: agentId,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [bySystemAtt.id],
      fromKind: 'system',
    });

    const user = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'user', id: 'local' },
    });
    expect(user.items.map(i => i.attachment.id)).toEqual([byUserAtt.id]);

    const agent = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'agent', id: agentId },
    });
    expect(agent.items.map(i => i.attachment.id)).toEqual([byAgentAtt.id]);

    const system = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'system', id: null },
    });
    expect(system.items.map(i => i.attachment.id)).toEqual([bySystemAtt.id]);
  });

  it('scopes a user sender by id — a different user id yields no rows', () => {
    // The kind alone is not enough; the id must match. Proves the query binds
    // `from_user_id`, not just `from_kind`.
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const att = insertAttachment(attachments, channel.id, 'u.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [att.id],
      fromKind: 'user',
      fromUserId: 'local',
    });

    const match = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'user', id: 'local' },
    });
    expect(match.items.map(i => i.attachment.id)).toEqual([att.id]);

    const other = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'user', id: 'someone-else' },
    });
    expect(other.items).toEqual([]);
  });

  it('applies the half-open [since, until) time window on canonical appeared_at', () => {
    const { db, channel } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const at100 = insertAttachment(attachments, channel.id, 't100.png');
    const at200 = insertAttachment(attachments, channel.id, 't200.png');
    const at300 = insertAttachment(attachments, channel.id, 't300.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [at100.id],
      createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [at200.id],
      createdAt: 200,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [at300.id],
      createdAt: 300,
    });

    // since is INCLUSIVE.
    const since = attachments.listChannelReferences(channel.id, {
      limit: 10,
      since: 200,
    });
    expect(since.items.map(i => i.source.appeared_at)).toEqual([300, 200]);

    // until is EXCLUSIVE.
    const until = attachments.listChannelReferences(channel.id, {
      limit: 10,
      until: 300,
    });
    expect(until.items.map(i => i.source.appeared_at)).toEqual([200, 100]);

    // Combined half-open window [200, 300) → only 200.
    const window = attachments.listChannelReferences(channel.id, {
      limit: 10,
      since: 200,
      until: 300,
    });
    expect(window.items.map(i => i.source.appeared_at)).toEqual([200]);
  });

  it('composes sender and time filters', () => {
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    // Agent references at t=100 and t=300; user reference at t=200.
    const agentEarly = insertAttachment(attachments, channel.id, 'ae.png');
    const userMid = insertAttachment(attachments, channel.id, 'um.png');
    const agentLate = insertAttachment(attachments, channel.id, 'al.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [agentEarly.id],
      fromKind: 'agent',
      fromAgentId: agentId,
      createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [userMid.id],
      fromKind: 'user',
      fromUserId: 'local',
      createdAt: 200,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id,
      attachmentIds: [agentLate.id],
      fromKind: 'agent',
      fromAgentId: agentId,
      createdAt: 300,
    });

    // agent ∩ [200, ∞) → only the late agent reference.
    const page = attachments.listChannelReferences(channel.id, {
      limit: 10,
      sender: { kind: 'agent', id: agentId },
      since: 200,
    });
    expect(page.items.map(i => i.attachment.id)).toEqual([agentLate.id]);
  });

  it('composes a filter with keyset pagination over the filtered set', () => {
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    // Three agent references interleaved with a user reference the filter drops.
    const a1 = insertAttachment(attachments, channel.id, 'a1.png');
    const a2 = insertAttachment(attachments, channel.id, 'a2.png');
    const a3 = insertAttachment(attachments, channel.id, 'a3.png');
    const u1 = insertAttachment(attachments, channel.id, 'u1.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [a1.id], fromKind: 'agent',
      fromAgentId: agentId, createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [u1.id], fromKind: 'user',
      fromUserId: 'local', createdAt: 250,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [a2.id], fromKind: 'agent',
      fromAgentId: agentId, createdAt: 200,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [a3.id], fromKind: 'agent',
      fromAgentId: agentId, createdAt: 300,
    });

    const first = attachments.listChannelReferences(channel.id, {
      limit: 2,
      sender: { kind: 'agent', id: agentId },
    });
    expect(first.items.map(i => i.attachment.id)).toEqual([a3.id, a2.id]);
    expect(first.next_cursor).not.toBeNull();

    const second = attachments.listChannelReferences(channel.id, {
      limit: 2,
      sender: { kind: 'agent', id: agentId },
      cursor: first.next_cursor,
    });
    // The user reference (u1) never appears — the filter holds across pages.
    expect(second.items.map(i => i.attachment.id)).toEqual([a1.id]);
    expect(second.next_cursor).toBeNull();
  });
});

describe('AttachmentRepo.listChannelSenderFacets', () => {
  it('returns only canonical-source actors — a re-share-only sender is excluded', () => {
    // `x` is canonical-sourced by the agent, then re-shared by the user; the
    // user is NOT a canonical source, so must not appear as a facet (offering
    // them would be a dead dropdown option). `y` is canonical-sourced by the
    // user, which is why the user still appears — via y, not the x re-share.
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const x = insertAttachment(attachments, channel.id, 'x.png');
    const y = insertAttachment(attachments, channel.id, 'y.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [x.id], fromKind: 'agent',
      fromAgentId: agentId, createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [x.id], fromKind: 'user',
      fromUserId: 'local', createdAt: 200,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [y.id], fromKind: 'user',
      fromUserId: 'local', createdAt: 150,
    });

    const facets = attachments.listChannelSenderFacets(channel.id);
    expect(facets).toEqual([
      { from_kind: 'agent', from_user_id: null, from_agent_id: agentId },
      { from_kind: 'user', from_user_id: 'local', from_agent_id: null },
    ]);
  });

  it('excludes a re-share-only sender entirely when they are never a canonical source', () => {
    // The agent is ONLY ever a re-sharer (user is always earlier). The agent
    // must not appear in the facet set at all.
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const only = insertAttachment(attachments, channel.id, 'only.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [only.id], fromKind: 'user',
      fromUserId: 'local', createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [only.id], fromKind: 'agent',
      fromAgentId: agentId, createdAt: 200,
    });

    const facets = attachments.listChannelSenderFacets(channel.id);
    expect(facets).toEqual([
      { from_kind: 'user', from_user_id: 'local', from_agent_id: null },
    ]);
  });

  it('orders deterministically by (from_kind, actor id) and is time-independent', () => {
    // Two agents + the local user, each the canonical source of one blob.
    // Facets sort by from_kind ASC ('agent' < 'system' < 'user'), then the
    // actor id — so the two agents order by their ids, independent of insert
    // order or created_at.
    const { db, channel, agentId, localHostId } = bootstrap();
    const agentB = new AgentRepo(db).create(
      { name: 'b', runtime: 'claude' },
      localHostId,
      'local',
    );
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const forA = insertAttachment(attachments, channel.id, 'fa.png');
    const forB = insertAttachment(attachments, channel.id, 'fb.png');
    const forU = insertAttachment(attachments, channel.id, 'fu.png');
    // Insert in a scrambled time order to prove ordering is by id, not time.
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [forU.id], fromKind: 'user',
      fromUserId: 'local', createdAt: 300,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [forB.id], fromKind: 'agent',
      fromAgentId: agentB.id, createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [forA.id], fromKind: 'agent',
      fromAgentId: agentId, createdAt: 200,
    });

    const facets = attachments.listChannelSenderFacets(channel.id);
    const [firstAgentId, secondAgentId] =
      agentId < agentB.id ? [agentId, agentB.id] : [agentB.id, agentId];
    expect(facets).toEqual([
      { from_kind: 'agent', from_user_id: null, from_agent_id: firstAgentId },
      { from_kind: 'agent', from_user_id: null, from_agent_id: secondAgentId },
      { from_kind: 'user', from_user_id: 'local', from_agent_id: null },
    ]);
  });

  it('reasserts the channel boundary — a cross-channel reference is not a facet', () => {
    const { db, workspace, conversations } = bootstrap();
    const channelA = conversations.insertChannel({
      workspaceId: workspace.id, title: fixedConversationTitle('A'),
    });
    const channelB = conversations.insertChannel({
      workspaceId: workspace.id, title: fixedConversationTitle('B'),
    });
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const attInA = insertAttachment(attachments, channelA.id, 'secret.png');
    insertReferenceMessage(db, messages, {
      channelId: channelA.id, attachmentIds: [attInA.id],
      fromKind: 'user', fromUserId: 'local',
    });
    // Channel B references A's attachment (tampered/legacy) — must not leak
    // into B's facet set.
    insertReferenceMessage(db, messages, {
      channelId: channelB.id, attachmentIds: [attInA.id],
      fromKind: 'user', fromUserId: 'local',
    });

    expect(attachments.listChannelSenderFacets(channelB.id)).toEqual([]);
  });

  it('excludes a dangling actor (hard-deleted canonical source) — wire-inexpressible facet', () => {
    // `from_agent_id` is ON DELETE SET NULL: hard-deleting an agent physically
    // drops its row and nulls the actor id on every message it sent. A
    // canonical source whose agent was hard-deleted therefore survives as
    // from_kind='agent' with a NULL id — which the list's sender wire cannot
    // name (agent requires a non-empty id). Such a facet would be a dead
    // option, so it must be excluded. The attachment itself stays in the
    // unfiltered list (no data hidden); only the unusable filter option is
    // withheld. The local user's own canonical source still shows as a facet.
    const { db, channel, localHostId } = bootstrap();
    const doomed = new AgentRepo(db).create(
      { name: 'doomed', runtime: 'claude' },
      localHostId,
      'local',
    );
    const attachments = new AttachmentRepo(db);
    const messages = new MessageRepo(db);
    const byDoomed = insertAttachment(attachments, channel.id, 'ghost.png');
    const byUser = insertAttachment(attachments, channel.id, 'kept.png');
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [byDoomed.id],
      fromKind: 'agent', fromAgentId: doomed.id, createdAt: 100,
    });
    insertReferenceMessage(db, messages, {
      channelId: channel.id, attachmentIds: [byUser.id],
      fromKind: 'user', fromUserId: 'local', createdAt: 200,
    });

    // Hard delete the agent — FK SET NULL nulls the canonical source's actor id.
    db.prepare('DELETE FROM agents WHERE id = ?').run(doomed.id);
    const nulled = db
      .prepare('SELECT from_kind, from_agent_id FROM messages WHERE from_agent_id IS NULL AND from_kind = ?')
      .all('agent');
    expect(nulled.length).toBeGreaterThan(0);

    // The attachment is still in the unfiltered list, with a null-id agent
    // source — no data hidden.
    const all = attachments.listChannelReferences(channel.id, { limit: 10 });
    const ghost = all.items.find(i => i.attachment.id === byDoomed.id);
    expect(ghost).toBeDefined();
    expect(ghost!.source.from_kind).toBe('agent');
    expect(ghost!.source.from_agent_id).toBeNull();

    // Facets exclude the dangling agent; only the (still-valid) user remains.
    const facets = attachments.listChannelSenderFacets(channel.id);
    expect(facets).toEqual([
      { from_kind: 'user', from_user_id: 'local', from_agent_id: null },
    ]);
  });

  it('excludes cross-shaped canonical actors that the discriminated union rejects', () => {
    // `messages` has no actor-shape CHECK, so a historical / tampered canonical
    // row can carry a shape the sender wire + discriminated facet schema reject:
    // a `user` also bearing an agent id, an `agent` also bearing a user id, or a
    // `system` bearing any id. The facets guard must be the EXACT mirror of the
    // union (present-side id non-empty AND other-side null), so none of these
    // reach the wire; the attachments still appear in the unfiltered list.
    const { db, channel, agentId } = bootstrap();
    const attachments = new AttachmentRepo(db);
    const bothUser = insertAttachment(attachments, channel.id, 'both-user.png');
    const bothAgent = insertAttachment(attachments, channel.id, 'both-agent.png');
    const sysId = insertAttachment(attachments, channel.id, 'sys-id.png');

    // Insert malformed canonical rows directly — the app writers never emit
    // these, so they cannot be built through MessageRepo's normal path.
    const rows: Array<[string, string, string | null, string | null, string]> = [
      ['bad-user', 'user', 'local', agentId, bothUser.id],
      ['bad-agent', 'agent', 'local', agentId, bothAgent.id],
      ['bad-system', 'system', 'local', null, sysId.id],
    ];
    for (const [i, [id, kind, uid, aid, attId]] of rows.entries()) {
      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, from_user_id, from_agent_id,
            content, metadata, seq, created_at, thread_root_id)
         VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?, NULL)`,
      ).run(
        id,
        channel.id,
        kind,
        uid,
        aid,
        JSON.stringify({ attachments: [{ id: attId }] }),
        200 + i,
        3000 + i,
      );
    }

    // All three attachments are visible in the unfiltered list — no data hidden.
    const all = attachments.listChannelReferences(channel.id, { limit: 10 });
    expect(all.items.map(i => i.attachment.id).sort()).toEqual(
      [bothUser.id, bothAgent.id, sysId.id].sort(),
    );

    // But none is offered as a facet — every cross-shaped actor is excluded.
    expect(attachments.listChannelSenderFacets(channel.id)).toEqual([]);
  });
});
