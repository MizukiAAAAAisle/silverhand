/**
 * The agent inbox against every read face that joins `workspaces`
 * (agent-scoped-session-v1 §4.1/§4.2/§6, #task:2014) — one describe per
 * QUESTION the faces are being asked, because the same row must answer
 * differently depending on who is asking.
 *
 * The gate this file exists for (@Cindy, 2026-08-14): a row must never be
 * missing from a read face *incidentally*, because `JOIN workspaces` dropped it
 * when `conversations.workspace_id` went nullable. Absence has to be a DOMAIN
 * decision. A test that only asserted "the inbox is not in this list" cannot
 * tell those two apart — an empty result is the same either way — so every
 * exclusion below is asserted as a DIFFERENTIAL with three parts:
 *
 *   1. a CONTROL row that is workspace-placed and otherwise identical in every
 *      filter the query applies (archived when the query wants archived,
 *      `dm_channel` when the query wants DMs, starred when the query wants
 *      stars, containing the same needle when the query is a search) IS
 *      returned — so the query is demonstrably not just returning nothing;
 *   2. the inbox is set up so EVERY OTHER predicate of the query passes, which
 *      is why the inbox is archived / starred / carries the same needle below.
 *      Otherwise the exclusion could be attributed to any of those instead;
 *   3. the inbox is proven to EXIST and be READABLE through the face that owns
 *      it — its one participant (§4.2). A row that is visible to its owner and
 *      absent from a workspace list is scoped; a row absent from both may simply
 *      have vanished.
 *
 * `seedAllFixtureMemberships: false` is load-bearing for all of it: the fixture
 * trigger would put every fixture human into `conversation_users` of EVERY
 * conversation including the inbox, which both contradicts §4.2 and would let a
 * human-visibility EXISTS become the reason a face excluded the inbox.
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle, SearchQueryInputSchema } from '@silverhand/shared';
import type { ConversationDto } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SavedMessageRepo } from '../../src/repos/saved-message-repo.js';
import { SearchRepo } from '../../src/repos/search-repo.js';
import { SortRepo } from '../../src/repos/sort-repo.js';
import { SqliteTaskRepo } from '../../src/repos/task-repo.js';
import { taskConversationAccessPort } from '../../src/repos/task-persistence.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { listFavorites } from '../../src/read-model/favorites.js';
import { buildAgentSearchMessagesDto } from '../../src/read-model/agent-read.js';
import { openTestDb } from '../utils/db.js';

const NEEDLE = 'zqx-needle';

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
  // The CONTROL for every DM-shaped face: workspace-placed, `roster_policy`
  // fixed, so it reports `kind='dm_channel'` exactly like an inbox does.
  const dm = conversations.insertDmChannel({
    workspaceId: eng.id,
    title: fixedConversationTitle('dm-control'),
  });
  conversations.addUser(general.id, viewerUserId);
  conversations.addUser(dm.id, viewerUserId);

  const alpha = agents.create({ name: 'inbox-alpha', runtime: 'claude' }, localHostId, viewerUserId);
  const beta = agents.create({ name: 'inbox-beta', runtime: 'claude' }, localHostId, viewerUserId);
  workspaces.insertMembership(eng.id, alpha.id);
  conversations.addAgent(general.id, alpha.id);
  conversations.addAgent(dm.id, alpha.id);

  const inbox = conversations.insertAgentInbox(alpha.id, alpha.created_at);
  // The same needle in both places, so a search's exclusion of the inbox cannot
  // be blamed on the LIKE predicate.
  const inboxMessage = messages.insertForConversation({
    conversationId: inbox.id,
    fromKind: 'system',
    content: `${NEEDLE} copied into the inbox`,
  });
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
    beta,
    inbox,
    inboxMessage,
    channelMessage,
    dmMessage,
    /** The inbox as a full DTO — the shape the read faces are handed. */
    inboxConversation(): ConversationDto {
      return conversations.get(inbox.id)!;
    },
  };
}

describe('agent inbox — workspace-scoped read faces exclude it by decision', () => {
  it('is absent from the archived aggregate while an equally-archived workspace DM is present', () => {
    const t = bootstrap();
    // Archive BOTH. Without this the inbox would be filtered by
    // `archived_at IS NOT NULL` and the placement predicate would never be
    // exercised at all.
    t.conversations.setArchived(t.inbox.id, true);
    t.conversations.setArchived(t.dm.id, true);

    const rows = new ConversationRepo(t.db).listArchivedChannelsAggregate();
    expect(rows.map(r => r.channel.id)).toEqual([t.dm.id]);
    // …and the workspace ref every row carries is exactly why: the aggregate
    // REPORTS an owning workspace, which the inbox has none of.
    expect(rows[0]!.workspace).toMatchObject({ id: t.eng.id, name: 'eng' });
  });

  it('does not leak into the workspace fixed-roster list', () => {
    const t = bootstrap();
    // The one face where a new placement leaks in rather than dropping out:
    // An inbox is necessarily fixed-roster, just like the workspace control;
    // placement is therefore the load-bearing exclusion.
    expect(t.conversations.get(t.inbox.id)!.roster_policy).toBe('fixed');
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

  it('stays out of Favorites even with a star row written for it', () => {
    const t = bootstrap();
    const sort = new SortRepo(t.db);
    // A star is a HOME-LIST fact, and the inbox has no home list to be starred
    // in — so this writes the star under the only list a human could plausibly
    // have been looking at. The face must still refuse it: `list_key` is derived
    // from the joined row, not from where the star was recorded.
    sort.setStarred(t.viewerUserId, `channels:${t.eng.id}`, t.inbox.id, true);
    sort.setStarred(t.viewerUserId, `channels:${t.eng.id}`, t.dm.id, true);

    const favorites = listFavorites(t.db, { viewerUserId: t.viewerUserId });
    expect(favorites.items.map(i => i.entity_id)).toEqual([t.dm.id]);
  });

  it('is unsearchable as a workspace-scoped result while the same needle in a channel is found', () => {
    const t = bootstrap();
    const found = new SearchRepo(t.db).search(
      SearchQueryInputSchema.parse({ q: NEEDLE, limit: 50 }),
      { visibleUserId: t.viewerUserId },
    );
    const messageIds = found.results
      .filter(r => r.type === 'message')
      .map(r => (r.type === 'message' ? r.message.id : ''));
    expect(messageIds.sort()).toEqual([t.channelMessage.id, t.dmMessage.id].sort());
    expect(messageIds).not.toContain(t.inboxMessage.id);
    // `total` is computed by a second statement over the same WHERE, so it has
    // to agree — a placement filter applied to the page but not the count would
    // show a phantom match the list cannot display.
    expect(found.total).toBe(2);
  });

  it('is not a roster seat, so the roster face has nothing to project for it', () => {
    const t = bootstrap();
    // The differential's third part: the row the roster face omits is
    // nonetheless the agent's own, which is why omitting it is scoping and not a
    // lost row. What it does NOT mean is that the inbox has no runtime seat —
    // that is the block below, and the two must not be conflated.
    expect(t.conversations.isAgentParticipant(t.inbox.id, t.alpha.id)).toBe(true);
    expect(t.conversations.getAgent(t.inbox.id, t.alpha.id)).toBeNull();
  });
});

/**
 * The counterweight to the block above: not every face that could omit the inbox
 * SHOULD. The runtime faces are keyed by AGENT, not by workspace, and v75 made a
 * seat follow PARTICIPATION rather than the roster — so the inbox belongs in
 * them. A session can run there (#task:2019), and a running session no control
 * plane can see is the defect the placement/seat split exists to prevent.
 */
describe('agent inbox — the runtime faces DO carry it (a seat is not a roster row)', () => {
  it('has a seat with no roster row, and shows up in the runtime conversation list', () => {
    const t = bootstrap();
    const seats = new AgentRepo(t.db).listRuntimeParticipations(t.alpha.id);
    expect(seats.map(s => s.conversation_id).sort()).toEqual(
      [t.general.id, t.dm.id, t.inbox.id].sort(),
    );
    // The two units side by side on the same row: a SEAT exists for the inbox,
    // while MEMBERSHIP does not. Deriving either from the other is what made a
    // DM session unstoppable before v75.
    expect(
      new RuntimeSlotRepo(t.db).get({
        kind: 'conversation',
        conversationId: t.inbox.id,
        agentId: t.alpha.id,
      }),
    ).toMatchObject({ observed_status: 'idle', generation: 0 });
    expect(t.conversations.getAgent(t.inbox.id, t.alpha.id)).toBeNull();
    // The control: the workspace channel has both, so the inbox's missing roster
    // row is a property of its placement and not of this fixture.
    expect(t.conversations.getAgent(t.general.id, t.alpha.id)).not.toBeNull();
  });
});

describe('agent inbox — its one participant CAN read it', () => {
  it('counts the owner as a participant with no roster row, and nobody else', () => {
    const t = bootstrap();
    expect(t.conversations.isAgentParticipant(t.inbox.id, t.alpha.id)).toBe(true);
    expect(t.conversations.isAgentParticipant(t.inbox.id, t.beta.id)).toBe(false);
    // The roster arm is untouched by the union: a workspace channel still
    // answers from `conversation_agents`.
    expect(t.conversations.isAgentParticipant(t.general.id, t.alpha.id)).toBe(true);
    expect(t.conversations.isAgentParticipant(t.general.id, t.beta.id)).toBe(false);
    // And MEMBERSHIP is still a different question from participation: the roster
    // face has no inbox row to project at all. Its runtime seat is a third unit
    // again, asserted in the runtime block above.
    expect(t.conversations.getAgent(t.general.id, t.alpha.id)).not.toBeNull();
    expect(t.conversations.getAgent(t.inbox.id, t.alpha.id)).toBeNull();
  });

  // The read-history ADDRESS arm used to be asserted here, against
  // `resolveAgentReadHistoryTarget` — the read door's own target taxonomy, which
  // #task:2021 P4-4 deleted in favour of the one resolver. Its successor
  // assertions live where that resolver's do: `an inbox is a read face, not a
  // write destination` in `tests/delivery-target-resolution.test.ts` proves the
  // owner resolves `#conv:<inbox>` at `intent: 'read'` and that anyone else is
  // refused as `target_unresolved`. What stays this file's own business is the
  // participation face those assertions consult, above.

  it('is searchable by its owner in conversation scope, and by nobody else', () => {
    const t = bootstrap();
    const search = (agentId: string) =>
      buildAgentSearchMessagesDto(
        t.db,
        t.conversations,
        t.inboxConversation(),
        agentId,
        { q: NEEDLE, conversation_id: t.inbox.id, include_system: true, limit: 20 },
      );
    const own = search(t.alpha.id);
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.dto.hits.map(h => h.message_ref.id)).toEqual([t.inboxMessage.id]);
      // The ref reports NO workspace rather than borrowing the reading
      // session's (§4.1) — otherwise a CC copy would look like it lived on
      // someone's board.
      expect(own.dto.hits[0]!.message_ref.workspace_id).toBeNull();
    }
    expect(search(t.beta.id)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('agent inbox — faces with no workspace answer refuse instead of guessing', () => {
  it('has no default task board: the ambient derivation yields none and the repo refuses unresolved reads', () => {
    const t = bootstrap();
    // The production composition, so the board read sees the same narrow
    // conversation port the service does.
    const tasks = new SqliteTaskRepo({
      db: t.db,
      conversations: taskConversationAccessPort(t.db),
    });
    // P0-f moved the ambient-board question OUT of the repo: the service
    // derives the board-key set (placement-aware — a DM frame gets its pair
    // board) and the ROUTE keeps the inbox's typed refusal. What the repo
    // still owes: (a) the inbox derives NO board — "no board" and "an empty
    // board" stay different answers…
    expect(tasks.boardOfConversation(t.inbox.id)).toBeNull();
    // …(b) an agent-arm read whose board set was never resolved is a harness
    // bug and throws rather than guessing an ambient…
    expect(() =>
      tasks.list({ actor: { kind: 'agent', runtimeScope: 'conversation', agentId: t.alpha.id, conversationId: t.inbox.id } }),
    ).toThrow(/boardKeys/);
    // …and (c) a workspace-placed conversation's derived board answers
    // normally (empty board = empty list).
    const board = tasks.boardOfConversation(t.general.id);
    expect(board?.boardKey).toMatch(/^ws:/);
    expect(
      tasks.list({
        actor: { kind: 'agent', runtimeScope: 'conversation', agentId: t.alpha.id, conversationId: t.general.id },
        boardKeys: [board!.boardKey],
      }),
    ).toEqual([]);
  });

  it('refuses `current_workspace` search with `workspace_scope_required`', () => {
    const t = bootstrap();
    const result = buildAgentSearchMessagesDto(
      t.db,
      t.conversations,
      t.inboxConversation(),
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
      t.inboxConversation(),
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

  it('cannot have a message saved: the write refuses the non-participatory placement', () => {
    const t = bootstrap();
    const saved = new SavedMessageRepo(t.db);
    // Loud, not silent — and specifically the DOMAIN's refusal, no longer a
    // storage constraint. `saved_messages.workspace_id` was dropped (v81), so a
    // NULL-workspace placement is now perfectly INSERTable; the fail-closed gate
    // is `save()` asserting the placement is one a human can participate in. The
    // refusal is the three-arm `SavedPlacementError` — narrowed on
    // `placement_kind`, NOT the removed "not workspace-placed" wording, because
    // `direct_pair` IS now saveable and the objection is specifically "a human is
    // never a participant of an agent_inbox".
    expect(() => saved.save(t.inboxMessage.id, t.viewerUserId)).toThrow(
      /placement_kind=agent_inbox.*not a saveable placement/is,
    );

    // The counterpart: a DM-SHAPED (dm_channel) message the viewer participates
    // in round-trips through save → listForUser, so the inbox's absence above is
    // a decision about the inbox, not saved being unable to hold a DM.
    expect(saved.save(t.dmMessage.id, t.viewerUserId)).not.toBeNull();
    const listed = saved.listForUser(t.viewerUserId).map(s => s.message.id);
    expect(listed).toContain(t.dmMessage.id);

    expect(saved.save(t.channelMessage.id, t.viewerUserId)).not.toBeNull();
  });
});
