/**
 * Search — sender narrowing on the author snapshot key (#task:2061).
 *
 * Search and Saved are two faces of ONE question ("messages from X"), and until
 * this ticket they answered it with different predicates: Saved matches the
 * stable send-time snapshot `(m.from_kind, m.author_id)` (#task:2059) while
 * Search matched the live FK (`from_user_id` / `from_agent_id`) — which
 * `ON DELETE SET NULL` clears on a hard delete — and additionally WIDENED the
 * user arm to `from_user_id IS NULL` whenever the filter id equalled the viewer.
 * Both halves are fixed in one commit; the two cells below are one falsifier
 * each, shaped after the sibling `saved-sender-filter.test.ts`:
 *
 *   1. the AGENT arm on a hard-deleted sender — reddens if either arm is put
 *      back on its FK column (this is the reachable half: agent delete is a
 *      real product action, human hard-delete has no code path);
 *   2. an `unresolved` row (neither FK nor snapshot) is matched by NO sender,
 *      the viewer included — reddens if the `includeNullAuthor` widening comes
 *      back. That widening attributed every legacy anonymous row to whoever was
 *      searching, so the same rows counted for two different humans (per-sender
 *      results summed past `total`) while the renderer had always drawn them as
 *      "Unknown user".
 *
 * Cell 2 also carries the USER arm's positive evidence: the viewer's own real
 * message is still found through the snapshot key, so "both arms changed" is
 * covered without a third cell.
 *
 * The equivalence that makes the switch free needs no cell: v63 backfilled
 * `author_id = from_*_id` for every FK-resolved row and every insert since
 * writes the same id into both, so on an actor that still exists the two keys
 * are row-equivalent by construction.
 *
 * `seedAllFixtureMemberships: false` is load-bearing: the fixture trigger would
 * seat every human in every conversation, and the participation conjunction
 * `search()` rests on would stop being observable.
 */
import { describe, expect, it } from 'vitest';
import {
  fixedConversationTitle,
  fixedWorkspaceName,
  SearchQueryInputSchema,
  type SearchResultDto,
} from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SearchRepo } from '../../src/repos/search-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

const NEEDLE = 'zqx-sender-needle';

function messageHits(results: SearchResultDto[]) {
  return results.filter(
    (r): r is Extract<SearchResultDto, { type: 'message' }> => r.type === 'message',
  );
}

function bootstrap() {
  const { db, localHostId, viewerUserId } = openTestDb({
    seedAllFixtureMemberships: false,
  });
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);
  const messages = new MessageRepo(db);
  const search = new SearchRepo(db);

  const ws = workspaces.insert({
    name: fixedWorkspaceName('sender-search-ws'),
    description: null,
  });
  workspaces.addUserMember(ws.id, viewerUserId, 'owner');
  const channel = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('general'),
  });
  conversations.addUser(channel.id, viewerUserId);

  const agent = agents.create(
    { name: 'sender-bot', runtime: 'claude' },
    localHostId,
    viewerUserId,
  );
  workspaces.insertMembership(ws.id, agent.id);
  conversations.addAgent(channel.id, agent.id);

  function find(filter: Record<string, unknown>) {
    const found = search.search(
      SearchQueryInputSchema.parse({ q: NEEDLE, limit: 50, ...filter }),
      viewerUserId,
    );
    return {
      ids: messageHits(found.results).map(r => r.message.id),
      hits: messageHits(found.results),
      total: found.total,
    };
  }

  return { agents, agent, messages, channel, viewerUserId, find };
}

describe('SearchRepo — sender narrowing on the snapshot key (#task:2061)', () => {
  it('still finds a hard-deleted agent sender (the FK-predicate falsifier)', () => {
    const t = bootstrap();
    const byAgent = t.messages.insertForConversation({
      conversationId: t.channel.id,
      fromKind: 'agent',
      fromAgentId: t.agent.id,
      content: `${NEEDLE} from an agent about to be deleted`,
    });
    const byViewer = t.messages.insertForConversation({
      conversationId: t.channel.id,
      fromKind: 'user',
      fromUserId: t.viewerUserId,
      content: `${NEEDLE} from the human`,
    });
    // The delete authority's post-commit state: the `agents` row is gone, so
    // `messages.from_agent_id` is nulled by ON DELETE SET NULL while the
    // send-time `author_*` snapshot survives (#task:1791).
    t.agents.delete(t.agent.id);

    const filtered = t.find({ agent_id: t.agent.id });
    expect(filtered.ids).toEqual([byAgent.id]);
    // The DTO proves the FK really is gone (`deleted`, not `active`) AND that the
    // id the hit renders is the id that filtered it — the same value in both
    // states, which is what keeps a picker selection a valid filter across a
    // delete.
    expect(filtered.hits[0]!.message.author).toMatchObject({
      status: 'deleted',
      id: t.agent.id,
    });
    // `total` moves with the rows (COUNT and the row query share one FROM/WHERE),
    // and `from_kind` is a real conjunct: the same id under the user arm matches
    // nothing, so the two id namespaces never cross-match.
    expect(filtered.total).toBe(1);
    expect(t.find({ user_id: t.agent.id }).ids).toEqual([]);
    // Differential: unfiltered, both messages are still searchable — the absence
    // above is the sender predicate, not a lost row.
    expect(t.find({}).ids.sort()).toEqual([byAgent.id, byViewer.id].sort());
  });

  it('matches an unresolved (FK-less, snapshot-less) row under NO sender, the viewer included', () => {
    const t = bootstrap();
    // A pre-principal-middleware row, reproduced through the production insert:
    // `from_kind='user'` with no user id at all, so BOTH the live FK and the
    // author snapshot are NULL — exactly the legacy shape that resolves to
    // `unresolved` and renders as "Unknown user".
    const anonymous = t.messages.insertForConversation({
      conversationId: t.channel.id,
      fromKind: 'user',
      content: `${NEEDLE} from nobody identifiable`,
    });
    const byViewer = t.messages.insertForConversation({
      conversationId: t.channel.id,
      fromKind: 'user',
      fromUserId: t.viewerUserId,
      content: `${NEEDLE} from the viewer`,
    });

    // Control: the row IS searchable and IS anonymous, so the exclusions below
    // are attribution decisions rather than a missing row.
    const unfiltered = t.find({});
    expect(unfiltered.ids.sort()).toEqual([anonymous.id, byViewer.id].sort());
    expect(
      unfiltered.hits.find(r => r.message.id === anonymous.id)!.message.author,
    ).toMatchObject({ status: 'unresolved', id: null });

    // The viewer's own filter returns the viewer's REAL message only — this is
    // both the user arm's positive evidence (it resolves through the snapshot)
    // and the deleted widening's falsifier (the anonymous row is not the
    // viewer's).
    const asViewer = t.find({ user_id: t.viewerUserId });
    expect(asViewer.ids).toEqual([byViewer.id]);
    expect(asViewer.total).toBe(1);
    // And it is not another human's either: an unresolved row has no nameable
    // identity, so it belongs to no sender rather than to everyone who asks.
    expect(t.find({ user_id: 'alice' }).ids).toEqual([]);
  });
});
