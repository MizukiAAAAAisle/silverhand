/**
 * Saved list — sender narrowing (#task:2059).
 *
 * The one judgement this file pins: the filter key is the STABLE send-time
 * snapshot `(m.from_kind, m.author_id)`, NOT the live FK
 * (`from_agent_id`/`from_user_id`). For an actor that still exists the two are
 * row-equivalent (v63 backfilled `author_id = from_*_id` for every FK-resolved
 * row, and `insertMessage` has written the same id into both ever since), so the
 * choice is free on active senders and only differs where it matters: a
 * hard-deleted sender's FK is nulled by ON DELETE SET NULL while the snapshot
 * survives, so an FK predicate would silently drop every saved message from a
 * since-deleted actor. Cell 2 is the falsifier — swapping the predicate back to
 * `m.from_agent_id` reddens it and nothing else.
 *
 * The remaining cells pin the properties that make this a FILTER and not a
 * lookup: `from_kind` is a real conjunct (the two id namespaces never
 * cross-match), it runs in the WHERE before `ORDER BY saved_at DESC LIMIT`
 * (#task:1258 — a filter narrows the whole saved history, not the capped
 * window), and an unknown id yields nothing rather than erroring, so the
 * parameter is not an existence oracle for user/agent ids.
 *
 * The third author state — `unresolved`, a pre-v63 row with neither FK nor
 * snapshot — needs no cell here: `m.author_id = ?` with a non-null parameter
 * cannot match NULL, so such a row is matched by no sender by construction. The
 * place that state was actively MIS-attributed (search's `includeNullAuthor`,
 * which counted it as the viewer's own) was fixed in #task:2061, and its
 * assertion lives in that ticket's `search-sender-filter.test.ts`.
 *
 * `seedAllFixtureMemberships: false` is load-bearing: the fixture trigger would
 * seat every human in every conversation, masking the participation conjunction
 * the sibling `saved-message-repo.test.ts` pins.
 */
import { fixedConversationTitle, fixedWorkspaceName } from '@silverhand/shared';
import { SavedMessagesQueryInputSchema } from '@silverhand/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SavedMessageRepo } from '../../src/repos/saved-message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

const BASE_MS = 1_700_000_000_000;

describe('SavedMessageRepo — sender narrowing on the snapshot key (#task:2059)', () => {
  let viewer: string;
  let agents: AgentRepo;
  let messages: MessageRepo;
  let saved: SavedMessageRepo;
  let channelId: string;
  let alphaId: string;
  let betaId: string;
  /** Drives `saved_at`: `save()` stamps `Date.now()`, and several saves in one
   *  millisecond would leave `ORDER BY saved_at DESC` to break ties arbitrarily.
   *  Pinning the clock keeps the window in the cells below deterministic without
   *  reaching past the repository to UPDATE the column. */
  let now = BASE_MS;

  beforeEach(() => {
    now = BASE_MS;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const opened = openTestDb({ seedAllFixtureMemberships: false });
    viewer = opened.viewerUserId;
    const workspaces = new WorkspaceRepo(opened.db);
    const conversations = new ConversationRepo(opened.db);
    agents = new AgentRepo(opened.db);
    messages = new MessageRepo(opened.db);
    saved = new SavedMessageRepo(opened.db);

    const ws = workspaces.insert({
      name: fixedWorkspaceName('sender-filter-ws'),
      description: null,
    });
    const channel = conversations.insertChannel({
      workspaceId: ws.id,
      title: fixedConversationTitle('general'),
    });
    channelId = channel.id;
    const alpha = agents.create(
      { name: 'alpha-bot', runtime: 'claude' },
      opened.localHostId,
      viewer,
    );
    const beta = agents.create(
      { name: 'beta-bot', runtime: 'claude' },
      opened.localHostId,
      viewer,
    );
    alphaId = alpha.id;
    betaId = beta.id;
    workspaces.insertMembership(ws.id, alpha.id);
    workspaces.insertMembership(ws.id, beta.id);
    conversations.addAgent(channel.id, alpha.id);
    conversations.addAgent(channel.id, beta.id);
    // The viewer needs BOTH the channel seat and live workspace membership — the
    // conjunction `userParticipates` requires before the list returns anything.
    workspaces.addUserMember(ws.id, viewer, 'member');
    conversations.addUser(channel.id, viewer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function postByAgent(agentId: string, content: string) {
    return messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content,
    });
  }

  function postByViewer(content: string) {
    return messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: viewer,
      content,
    });
  }

  /** Save at a chosen instant so `saved_at DESC` order is a fact of the fixture. */
  function saveAt(messageId: string, offsetMs: number): void {
    now = BASE_MS + offsetMs;
    expect(saved.save(messageId, viewer)).not.toBeNull();
  }

  it('partitions the list by sender, with from_kind as a real conjunct', () => {
    const byAlpha = postByAgent(alphaId, 'from alpha');
    const byBeta = postByAgent(betaId, 'from beta');
    const byViewer = postByViewer('from the human');
    saveAt(byAlpha.id, 3000);
    saveAt(byBeta.id, 2000);
    saveAt(byViewer.id, 1000);

    expect(saved.listForUser(viewer).map(s => s.message.id)).toEqual([
      byAlpha.id,
      byBeta.id,
      byViewer.id,
    ]);
    expect(
      saved.listForUser(viewer, { sender: { kind: 'agent', id: alphaId } }).map(s => s.message.id),
    ).toEqual([byAlpha.id]);
    expect(
      saved.listForUser(viewer, { sender: { kind: 'user', id: viewer } }).map(s => s.message.id),
    ).toEqual([byViewer.id]);
    // `from_kind` is part of the key, not decoration: an agent id asked for under
    // the `user` arm matches nothing, so the two id namespaces never cross-match.
    expect(saved.listForUser(viewer, { sender: { kind: 'user', id: alphaId } })).toEqual([]);
  });

  it('still finds a hard-deleted sender (the FK-predicate falsifier)', () => {
    const byBeta = postByAgent(betaId, 'from beta, who is about to be deleted');
    saveAt(byBeta.id, 1000);
    // The delete authority's post-commit state: the `agents` row is gone, so
    // `messages.from_agent_id` is nulled by ON DELETE SET NULL while the
    // send-time `author_*` snapshot survives (#task:1791).
    agents.delete(betaId);

    const listed = saved.listForUser(viewer, { sender: { kind: 'agent', id: betaId } });
    expect(listed.map(s => s.message.id)).toEqual([byBeta.id]);
    // The DTO proves the FK really is gone (`deleted`, not `active`) AND that the
    // id the row renders is the id that filtered it — the same value in both
    // states, which is what keeps a picker selection a valid filter across a
    // delete.
    expect(listed[0]!.message.author).toMatchObject({ status: 'deleted', id: betaId });
  });

  it('narrows the whole saved history, not the capped window (#task:1258)', () => {
    const newest = postByAgent(alphaId, 'newest');
    const middle = postByAgent(alphaId, 'middle');
    const oldest = postByAgent(betaId, 'oldest');
    saveAt(newest.id, 3000);
    saveAt(middle.id, 2000);
    saveAt(oldest.id, 1000);

    // With `limit: 2` the unfiltered window is alpha's two rows only. Beta's row
    // is OUTSIDE that window, so a filter applied to the window (client-side, or
    // any SQL shape that filters after `LIMIT`) returns nothing here.
    expect(saved.listForUser(viewer, { limit: 2 }).map(s => s.message.id)).toEqual([
      newest.id,
      middle.id,
    ]);
    expect(
      saved
        .listForUser(viewer, { limit: 2, sender: { kind: 'agent', id: betaId } })
        .map(s => s.message.id),
    ).toEqual([oldest.id]);
  });

  it('returns nothing for an unknown sender id instead of erroring (not an existence oracle)', () => {
    saveAt(postByAgent(alphaId, 'from alpha').id, 1000);
    expect(saved.listForUser(viewer, { sender: { kind: 'agent', id: 'no-such-agent' } })).toEqual([]);
    expect(saved.listForUser(viewer, { sender: { kind: 'user', id: 'no-such-user' } })).toEqual([]);
  });

  it('keeps "no filter" structurally distinct and the two arms mutually exclusive', () => {
    // Absent and empty-string both mean NO filter — the absence is structural,
    // never a `sender=''` sentinel the repo would have to interpret.
    const absent = SavedMessagesQueryInputSchema.parse({});
    expect(absent.user_id).toBeUndefined();
    expect(absent.agent_id).toBeUndefined();
    const blank = SavedMessagesQueryInputSchema.parse({ user_id: '', agent_id: '' });
    expect(blank.user_id).toBeUndefined();
    expect(blank.agent_id).toBeUndefined();
    const picked = SavedMessagesQueryInputSchema.parse({ agent_id: 'a1' });
    expect(picked.agent_id).toBe('a1');
    expect(picked.user_id).toBeUndefined();
    // Single-select (@shiki, 2026-08-18): one sender at a time, so naming both is
    // a client bug, not a union to silently pick from.
    expect(
      SavedMessagesQueryInputSchema.safeParse({ user_id: 'u1', agent_id: 'a1' }).success,
    ).toBe(false);
  });
});
