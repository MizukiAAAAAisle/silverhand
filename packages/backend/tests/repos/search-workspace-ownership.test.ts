/**
 * #task:2075 — the search workspace ref carries the OWNERSHIP ARC, and since the
 * stop-publish step of the same ticket that arc is the ONLY container fact on it.
 *
 * `SearchWorkspaceRef.owner_agent_id` is what the renderer's real question needs
 * ("whose container is this", which splits the "Agent Spaces" group), and the
 * consumer cannot compute it in scope. A1 added it beside the published container
 * word; the word was the same bit spelled twice, so the stop-publish step deleted
 * it and these cells lost their second half.
 *
 * Each cell is a DIFFERENTIAL over both container arms in ONE result set: an
 * `agent_home` container (owner present) next to a `regular` one (owner null).
 * A producer that forgot the column, aliased it wrong, or dropped it on one arm
 * would show up as a null on the arm that must carry an id — which a
 * single-container fixture could not distinguish from "field absent everywhere".
 * The two arms are still named by their STORED words here because the fixtures
 * are built through `insertAgentHome` vs a plain insert: what retired is the
 * PUBLISHED alphabet, not the physical distinction the fixture constructs.
 *
 * The assertion was a PAIRING while the swap was in flight (the new field had to
 * carry precisely the bit the retiring one carried, or the renderer half would be
 * reading a different fact under the same intent). With the word gone only the
 * ownership half remains — one fact cannot drift from itself.
 *
 * `seedAllFixtureMemberships: false` is load-bearing: the fixture trigger would
 * seat the viewer everywhere and the arms would stop being distinguishable by
 * anything the search face itself decides.
 */
import { describe, expect, it } from 'vitest';
import {
  fixedConversationTitle,
  fixedWorkspaceName,
  SearchQueryInputSchema,
  type SearchResultDto,
  type SearchWorkspaceRef,
} from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SearchRepo } from '../../src/repos/search-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

const NEEDLE = 'zqx-owner-arc-needle';

function bootstrap() {
  const { db, localHostId, viewerUserId } = openTestDb({
    seedAllFixtureMemberships: false,
  });
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);
  const messages = new MessageRepo(db);
  const search = new SearchRepo(db);

  // Arm 1: a regular workspace — no home agent, so `owner_agent_id` must be null
  // on every face that carries this ref.
  const regular = workspaces.insert({
    name: fixedWorkspaceName(`${NEEDLE}-regular`),
    description: null,
  });
  workspaces.addUserMember(regular.id, viewerUserId, 'owner');
  const regularChannel = conversations.insertChannel({
    workspaceId: regular.id,
    title: fixedConversationTitle(`${NEEDLE}-regular-room`),
  });
  conversations.addUser(regularChannel.id, viewerUserId);
  const regularMsg = messages.insertForConversation({
    conversationId: regularChannel.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} in a regular workspace`,
  });

  // Arm 2: an agent's home container — `owner_agent_id` must be that agent.
  // The agent's own name is what the home workspace is named after, so the
  // needle has to live there for the DISCOVERY arm to see both containers.
  const alpha = agents.create(
    { name: `${NEEDLE}-alpha`, runtime: 'claude' },
    localHostId,
    viewerUserId,
  );
  const home = workspaces.insertAgentHome({ agent: alpha });
  workspaces.addUserMember(home.id, viewerUserId, 'owner');
  const homeChannel = conversations.insertChannel({
    workspaceId: home.id,
    title: fixedConversationTitle(`${NEEDLE}-home-room`),
  });
  conversations.addUser(homeChannel.id, viewerUserId);
  const homeMsg = messages.insertForConversation({
    conversationId: homeChannel.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} in an agent home`,
  });

  return {
    db,
    search,
    viewerUserId,
    alpha,
    regular,
    home,
    regularChannel,
    homeChannel,
    regularMsg,
    homeMsg,
  };
}

/** `expectedOwner` is the ticket-level truth about which container this is, so a
 *  producer that copied the wrong column fails here.
 *
 *  This helper carried two more cells while the ref ALSO published a container
 *  word: they cross-checked the arc against that word, since the two were the
 *  same bit spelled twice. #task:2075's stop-publish step deleted the word, and
 *  with it the only thing those cells could disagree with — one fact cannot drift
 *  from itself. What remains is the arc's VALUE, which is the half that was ever
 *  load-bearing. */
function expectOwnershipArc(
  ref: SearchWorkspaceRef,
  expectedOwner: string | null,
) {
  expect(ref.owner_agent_id).toBe(expectedOwner);
}

function run(t: ReturnType<typeof bootstrap>) {
  return t.search.search(
    SearchQueryInputSchema.parse({ q: NEEDLE, limit: 50 }),
    t.viewerUserId,
  ).results;
}

function workspaceHits(results: SearchResultDto[]) {
  return results.filter(
    (r): r is Extract<SearchResultDto, { type: 'workspace' }> =>
      r.type === 'workspace',
  );
}

function conversationHits(results: SearchResultDto[]) {
  return results.filter(
    (r): r is Extract<SearchResultDto, { type: 'conversation' }> =>
      r.type === 'conversation',
  );
}

function messageHits(results: SearchResultDto[]) {
  return results.filter(
    (r): r is Extract<SearchResultDto, { type: 'message' }> =>
      r.type === 'message',
  );
}

describe('#task:2075 A1 — search workspace ref carries the ownership arc', () => {
  it('workspace-DISCOVERY arm: both containers, owner id present exactly on the agent home', () => {
    const t = bootstrap();
    const byId = new Map(
      workspaceHits(run(t)).map(r => [r.workspace.id, r.workspace]),
    );

    const regular = byId.get(t.regular.id);
    const home = byId.get(t.home.id);
    expect(regular).toBeDefined();
    expect(home).toBeDefined();
    expectOwnershipArc(regular!, null);
    expectOwnershipArc(home!, t.alpha.id);
  });

  it('conversation-DISCOVERY arm: the workspace arm of the placement union carries it', () => {
    const t = bootstrap();
    const hits = conversationHits(run(t));
    const byConversation = new Map(hits.map(r => [r.conversation.id, r]));

    for (const [conversationId, expectedOwner] of [
      [t.regularChannel.id, null],
      [t.homeChannel.id, t.alpha.id],
    ] as const) {
      const hit = byConversation.get(conversationId);
      expect(hit).toBeDefined();
      expect(hit!.conversation.placement_kind).toBe('workspace');
      if (hit!.conversation.placement_kind === 'workspace') {
        expectOwnershipArc(hit!.conversation.workspace, expectedOwner);
      }
    }
  });

  it('MESSAGE arm: the same ref through the third producer', () => {
    const t = bootstrap();
    const byMessage = new Map(
      messageHits(run(t)).map(r => [r.message.id, r.conversation]),
    );

    for (const [messageId, expectedOwner] of [
      [t.regularMsg.id, null],
      [t.homeMsg.id, t.alpha.id],
    ] as const) {
      const conversation = byMessage.get(messageId);
      expect(conversation).toBeDefined();
      expect(conversation!.placement_kind).toBe('workspace');
      if (conversation!.placement_kind === 'workspace') {
        expectOwnershipArc(conversation!.workspace, expectedOwner);
      }
    }
  });
});
