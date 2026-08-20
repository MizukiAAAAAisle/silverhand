/**
 * `SavedMessageRepo` under the placement contract (#task:2050, M2 delta 2 of
 * #task:2045). Saved rows no longer carry their own `workspace_id` (v81 dropped
 * it); the read model derives placement from the canonical `conversations` row,
 * and visibility is re-derived from LIVE participation. Three properties that no
 * other test file pins:
 *
 *   1. a workspace-less `direct_pair` message CAN be saved and appears in the
 *      owner's list — the header behavior this delta exists for, and the exact
 *      case the previous hand-written `EXISTS(conversation_users)` gate silently
 *      dropped (a DM has no roster seat, so the row persisted but never listed);
 *   2. the workspace arm is STRICTER than a bare roster seat — it additionally
 *      requires live `workspace_users` membership (v25), so a stale seat without
 *      membership no longer lists the row (a disclosed behavior change);
 *   2b. the same arm is a CONJUNCTION the other way too — workspace MEMBERSHIP
 *      without a channel seat also hides the row (public discovery grants no
 *      read). This is the participation-only falsifier the `['saved']`
 *      workspace-name live-join depends on (F1 guardrail);
 *   3. an `agent_home` channel is projected by the SAME `workspace_channel` arm,
 *      with NO container word beside the coordinate. Until #task:2075's
 *      stop-publish step this cell asserted the opposite half — that a distinct
 *      CASE expression here relabelled `agent_home` as the published word
 *      `agent_space` — and the CASE was what made this a distinct SQL site.
 *      Nothing in this query branches on the container any more, so the cell is
 *      kept as an EXACT key-set equality: an extra key would be refused here,
 *      whereas the DTO's non-strict zod object would silently strip it.
 *
 * `seedAllFixtureMemberships: false` is load-bearing: the fixture trigger would
 * seat every human in every conversation, which would both mask the DM gap in
 * (1) and make the seat-without-membership state in (2) unconstructable.
 */
import { fixedConversationTitle, fixedWorkspaceName } from '@silverhand/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SavedMessageRepo } from '../../src/repos/saved-message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

describe('SavedMessageRepo — placement-derived read, live participation', () => {
  let db: Db;
  let localHostId: string;
  let viewer: string;
  let workspaces: WorkspaceRepo;
  let conversations: ConversationRepo;
  let agents: AgentRepo;
  let messages: MessageRepo;

  beforeEach(() => {
    const opened = openTestDb({ seedAllFixtureMemberships: false });
    db = opened.db;
    localHostId = opened.localHostId;
    viewer = opened.viewerUserId;
    workspaces = new WorkspaceRepo(db);
    conversations = new ConversationRepo(db);
    agents = new AgentRepo(db);
    messages = new MessageRepo(db);
  });

  it('persists and lists a direct_pair message save (the DM gap the seat gate dropped)', () => {
    const alpha = agents.create(
      { name: 'dm-alpha', runtime: 'claude' },
      localHostId,
      viewer,
    );
    // Workspace-LESS direct_pair: `conversations.workspace_id IS NULL`, no roster.
    const { conversation: pair } = conversations.getOrCreateDirectPair(
      { kind: 'human', id: viewer },
      { kind: 'agent', id: alpha.id },
      Date.now(),
    );
    const msg = messages.insertForConversation({
      conversationId: pair.id,
      fromKind: 'user',
      fromUserId: viewer,
      content: 'save me in a DM',
    });

    const saved = new SavedMessageRepo(db);
    const echo = saved.save(msg.id, viewer);
    expect(echo).not.toBeNull();
    // The pair arm of the union — no workspace presentation, just the coordinate.
    expect(echo!.place).toEqual({ kind: 'direct_pair', conversation_id: pair.id });

    // The header assertion: it is in the owner's LIST, not merely readable by id.
    // A `direct_pair` has no `conversation_users` seat, so an EXISTS-on-seat gate
    // returned false here and dropped the row; `userParticipates` reads the human
    // ENDPOINT instead.
    const listed = saved.listForUser(viewer);
    expect(listed.map(s => s.message.id)).toContain(msg.id);
    expect(listed.find(s => s.message.id === msg.id)!.place).toEqual({
      kind: 'direct_pair',
      conversation_id: pair.id,
    });
  });

  it('lists a workspace save only with live workspace membership, not a bare seat', () => {
    const ws = workspaces.insert({
      name: fixedWorkspaceName('eng'),
      description: null,
    });
    const channel = conversations.insertChannel({
      workspaceId: ws.id,
      title: fixedConversationTitle('general'),
    });
    // A roster SEAT without workspace membership — the stale-seat state a user
    // removed from the workspace would hold. `addUser` seats them in the
    // conversation; we deliberately do NOT `addUserMember` the workspace.
    conversations.addUser(channel.id, viewer);
    const msg = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: viewer,
      content: 'saved from a channel',
    });

    const saved = new SavedMessageRepo(db);
    // `save()` gates on PLACEMENT, not participation, so the row persists and is
    // readable by id — proving the list exclusion below is the participation
    // gate, not a failed write.
    expect(saved.save(msg.id, viewer)).not.toBeNull();
    expect(saved.getByMessageIdForUser(msg.id, viewer)).not.toBeNull();

    // Stricter workspace arm (v25): seat ∧ workspace_users. Seat alone → dropped.
    expect(saved.listForUser(viewer).map(s => s.message.id)).not.toContain(msg.id);

    // Grant the membership the arm requires → the row lists. This isolates the
    // exclusion to the membership conjunct rather than any other filter.
    workspaces.addUserMember(ws.id, viewer, 'member');
    const listed = saved.listForUser(viewer);
    expect(listed.map(s => s.message.id)).toContain(msg.id);
    // Exact shape (F1): the workspace NAME is deliberately absent — joined live
    // from `['workspaces']`, mirroring the shipped `TaskPlace`. A full `toEqual`
    // (not `toMatchObject`) makes re-adding `workspace_name` redden this — and,
    // since #task:2075's stop-publish step, a re-added container word too.
    expect(listed.find(s => s.message.id === msg.id)!.place).toEqual({
      kind: 'workspace_channel',
      conversation_id: channel.id,
      workspace_id: ws.id,
      channel_name: fixedConversationTitle('general').title,
    });
  });

  it('hides a channel the workspace-member viewer never joined (public discovery grants no read)', () => {
    // The FALSIFIER for the name-join model (contract §4-B guardrail): Saved's
    // visibility is participation-only. `userParticipates`'s workspace arm is a
    // CONJUNCTION — a conversation seat AND live workspace membership. The
    // sibling test above pins the membership conjunct (seat without membership →
    // hidden); this pins the SEAT conjunct (membership without seat → hidden), so
    // a public channel the viewer can discover but never joined never surfaces.
    // If this reddens or is deleted, that is the moment `['saved']`'s live
    // workspace-name join would begin leaking names for channels the viewer never
    // joined — i.e. visibility silently widened to "workspace member may read"
    // (`task-repo.ts:100` "public discovery grants no task read"; the task board
    // mirrors this axis in #task:2045's board-population test).
    const ws = workspaces.insert({
      name: fixedWorkspaceName('eng'),
      description: null,
    });
    const channel = conversations.insertChannel({
      workspaceId: ws.id,
      title: fixedConversationTitle('general'),
    });
    // Viewer is a workspace MEMBER but never joined the channel (no seat).
    workspaces.addUserMember(ws.id, viewer, 'member');
    const author = agents.create(
      { name: 'eng-bot', runtime: 'claude' },
      localHostId,
      viewer,
    );
    const msg = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: author.id,
      content: 'posted in a channel the viewer never joined',
    });

    const saved = new SavedMessageRepo(db);
    // `save()` gates on PLACEMENT, not participation, so the row persists and is
    // readable by id — isolating the list exclusion below as the seat gate.
    expect(saved.save(msg.id, viewer)).not.toBeNull();
    expect(saved.getByMessageIdForUser(msg.id, viewer)).not.toBeNull();
    expect(saved.listForUser(viewer).map(s => s.message.id)).not.toContain(msg.id);

    // Grant the seat → the row lists. Isolates the exclusion to the seat conjunct
    // rather than any other filter.
    conversations.addUser(channel.id, viewer);
    expect(saved.listForUser(viewer).map(s => s.message.id)).toContain(msg.id);
  });

  it('projects an agent_home channel through the plain workspace arm, with no container word', () => {
    const alpha = agents.create(
      { name: 'home-alpha', runtime: 'claude' },
      localHostId,
      viewer,
    );
    const home = workspaces.insertAgentHome({ agent: alpha });
    const dm = conversations.insertDmChannel({
      workspaceId: home.id,
      title: fixedConversationTitle('Onboarding'),
      agentId: alpha.id,
    });
    const msg = messages.insertForConversation({
      conversationId: dm.id,
      fromKind: 'agent',
      fromAgentId: alpha.id,
      content: 'saved from an agent_space channel',
    });

    const saved = new SavedMessageRepo(db);
    // Read by id (no participation gate) isolates the projection itself. The
    // assertion is `toEqual`, not `toMatchObject`: the property under test is
    // that this arm carries the coordinate pair and the one live name and
    // NOTHING else — an ownership-derived container word re-appearing here
    // would fail, which `toMatchObject` could not see. `agent_home` is a
    // deliberate input: it is the container that used to take the special
    // branch, so it is the state where a re-introduced word would surface first.
    expect(saved.save(msg.id, viewer)).not.toBeNull();
    const echo = saved.getByMessageIdForUser(msg.id, viewer);
    expect(echo!.place).toEqual({
      kind: 'workspace_channel',
      conversation_id: dm.id,
      workspace_id: home.id,
      channel_name: dm.title,
    });
  });
});
