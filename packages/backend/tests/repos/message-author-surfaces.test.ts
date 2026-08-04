import { describe, expect, it } from 'vitest';
import { SearchQueryInputSchema } from '@silverhand/shared';
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SavedMessageRepo } from '../../src/repos/saved-message-repo.js';
import { SearchRepo } from '../../src/repos/search-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

// #task:1791 — the SURFACE contract. Every read surface that renders an author
// (root message, thread repliers + reply-preview, saved, search, attachment
// source) must resolve authorship through the ONE server-authoritative
// MessageAuthorDto: an `active` actor shows its live identity, a hard-deleted
// actor shows its send-time snapshot as `deleted` (never a "@agent" directory
// miss), a live rename propagates, and a legacy row with neither FK nor snapshot
// is `unresolved`. The 5 falsification cells are exhaustively unit-tested on the
// pure resolver; here we prove each surface is actually wired to it end-to-end
// against a real DB (insert captures the snapshot; a hard delete nulls the FK via
// ON DELETE SET NULL while the snapshot survives).

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspace = workspaces.insert({
    name: 'author-surfaces-ws',
    description: null,
  });
  const agents = new AgentRepo(db);
  // `del` authors messages across every surface, then is hard-deleted. `ren` is
  // renamed while alive to prove live propagation.
  const del = agents.create({ name: 'del-agent', runtime: 'claude' }, localHostId, 'local');
  const ren = agents.create({ name: 'ren-agent', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, del.id);
  workspaces.insertMembership(workspace.id, ren.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: 't',
  });
  conversations.addAgent(channel.id, del.id);
  conversations.addAgent(channel.id, ren.id);
  return {
    db,
    channel,
    delId: del.id,
    renId: ren.id,
    repo: new MessageRepo(db),
  };
}

const activeAgent = (id: string, name: string, display_name: string) => ({
  kind: 'agent' as const,
  status: 'active' as const,
  id,
  name,
  display_name,
  avatar_url: null,
  // Fixture agents are created with runtime 'claude'; every active-agent surface
  // must carry the CURRENT runtime (#task:1791, option (b)).
  runtime: 'claude' as const,
});
const deletedAgent = (id: string, name: string, display_name: string) => ({
  kind: 'agent' as const,
  status: 'deleted' as const,
  id,
  name,
  display_name,
  avatar_url: null,
});

/** Simulate the delete authority commit's effect on message rows: the `agents`
 *  row is gone, so `messages.from_agent_id` is nulled by ON DELETE SET NULL while
 *  the send-time `author_*` snapshot survives. The delete ORCHESTRATION (purge,
 *  teardown, publish) is covered by the delete-agent use-case tests; here we only
 *  need the post-commit DB state the read surfaces resolve against. */
function hardDeleteAgent(db: Db, id: string): void {
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
}

describe('MessageAuthorDto surface contract (#task:1791)', () => {
  it('root message (getById): active → deleted snapshot after a hard delete', () => {
    const { db, channel, delId, repo } = bootstrap();
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'root by del',
    });
    // The insert already resolves an active author from the live row.
    expect(msg.author).toEqual(activeAgent(delId, 'del-agent', 'del-agent'));
    expect(repo.getById(msg.id)!.author).toEqual(
      activeAgent(delId, 'del-agent', 'del-agent'),
    );

    hardDeleteAgent(db, delId);
    // FK nulled, snapshot survives → deleted (NOT unresolved, NOT a live miss).
    expect(repo.getById(msg.id)!.author).toEqual(
      deletedAgent(delId, 'del-agent', 'del-agent'),
    );
  });

  it('thread repliers + reply preview: distinct-replier + preview author both flip to deleted', () => {
    const { db, channel, delId, repo } = bootstrap();
    // Root by the fixture user 'local' (stays active); reply by `del`.
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'thread root',
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'reply by del',
      threadRootId: root.id,
    });

    const rootAuthorActive = {
      kind: 'user' as const,
      status: 'active' as const,
      id: 'local',
      name: 'local-test',
      display_name: 'Local Test User',
      avatar_url: null,
      // active-user carries no runtime → pinned null.
      runtime: null,
    };
    const before = repo.listChannelThreads(channel.id, 'local', {}).threads[0]!;
    expect(before.root_author).toEqual(rootAuthorActive);
    expect(before.repliers).toEqual([activeAgent(delId, 'del-agent', 'del-agent')]);
    const previewBefore = repo.replyPreviewsByRoot(channel.id, [root.id])[root.id]!;
    expect(previewBefore[0]!.author).toEqual(activeAgent(delId, 'del-agent', 'del-agent'));

    hardDeleteAgent(db, delId);

    const after = repo.listChannelThreads(channel.id, 'local', {}).threads[0]!;
    // Root author (live user) unaffected; the deleted replier resolves to its
    // snapshot — same DTO on the distinct-replier axis and the preview axis.
    expect(after.root_author).toEqual(rootAuthorActive);
    expect(after.repliers).toEqual([deletedAgent(delId, 'del-agent', 'del-agent')]);
    const previewAfter = repo.replyPreviewsByRoot(channel.id, [root.id])[root.id]!;
    expect(previewAfter[0]!.author).toEqual(deletedAgent(delId, 'del-agent', 'del-agent'));
  });

  it('saved messages: the saved DTO carries the same author, flipping to deleted', () => {
    const { db, channel, delId, repo } = bootstrap();
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'saved by del',
    });
    const saved = new SavedMessageRepo(db);
    expect(saved.save(msg.id, 'local')).not.toBeNull();

    const before = saved.list().find(s => s.message.id === msg.id)!;
    expect(before.message.author).toEqual(activeAgent(delId, 'del-agent', 'del-agent'));

    hardDeleteAgent(db, delId);
    const after = saved.list().find(s => s.message.id === msg.id)!;
    expect(after.message.author).toEqual(deletedAgent(delId, 'del-agent', 'del-agent'));
  });

  it('search: message hits carry the same author, flipping to deleted', () => {
    const { db, channel, delId, repo } = bootstrap();
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'zqvq needle authored by del',
    });
    const search = new SearchRepo(db);
    const query = SearchQueryInputSchema.parse({ q: 'zqvq' });
    const findHit = () =>
      search
        .search(query, { visibleUserId: 'local' })
        .results.find(r => r.type === 'message' && r.message.id === msg.id) as
        | { type: 'message'; message: { author: unknown } }
        | undefined;

    expect(findHit()!.message.author).toEqual(
      activeAgent(delId, 'del-agent', 'del-agent'),
    );

    hardDeleteAgent(db, delId);
    expect(findHit()!.message.author).toEqual(
      deletedAgent(delId, 'del-agent', 'del-agent'),
    );
  });

  it('attachment source: the reference source author flips to deleted', () => {
    const { db, channel, delId, repo } = bootstrap();
    const attachments = new AttachmentRepo(db);
    // The reference scan joins the `attachments` table, so the row must exist —
    // the metadata reference alone is not enough.
    const att = attachments.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'x.png',
      size: 10,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/x.png',
      createdByKind: 'agent',
      createdById: delId,
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'has an attachment',
      attachments: [
        { id: att.id, filename: 'x.png', size: 10, content_type: 'image/png' },
      ],
    });
    const item = () =>
      attachments
        .listChannelReferences(channel.id, { limit: 50 })
        .items.find(i => i.attachment.id === att.id)!;

    expect(item().source.author).toEqual(activeAgent(delId, 'del-agent', 'del-agent'));

    hardDeleteAgent(db, delId);
    expect(item().source.author).toEqual(deletedAgent(delId, 'del-agent', 'del-agent'));
  });

  it('renamed: a live rename propagates to the author (snapshot never shadows a live actor)', () => {
    const { db, channel, renId, repo } = bootstrap();
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: renId,
      content: 'authored before rename',
    });
    // Snapshot captured 'ren-agent' at send time.
    expect(msg.author).toEqual(activeAgent(renId, 'ren-agent', 'ren-agent'));

    db.prepare(`UPDATE agents SET name = ?, display_name = ? WHERE id = ?`).run(
      'renamed-agent',
      'Renamed Agent',
      renId,
    );
    // Still active (FK intact) → CURRENT identity, NOT the stale send-time snapshot.
    expect(repo.getById(msg.id)!.author).toEqual(
      activeAgent(renId, 'renamed-agent', 'Renamed Agent'),
    );
  });

  it('legacy-unknown: a row with neither FK nor snapshot resolves to unresolved (never a fabricated deleted)', () => {
    const { db, channel, delId, repo } = bootstrap();
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'legacy row',
    });
    // Simulate a pre-snapshot-column row whose actor was already deleted: null
    // BOTH the live FK and the snapshot columns.
    db.prepare(
      `UPDATE messages
          SET from_agent_id = NULL, author_id = NULL,
              author_name = NULL, author_display_name = NULL
        WHERE id = ?`,
    ).run(msg.id);

    expect(repo.getById(msg.id)!.author).toEqual({
      kind: 'agent',
      status: 'unresolved',
      id: null,
      name: null,
      display_name: null,
      avatar_url: null,
    });
  });
});
