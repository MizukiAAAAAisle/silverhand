/**
 * Activity's PLACEMENT DOMAIN, behaviourally (#task:2035 @Cindy B5, inverted by
 * #task:2115).
 *
 * WHAT CHANGED, AND WHY THE FILE SURVIVES THE INVERSION. This file used to pin
 * "Activity is workspace-placed only", one test per `${WORKSPACE_PLACED}` conjunct.
 * That domain was a defect, not a scope: a DM's unread is directed-grade by
 * definition (§5.1), so the one item class the human is MOST obliged to answer was
 * the one class the global rail could not show, and
 * `docs/activity-lifecycle-v1.md` said the opposite of the code. What the conjuncts
 * were actually defending was the #2035 symptom — an UNOPENABLE item, a
 * `workspace_id` typed `string` that was NULL with an empty title — and that is now
 * unrepresentable in the DTO instead: `location` is a discriminated union, so a
 * `direct_pair` item HAS no workspace coordinate to be missing.
 *
 * So the tests invert but their SHAPE does not, and neither does the reason it is
 * that shape: each is a DIFFERENTIAL over one source — the workspace-less pair AND
 * a workspace-placed control entering through the very same source — because
 * "these items exist" and "this source works at all" are different claims, and a
 * one-sided assertion cannot tell them apart.
 *
 * THE ONE CONJUNCT THAT REMAINS, and its falsifier. Merging participation did not
 * widen either gate: the workspace arm still reads the roster seat under
 * `placement_kind = 'workspace'`, and the DM arm reads ENDPOINTS only. The third
 * test is the counterexample that makes that load-bearing — a stray
 * `conversation_users` seat on a pair the viewer is NOT an endpoint of. Deleting
 * the roster arm's placement conjunct does not merely leak an item there: the DM
 * arm's counterpart resolution FAILS CLOSED (it cannot name "the other endpoint"
 * for a non-endpoint viewer), so the whole rail 500s. That is the intended
 * direction — a stranger's DM must never be drawn — and it is why the assertion is
 * "the request succeeds AND the pair is absent" rather than only the absence.
 *
 * WHY THE FIXTURES OPT OUT OF `seedAllFixtureMemberships`. The default fixture
 * installs a trigger that seats EVERY fixture user into EVERY conversation on
 * insert, so the canonical `direct_pair` — which production mints with its two
 * endpoint columns and no `conversation_users` row at all — would silently arrive
 * with a roster seat, and the stray-seat test's premise would be fictional (the
 * seat would predate the `addUser` that is supposed to be the whole
 * counterexample). With the trigger off, each pair has exactly the participation
 * production gives it.
 *
 * db-boundary (Gate 4): NO ledger entry is needed and none was added. Every state
 * is reached through production doors and repository faces — the resolver's
 * allocating arm (`dm:@handle`), the human send route, the real wake-failure
 * notifier, `ConversationRepo.addUser` — and read back through `NotificationRepo`
 * and `GET /api/activity`. There is no native statement call in this file, which is
 * also what makes the states it builds evidence of something: a hand-written
 * INSERT would prove the query filters rows I wrote, not rows the product produces.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, internalPaths, type ActivityItemDto } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { stream } from '../utils/destination.js';
import { agentSlotAuth, insertAgentScopedAgent } from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';

/** The viewer handle the fixture registers for `viewerUserId` (`tests/utils/db.ts`). */
const VIEWER_HANDLE = 'local-test';

async function makeAgent(
  t: TestApp,
  name: string,
): Promise<{ agentId: string; homeChannelId: string }> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = (await r.json()) as any;
  // The agent's own `agent_home` DM channel: WORKSPACE-placed with a FIXED
  // roster — the control that keeps "fixed roster" and "no workspace" separate
  // claims. It enters through the positional source's roster_policy arm, exactly
  // as the pair does, and it must keep its `workspace_channel` location.
  expect(typeof body.dm_channel_id).toBe('string');
  return { agentId: body.agent.id as string, homeChannelId: body.dm_channel_id as string };
}

async function createWorkspaceChannel(
  t: TestApp,
  memberAgentId: string,
): Promise<string> {
  const r = await http(t).post('/api/workspaces', {
    name: 'ws-activity-placement',
    member_agent_ids: [memberAgentId],
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).onboarding_channel_id as string;
}

/** A DM through the real addressing path: `dm:@handle` on a main-line write is the
 *  resolver's one allocating arm, so THIS is what opens a workspace-less pair — no
 *  fixture stands in for the placement under test. */
async function dmByHandle(
  t: TestApp,
  agentId: string,
  handle: string,
  content: string,
): Promise<string> {
  const r = await http(t, agentSlotAuth(t, agentId)).post(
    internalPaths.agentSendConversationMessage(agentId),
    { content, target: `dm:@${handle}` },
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as any).conversation_id as string;
}

const dmTheViewer = (t: TestApp, agentId: string, content: string): Promise<string> =>
  dmByHandle(t, agentId, VIEWER_HANDLE, content);

/** The human door, which admits a `direct_pair` today (`getChannelLike` +
 *  `canPostToConversation`) — the send whose failed fan-out produces the wake
 *  notification below. */
async function humanSend(t: TestApp, conversationId: string, content: string): Promise<void> {
  const r = await http(t).post(apiPaths.channelMessages(conversationId), { content });
  expect(r.status).toBe(201);
}

async function sendAsAgent(
  t: TestApp,
  conversationId: string,
  agentId: string,
  content: string,
): Promise<void> {
  await t.ctx.conversationMessageService.sendMessage({
    conversationId,
    actor: { kind: 'agent', agentId, conversationId },
    destination: stream(conversationId),
    content,
  });
}

async function getActivity(t: TestApp): Promise<ActivityItemDto[]> {
  const res = await http(t).get(apiPaths.activity);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).items as ActivityItemDto[];
}

/** Runtime fan-out is post-commit and fire-and-forget, so the notification it
 *  writes lands after the HTTP response the test already awaited. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('Activity spans both conversation placements (#task:2115)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('directed: a wake failure on a workspace-less DirectPair yields an item located AT THE PAIR, alongside the channel case', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId: parent } = await makeAgent(t, 'parent');
    const channelId = await createWorkspaceChannel(t, parent);
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const pairId = await dmTheViewer(t, stranger, 'first contact');

    // THE PRODUCTION PATH, not a legacy fixture: a human message whose recipient's
    // runtime cannot be reached makes `notifyAgentStartFailureBestEffort` insert an
    // `agent_start_failed` for the SENDER, carrying `conversation.workspace_id` —
    // NULL for a `direct_pair`. Nothing exempts a workspace-less placement from
    // that path, and nothing should: the person still needs to hear that their DM
    // did not wake anyone (#task:2019 made the spawn itself workspace-free).
    t.fake.deliverError = new Error(
      'runtime_start: binary "claude" for runtime "claude" not found on PATH',
    );
    await humanSend(t, pairId, 'are you there?');
    await humanSend(t, channelId, 'anyone home?');

    const notifications = new NotificationRepo(t.ctx.db);
    const failures = () =>
      notifications.list({ userId: t!.viewerUserId }).filter(n => n.kind === 'agent_start_failed');
    await waitFor(() => failures().length === 2);
    // The row whose workspace coordinate is NULL — the state the old domain
    // rejected and this one describes.
    expect(failures().find(n => n.conversation_id === pairId)).toMatchObject({
      workspace_id: null,
      read_at: null,
    });

    const items = await getActivity(t);
    const pairItems = items.filter(i => i.conversation_id === pairId);
    // TWO items, from BOTH sources: the wake failure (directed) and the stranger's
    // own unread message (positional). Asserting both here is not scope creep — it
    // is the claim that the two sources answer WHERE through the same seam, which a
    // single-source assertion cannot make.
    expect(pairItems.map(i => i.kind).sort()).toEqual(['agent_failed', 'unread']);
    // The whole point of the union: a workspace-less item is not a workspace item
    // with holes in it. It answers WHERE with the pair's own coordinate — the
    // counterpart — and carries no workspace field to be NULL.
    for (const item of pairItems) {
      expect(item).toMatchObject({
        location: {
          kind: 'direct_pair',
          counterpart: { status: 'active', kind: 'agent', id: stranger, runtime: 'claude' },
        },
      });
      expect(item.location).not.toHaveProperty('workspace_id');
      expect(item.location).not.toHaveProperty('title');
    }
    // The control: the same source, the same kind, one placement over — and it
    // still answers with a workspace coordinate.
    const channelItems = items.filter(
      i => i.kind === 'agent_failed' && i.conversation_id === channelId,
    );
    expect(channelItems).toHaveLength(1);
    expect(channelItems[0]!.location).toMatchObject({ kind: 'workspace_channel' });
    expect(channelItems[0]!.location).not.toHaveProperty('counterpart');
  });

  it('positional: DM unread on a workspace-less DirectPair enters directed-grade, alongside a workspace fixed-roster DM', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId: parent, homeChannelId } = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const pairId = await dmTheViewer(t, stranger, 'first contact');
    // Unread on the DM main line, from the counterpart (the viewer's own sends are
    // never unread). The pair carries NO `conversation_users` row, which is why the
    // roster arm alone could not see it and why global Activity showed no DM unread
    // before this ticket — the regression this test is the falsifier for.
    await dmTheViewer(t, stranger, 'still here');

    // The workspace positive control, entering through the SAME arm: an
    // `agent_home` DM channel is workspace-placed with a fixed roster.
    await sendAsAgent(t, homeChannelId, parent, 'your agent reporting in');

    const items = await getActivity(t);
    const pairItems = items.filter(i => i.conversation_id === pairId);
    // Directed SALIENCE with a positional MECHANISM: a fixed-roster stream's
    // unread is directed-grade (§5.1), and the grade is decided server-side off
    // `roster_policy` — the placement decides IDENTITY, never loudness.
    expect(pairItems).toMatchObject([
      {
        kind: 'unread',
        salience: 'directed',
        unread_count: 2,
        location: {
          kind: 'direct_pair',
          counterpart: { status: 'active', kind: 'agent', id: stranger },
        },
      },
    ]);
    // The control: same source, same arm, workspace-placed — and it stays a
    // channel, because a fixed roster inside an agent home is still a channel
    // (#task:2076).
    expect(
      items.filter(i => i.kind === 'unread' && i.conversation_id === homeChannelId),
    ).toMatchObject([
      { salience: 'directed', unread_count: 1, location: { kind: 'workspace_channel' } },
    ]);
  });

  it("a stray roster seat on someone else's DirectPair stays inert", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId: parent, homeChannelId } = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    // A pair between TWO AGENTS, opened through the same allocating arm: the viewer
    // is not an endpoint of it, and no addressing path would ever hand it to them.
    const foreignPairId = await dmByHandle(t, stranger, 'parent', 'agent to agent');
    await dmByHandle(t, stranger, 'parent', 'and again');

    // THE STRAY SEAT — the reachable shape of the counterexample. A canonical
    // `direct_pair` has no `conversation_users` row at all (the mint writes the
    // endpoint columns and nothing else), so no source could see one today. What
    // makes the state reachable is that the seat is one ordinary repository call
    // away: a member door that stops failing closed on non-workspace placements, a
    // backfill that seats "the humans of every conversation", or a future placement
    // that legitimately has both endpoints AND a roster. The roster arm's
    // `placement_kind = 'workspace'` conjunct is what makes that a no-op.
    new ConversationRepo(t.ctx.db).addUser(foreignPairId, t.viewerUserId);

    // A real item the viewer IS entitled to, so the assertion below cannot pass by
    // the rail being empty or erroring.
    await sendAsAgent(t, homeChannelId, parent, 'your agent reporting in');

    const items = await getActivity(t);
    // Absence AND liveness: with the conjunct deleted, the seat admits the pair to
    // the positional source, `resolveCounterpart` throws (the viewer is neither
    // endpoint) and this request 500s — `getActivity` asserts the 200 first.
    expect(items.filter(i => i.conversation_id === foreignPairId)).toEqual([]);
    expect(items.filter(i => i.conversation_id === homeChannelId)).toHaveLength(1);
  });
});
