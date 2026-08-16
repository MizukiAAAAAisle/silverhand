/**
 * #task:2035 (@Cindy B5) — the BEHAVIORAL falsifiers for Activity's placement
 * domain: the two `${WORKSPACE_PLACED}` conjuncts in `read-model/activity.ts`.
 *
 * WHY THIS FILE EXISTS. Both Activity sources were changed to state their domain
 * as the shared placement discriminator, and every existing Activity test stayed
 * green with EITHER conjunct deleted (@Cindy's mutation). Correct text with no
 * counterexample behind it is not a defense: the failure it is supposed to stop —
 * an `ActivityItemDto.workspace_id` that is typed `string` and is actually NULL,
 * i.e. a row the client navigates nowhere with — is silent, so nothing else in the
 * suite would notice its return.
 *
 * ONE TEST PER CONJUNCT, and each is a PAIR of assertions: zero items for the
 * workspace-less placement, and the workspace positive control still entering
 * through the very same source. Without the control, deleting the conjunct is not
 * the only way to redden the test (breaking the source outright would too), and
 * "this conjunct is load-bearing" would not be what passing means.
 *
 * The two tests are deliberately INDEPENDENT: the directed one gives its pair no
 * roster seat, the positional one triggers no notification, so deleting one
 * conjunct reddens exactly one of them.
 *
 * WHY BOTH FIXTURES OPT OUT OF `seedAllFixtureMemberships`. The default fixture
 * installs a trigger that seats EVERY fixture user into EVERY conversation on
 * insert, so the canonical `direct_pair` — which production mints with its two
 * endpoint columns and no `conversation_users` row at all — silently arrives with
 * a roster seat. That single fixture fact broke both halves of the requirement:
 * the positional test's "stray seat" was already there before `addUser` (so the
 * premise under test was fictional), and the directed test's pair entered the
 * POSITIONAL source too, which made deleting the positional conjunct redden BOTH
 * tests. With the trigger off, each pair has exactly the participation production
 * gives it, and the one explicit `addUser` below is the whole counterexample.
 * Nothing else in these tests needs the trigger: `direct_pair` participation is
 * an endpoint arc (`resolveParticipation`), and the two workspace-placed controls
 * are seated by the production doors that create them.
 *
 * db-boundary (Gate 4): NO ledger entry is needed and none was added. Both
 * falsifiers reach their state through production doors and repository faces —
 * the resolver's allocating arm (`dm:@handle`), the human send route, the real
 * wake-failure notifier, `ConversationRepo.addUser` — and read it back through
 * `NotificationRepo` and `GET /api/activity`. There is no native statement call
 * in this file, which is also what makes the states it builds evidence of
 * something: a hand-written INSERT would prove the query filters rows I wrote,
 * not rows the product produces.
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
  // roster, which is exactly the positive control the positional conjunct must
  // not disturb (that source's DM arm keys on `roster_policy`, not on placement).
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

/** The stranger's DM, through the real addressing path: `dm:@handle` on a
 *  main-line write is the resolver's one allocating arm, so THIS is what opens the
 *  workspace-less pair — no fixture stands in for the placement under test. */
async function dmTheViewer(
  t: TestApp,
  agentId: string,
  content: string,
): Promise<string> {
  const r = await http(t, agentSlotAuth(t, agentId)).post(
    internalPaths.agentSendConversationMessage(agentId),
    { content, target: `dm:@${VIEWER_HANDLE}` },
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as any).conversation_id as string;
}

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

describe('Activity is workspace-placed only (#task:2035 B5 falsifiers)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('directed: a wake failure on a workspace-less DirectPair yields no item, while the same failure in a channel does', async () => {
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
    // The state under test is real and is what the read model would have to
    // reject: an unread directed notification whose workspace coordinate is NULL.
    expect(failures().find(n => n.conversation_id === pairId)).toMatchObject({
      workspace_id: null,
      read_at: null,
    });

    const items = await getActivity(t);
    // The falsifier: with `AND ${WORKSPACE_PLACED}` deleted from the directed
    // source, this item is emitted as `kind: 'agent_failed'` with a NULL
    // workspace_id in a field the DTO types `string`, and an empty title.
    expect(items.filter(i => i.conversation_id === pairId)).toEqual([]);
    // The control: the same source, the same kind, one placement over.
    expect(
      items.filter(i => i.kind === 'agent_failed' && i.conversation_id === channelId),
    ).toHaveLength(1);
  });

  it('positional: a stray roster seat on a DirectPair yields no item, while a workspace fixed-roster DM still enters', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId: parent, homeChannelId } = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const pairId = await dmTheViewer(t, stranger, 'first contact');

    // THE STRAY SEAT — the reachable shape of this conjunct's counterexample. A
    // canonical `direct_pair` has no `conversation_users` row at all (the mint
    // writes the endpoint columns and nothing else), so this source could not see
    // one today. What makes the state reachable is that the seat is one ordinary
    // repository call away: a member door that stops failing closed on non-workspace
    // placements, a backfill that seats "the humans of every conversation", or a
    // future placement that legitimately has both endpoints AND a roster. The
    // conjunct is what makes that a no-op for Activity instead of a NULL
    // workspace_id in a field typed `string`.
    new ConversationRepo(t.ctx.db).addUser(pairId, t.viewerUserId);
    // Unread on the DM main line, from the counterpart (the viewer's own sends are
    // never unread), so the source's `roster_policy = 'fixed'` arm would admit it.
    await dmTheViewer(t, stranger, 'still here');

    // The workspace positive control, entering through the SAME arm: an
    // `agent_home` DM channel is workspace-placed with a fixed roster.
    await sendAsAgent(t, homeChannelId, parent, 'your agent reporting in');

    const items = await getActivity(t);
    // The falsifier: with `AND ${WORKSPACE_PLACED}` deleted from
    // `POSITIONAL_STREAMS_SQL`, this row enters as a directed-salience `unread`
    // item whose `workspace_id` is NULL.
    expect(items.filter(i => i.conversation_id === pairId)).toEqual([]);
    // The control: same source, same arm, workspace-placed.
    expect(
      items.filter(i => i.kind === 'unread' && i.conversation_id === homeChannelId),
    ).toMatchObject([{ salience: 'directed', unread_count: 1 }]);
  });
});
