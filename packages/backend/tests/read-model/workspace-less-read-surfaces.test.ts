/**
 * The WORKSPACE-LESS placement against the read faces that join `workspaces`
 * (agent-scoped-session-v1 §4.1/§4.2/§6) — one describe per QUESTION, because
 * the same row must answer differently depending on who is asking.
 *
 * Since #task:2072 retired `agent_inbox` that placement is `direct_pair`, and it
 * is the LAST one: `conversations.workspace_id` is nullable for it alone. The
 * gate this file inherits from the retired suite (@Cindy, 2026-08-14) is
 * unchanged, and it is about the shape of the assertion, not about which
 * placement is workspace-less: a row must never be missing from a read face
 * *incidentally*, because `JOIN workspaces` dropped it. Absence has to be a
 * DOMAIN decision, and a test that only asserted "the pair is not in this list"
 * cannot tell those two apart — an empty result is the same either way. So every
 * exclusion below is a DIFFERENTIAL:
 *
 *   1. a CONTROL row that is workspace-placed and otherwise identical in every
 *      filter the query applies (`roster_policy='fixed'` where the query wants
 *      DMs) IS returned — so the query is demonstrably not just returning
 *      nothing;
 *   2. the pair is set up so EVERY OTHER predicate of the query passes;
 *   3. the pair is proven to EXIST and be READABLE through the face that owns
 *      it — its endpoints (§4.2). A row visible to its participants and absent
 *      from a workspace list is scoped; a row absent from both may simply have
 *      vanished.
 *
 * What is NOT here, deliberately: the exclusions that were true of an inbox and
 * are FALSE of a pair. A `direct_pair` IS searchable (#task:2053-B② admits it by
 * name), IS saveable, and DOES derive a task board (`pair:<key>`) — asserting the
 * old answers with the new subject would pin fiction.
 *
 * `seedAllFixtureMemberships: false` is load-bearing: the fixture trigger would
 * put every fixture human into `conversation_users` of EVERY conversation, which
 * both contradicts §4.2 and would let a human-visibility EXISTS become the reason
 * a face excluded the pair.
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import type { ConversationDto } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { buildAgentSearchMessagesDto } from '../../src/read-model/agent-read.js';
import { openTestDb } from '../utils/db.js';

const NEEDLE = 'zqx-needle';
const NOW = 1_700_000_000_000;

function bootstrap() {
  const { db, localHostId, viewerUserId } = openTestDb({
    seedAllFixtureMemberships: false,
  });
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);
  const messages = new MessageRepo(db);

  const eng = workspaces.insert({ name: fixedWorkspaceName('eng'), description: null });
  workspaces.addUserMember(eng.id, viewerUserId, 'owner');

  const general = conversations.insertChannel({
    workspaceId: eng.id,
    title: fixedConversationTitle('general'),
  });
  // The CONTROL for every DM-shaped face: workspace-placed and `roster_policy`
  // fixed, so it reports `kind='dm_channel'` exactly like a pair does.
  const dm = conversations.insertDmChannel({
    workspaceId: eng.id,
    title: fixedConversationTitle('dm-control'),
  });
  conversations.addUser(general.id, viewerUserId);
  conversations.addUser(dm.id, viewerUserId);

  const alpha = agents.create({ name: 'pair-alpha', runtime: 'claude' }, localHostId, viewerUserId);
  workspaces.insertMembership(eng.id, alpha.id);
  conversations.addAgent(general.id, alpha.id);
  conversations.addAgent(dm.id, alpha.id);

  // Through the production constructor: the pair is not a hand-written row.
  const { conversation: pair } = conversations.getOrCreateDirectPair(
    { kind: 'human', id: viewerUserId },
    { kind: 'agent', id: alpha.id },
    NOW,
  );
  const channelMessage = messages.insertForConversation({
    conversationId: general.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} said in the channel`,
  });
  const dmMessage = messages.insertForConversation({
    conversationId: dm.id,
    fromKind: 'user',
    fromUserId: viewerUserId,
    content: `${NEEDLE} said in the control DM`,
  });

  return {
    db,
    workspaces,
    conversations,
    agents,
    messages,
    viewerUserId,
    eng,
    general,
    dm,
    alpha,
    pair,
    channelMessage,
    dmMessage,
    /** The pair as a full DTO — the shape the read faces are handed. */
    pairConversation(): ConversationDto {
      return conversations.get(pair.id)!;
    },
  };
}

describe('direct_pair — workspace-scoped read faces exclude it by decision', () => {
  it('does not leak into the workspace fixed-roster list', () => {
    const t = bootstrap();
    // The one face where a new placement leaks IN rather than dropping out:
    // `kind` is GENERATED from `roster_policy`, and a pair is necessarily
    // fixed-roster, just like the workspace control — so placement is the
    // load-bearing exclusion.
    expect(t.conversations.get(t.pair.id)!.roster_policy).toBe('fixed');
    expect(t.conversations.listDmChannels().map(c => c.id)).toEqual([t.dm.id]);
  });

  it('belongs to no workspace, so no workspace DM list can contain it', () => {
    const t = bootstrap();
    expect(
      t.conversations.listAllDmChannelsForWorkspace(t.eng.id).map(c => c.id),
    ).toEqual([t.dm.id]);
    expect(t.conversations.listDmChannelForWorkspace(t.eng.id)?.id).toBe(t.dm.id);
    expect(
      t.conversations
        .listActiveDmChannelsForViewer(t.eng.id, t.viewerUserId)
        .map(c => c.id),
    ).toEqual([t.dm.id]);
  });

  it('is readable by its endpoints, so the exclusions above are scoping', () => {
    const t = bootstrap();
    expect(t.conversations.isAgentParticipant(t.pair.id, t.alpha.id)).toBe(true);
    expect(t.conversations.isUserParticipant(t.pair.id, t.viewerUserId)).toBe(true);
    // And with no roster row on either side (§4.2).
    expect(t.conversations.listAgents(t.pair.id)).toEqual([]);
    expect(t.conversations.listUsers(t.pair.id)).toEqual([]);
  });
});

describe('direct_pair — faces with no workspace answer refuse instead of guessing', () => {
  it('refuses `current_workspace` search with `workspace_scope_required`', () => {
    const t = bootstrap();
    const result = buildAgentSearchMessagesDto(
      t.db,
      t.conversations,
      t.pairConversation(),
      t.alpha.id,
      { q: NEEDLE, current_workspace: true, include_system: true, limit: 20 },
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: 'workspace_scope_required',
    });
    // Naming a workspace the agent belongs to works — the refusal is about the
    // absent coordinate, not about the agent's access.
    const named = buildAgentSearchMessagesDto(
      t.db,
      t.conversations,
      t.pairConversation(),
      t.alpha.id,
      { q: NEEDLE, workspace_id: t.eng.id, include_system: true, limit: 20 },
    );
    expect(named.ok).toBe(true);
    if (named.ok) {
      expect(named.dto.hits.map(h => h.message_ref.id).sort()).toEqual(
        [t.channelMessage.id, t.dmMessage.id].sort(),
      );
    }
  });
});
