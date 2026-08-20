/**
 * #task:2053 — Message search includes workspace-less human↔agent DirectPair
 * messages, and its visibility rests on the ONE participation authority
 * (`userParticipates`) instead of a search-local bare `conversation_users`
 * EXISTS + `workspacePlaced` hard predicate.
 *
 * Every exclusion below is asserted as a DIFFERENTIAL: a control that IS
 * returned proves the query is not just returning nothing, so an absent row is
 * a DOMAIN decision, not an incidental drop. `seedAllFixtureMemberships: false`
 * is load-bearing — the fixture trigger would seat every human in every
 * conversation, which would make the participation gate untestable.
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

const NEEDLE = 'zqx-pair-needle';

function messageHits(results: SearchResultDto[]) {
  return results.filter(
    (r): r is Extract<SearchResultDto, { type: 'message' }> =>
      r.type === 'message',
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

  // A regular workspace where the viewer is BOTH a member and seated on a
  // channel — the v25 pair `userParticipates`'s workspace arm requires. Its
  // message is the CONTROL that must always be found.
  const eng = workspaces.insert({
    name: fixedWorkspaceName('eng'),
    description: null,
  });
  workspaces.addUserMember(eng.id, viewerUserId, 'owner');
  const general = conversations.insertChannel({
    workspaceId: eng.id,
    title: fixedConversationTitle('general'),
  });
  conversations.addUser(general.id, viewerUserId);
  const generalMsg = messages.insertForConversation({
    conversationId: general.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} said in a channel the viewer participates in`,
  });

  // A workspace-less human↔agent DirectPair the viewer is an endpoint of. Its
  // message is what #task:2053 makes searchable — no workspace, visible via the
  // `direct_pair` participation arm alone.
  const alpha = agents.create(
    { name: 'pair-alpha', runtime: 'claude' },
    localHostId,
    viewerUserId,
  );
  const pair = conversations.getOrCreateDirectPair(
    { kind: 'agent', id: alpha.id },
    { kind: 'human', id: viewerUserId },
    Date.now(),
  ).conversation;
  const pairMsg = messages.insertForConversation({
    conversationId: pair.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} said in the workspace-less DM`,
  });

  // NARROWING edge (A-a): a channel the viewer has a SEAT on but is NOT a
  // member of the owning workspace. Today's bare-seat EXISTS would surface it;
  // `userParticipates` (seat ∧ membership) must NOT.
  const outsiderWs = workspaces.insert({
    name: fixedWorkspaceName('outsider'),
    description: null,
  });
  const seatOnly = conversations.insertChannel({
    workspaceId: outsiderWs.id,
    title: fixedConversationTitle('seat-only'),
  });
  conversations.addUser(seatOnly.id, viewerUserId);
  const seatOnlyMsg = messages.insertForConversation({
    conversationId: seatOnly.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} in a channel the viewer holds a seat but no membership`,
  });

  // MUST-NOT-WIDEN edge (A-b): a channel in a workspace the viewer IS a member
  // of, but has NO seat on. Search is a content read face — membership alone
  // must never hand over the bodies of a channel the viewer never joined.
  const memberNoSeat = conversations.insertChannel({
    workspaceId: eng.id,
    title: fixedConversationTitle('not-joined'),
  });
  const memberNoSeatMsg = messages.insertForConversation({
    conversationId: memberNoSeat.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} in a same-workspace channel the viewer never joined`,
  });

  return {
    db,
    search,
    conversations,
    messages,
    viewerUserId,
    eng,
    general,
    generalMsg,
    alpha,
    pair,
    pairMsg,
    seatOnlyMsg,
    memberNoSeatMsg,
  };
}

describe('#task:2053 — DirectPair search + participation authority', () => {
  it('finds the DirectPair message, excludes seat-without-membership AND membership-without-seat', () => {
    const t = bootstrap();
    const found = t.search.search(
      SearchQueryInputSchema.parse({ q: NEEDLE, limit: 50 }),
      t.viewerUserId,
    );
    const ids = messageHits(found.results)
      .map(r => r.message.id)
      .sort();
    // Exactly the two the viewer PARTICIPATES in: the seated+member channel and
    // the DirectPair endpoint. The other two carry the identical needle, so
    // their absence isolates the participation gate:
    //   - seatOnlyMsg  → A-a: seat without workspace membership is narrowed out;
    //   - memberNoSeatMsg → A-b: membership without a seat is NOT widened in.
    expect(ids).toEqual([t.generalMsg.id, t.pairMsg.id].sort());
    expect(found.total).toBe(2);
  });

  it('carries the DirectPair hit on the placement-discriminated `direct_pair` arm (no workspace ref)', () => {
    const t = bootstrap();
    const found = t.search.search(
      SearchQueryInputSchema.parse({ q: NEEDLE, limit: 50 }),
      t.viewerUserId,
    );
    const hits = messageHits(found.results);

    const pairHit = hits.find(r => r.message.id === t.pairMsg.id);
    expect(pairHit).toBeDefined();
    expect(pairHit!.conversation.placement_kind).toBe('direct_pair');
    // The container discriminator is single-source: on the pair arm there is no
    // `workspace` field at all (#task:2053-C), and the DM coordinate is the
    // conversation id itself.
    expect('workspace' in pairHit!.conversation).toBe(false);
    expect(pairHit!.conversation.channel_id).toBe(t.pair.id);

    const wsHit = hits.find(r => r.message.id === t.generalMsg.id);
    expect(wsHit!.conversation.placement_kind).toBe('workspace');
    if (wsHit!.conversation.placement_kind === 'workspace') {
      expect(wsHit!.conversation.workspace.id).toBe(t.eng.id);
    }
  });

  it('keeps the DirectPair out of the surviving narrowing — a `workspace_id` coordinate filter', () => {
    const t = bootstrap();

    // Until #task:2075's stop-publish step this cell narrowed by CONTAINER KIND
    // (`scope=regular` / `scope=agent_space`), and its comment argued that the
    // pair was excluded by those filters' EXPLICIT `placement_kind='workspace'`
    // conjunct rather than by a NULL coincidence. Both filters died with the
    // published alphabet they read, so that argument now has no subject. The
    // FAMILY survives in one member — the coordinate filter — and its exclusion
    // rests on the opposite reasoning, which is why it is worth pinning here:
    // positive equality on a workspace id is SELF-excluding for a pair row
    // (`workspace_id IS NULL` can equal no id), so `search-repo.ts` deliberately
    // carries no `placement_kind` conjunct beside it (#task:2053-N1). If someone
    // ever "restores symmetry" by moving that conjunct back in, this cell keeps
    // passing — and it should: it pins the OUTCOME, and the comment at the query
    // is what pins the reason.
    const scoped = t.search.search(
      SearchQueryInputSchema.parse({
        q: NEEDLE,
        workspace_id: t.eng.id,
        limit: 50,
      }),
      t.viewerUserId,
    );
    const scopedIds = messageHits(scoped.results).map(r => r.message.id);
    // Differential: the workspace channel IS returned, so an absent pair is a
    // decision and not an empty result set.
    expect(scopedIds).toContain(t.generalMsg.id);
    expect(scopedIds).not.toContain(t.pairMsg.id);
  });

  it('counts DirectPair hits in `total`/`truncated` — the COUNT shares the row query`s LEFT-join FROM/WHERE', () => {
    const t = bootstrap();
    // Three more pair messages under a UNIQUE needle so `total` isolates the
    // pair count. If the COUNT kept an INNER `JOIN workspaces`, the pair rows
    // (null workspace_id) would be dropped from it and `total` would read 0.
    const only = 'zqx-count-only-pair';
    for (let i = 0; i < 3; i++) {
      t.messages.insertForConversation({
        conversationId: t.pair.id,
        fromKind: 'user',
        fromUserId: t.viewerUserId,
        content: `${only} ${i}`,
      });
    }
    const found = t.search.search(
      SearchQueryInputSchema.parse({ q: only, limit: 2 }),
      t.viewerUserId,
    );
    expect(found.total).toBe(3);
    expect(found.truncated).toBe(true);
    expect(messageHits(found.results)).toHaveLength(2);
    expect(
      messageHits(found.results).every(
        r => r.conversation.placement_kind === 'direct_pair',
      ),
    ).toBe(true);
  });
});
