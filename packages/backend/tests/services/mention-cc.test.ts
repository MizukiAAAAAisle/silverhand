/**
 * Mention CC (#task:2014 / agent-scoped-session-v1 §4.2 + §5, destination
 * replaced by #task:2072).
 *
 * Every case below exists because a DIFFERENT way of getting it wrong would go
 * unnoticed:
 *
 *  1. The destination is the AUTHOR'S DIRECT LINE with the mentioned agent — the
 *     `direct_pair` the two of them share, minted on demand. Two retired models
 *     precede it, and this suite is the memory of both: #task:1989 copied into a
 *     `Mentions` DM under the AGENT's home workspace and admitted the human author
 *     to it (`conversation_users` + `workspace_users`); v71 replaced that with the
 *     agent's INBOX, whose only participant is the agent — no human anywhere, so
 *     the wrap had to tell the agent there was nothing to answer. A wake into a
 *     stream nobody can be answered in is the defect #task:2072 removes. So the
 *     destination is asserted structurally, not just by id: the pair has the author
 *     as its human endpoint, and it still grants the agent NO roster row and NO
 *     workspace membership.
 *  2. WHO may have that line is not this rule's decision. The verdict comes from
 *     `canInitiateDirectMessageToAgent` at the send boundary, and a mention the
 *     gate refuses is a `no_direct_line` SKIP: the CC copies nothing, the send
 *     stands, and the author's own reference report says the mention reached
 *     nobody. Today's refused population is every conversation-scoped agent (its
 *     human entry is its workspace, not a DM), which is why the fixture below
 *     carries one.
 *  3. The copy is written INSIDE THE SEND'S TRANSACTION — and since #task:2072 so
 *     is the MINT of its destination, so a pair can never outlive a rolled-back
 *     copy. It used to be a post-commit best-effort call, where a crash in the gap
 *     committed the human's message and lost the copy silently. Both directions are
 *     gated: a failure anywhere in the CC rolls the human's send back, and there is
 *     no path that commits one without the other.
 *  4. The announcement of a pair the CC created cannot go out in the same breath as
 *     the mint (it would announce a row a rollback removes), so it is carried out
 *     as DATA and published after commit — and the post-commit half PROVES it
 *     covered every id rather than trusting whoever wrote it (#task:2035's
 *     obligation, satisfied the transaction-aware way).
 *
 * Driven through `ConversationMessageService.sendMessage` wherever the claim is
 * about the send's transaction, because "same transaction" is not a property of
 * `writeMentionCcCopies` in isolation — it is a property of who calls it and
 * where. The write half is called directly only for the two states a user send
 * cannot produce (a legacy authorless row, a workspace-less source).
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { fixedConversationTitle } from '@silverhand/shared';
import { describe, expect, it, vi } from 'vitest';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import type { ConversationDto, MessageDto, Reference } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteConversationPersistence } from '../../src/repos/conversation-persistence.js';
import { createSqliteAgentProvisioningPersistence } from '../../src/repos/agent-provisioning-persistence.js';
import { createUnreadPublishAdapter } from '../../src/adapters/unread-publish.js';
import { ConversationMessageService } from '../../src/services/conversation-message-service.js';
import {
  dispatchMentionCcEffects,
  writeMentionCcCopies,
} from '../../src/application/mention-cc.js';
import type { MentionCcReport } from '../../src/application/mention-cc.js';
import type { MessageTxScope } from '../../src/services/conversation-message/ports.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import { stream } from '../utils/destination.js';
import { overrideScope, uowWithScopeWrap } from '../utils/tx-fault.js';

/**
 * A runtime host that records what it was asked to do and refuses nothing.
 *
 * Refusing nothing is the only shape it may have: production wakes an agent in a
 * workspace-less conversation exactly like any other — `buildRuntimeStartOptions`
 * emits `workspace: null` with an agent-scoped `runtime_scope` (#task:2019) — so a
 * fake that rejected such a placement would not assert today's end state but
 * manufacture a defect, and every deferral the integration cases below observe
 * would be its own.
 */
class FakeRuntimeHost {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    this.delivered.push({ conversationId, agentId, messageId });
  }

  async deliverPending(): Promise<boolean> {
    return true;
  }
  resolveRun(): void {}
  resolveConversationRuns(): void {}
  getAgentRunStates(): never[] {
    return [];
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
  reconcileOnBoot(): void {}
  isRunning(): boolean {
    return false;
  }
  closeActivityLog(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `seedAllFixtureMemberships: false` is load-bearing, not hygiene: the fixture
 * trigger snapshots every fixture user into `conversation_users` on EVERY
 * conversation insert — including the `direct_pair`s this suite's sends mint.
 * With it on, "the destination line has exactly its two principals" would be
 * untestable, and worse, the retired #1989 admission writes would be
 * indistinguishable from the seed.
 */
function bootstrap() {
  const { db, localHostId } = openTestDb({ seedAllFixtureMemberships: false });
  const tmp = makeTempSilverhandDir();
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const inboxes = new ConversationInboxRepo(db);
  const messages = new MessageRepo(db);
  const notifications = new NotificationRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeRuntimeHost();
  const logger: BackendLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const workspace = workspaces.insert({ name: fixedWorkspaceName('eng'), description: null });
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('general'),
  });
  // The author's own participation, written the way production writes it (a route
  // / ChannelService insert) rather than by the dropped seed trigger. BOTH facts,
  // because human channel participation is the v25 PAIR — the `conversation_users`
  // seat AND `workspace_users` membership — and since #task:2021 P4-4 the send's
  // write gate asks for it INSIDE the transaction. With the seat alone this
  // fixture's author was less privileged than any real one, and every send here
  // would be refused.
  workspaces.addUserMember(workspace.id, 'local');
  conversations.addUser(channel.id, 'local');

  // `insider` receives the original message; `outsider` is the mention target and
  // is deliberately not even a member of the source WORKSPACE — the CC has no
  // membership precondition, and pretending it does would hide that.
  //
  // `session_scope: 'agent'` on the target is load-bearing, not decoration: the
  // destination is a human-initiated direct line, and `canInitiateDirectMessageToAgent`
  // grants one only for an agent-scoped agent. A fixture that left the default here
  // would be asserting the CC's happy path through a state production refuses.
  const insider = agents.create({ name: 'cc-insider', runtime: 'claude' }, localHostId, 'local');
  const outsider = agents.create(
    { name: 'cc-outsider', runtime: 'claude', session_scope: 'agent' },
    localHostId,
    'local',
  );
  // The other side of that same gate, as a REAL product state rather than a stubbed
  // boolean: a conversation-scoped agent, whose human entry is its own workspace, so
  // no human may open a direct line to it and a mention of it cannot be copied.
  const convScoped = agents.create(
    { name: 'cc-conv-scoped', runtime: 'claude' },
    localHostId,
    'local',
  );
  workspaces.insertMembership(workspace.id, insider.id);
  conversations.addAgent(channel.id, insider.id);

  const persistence = createSqliteConversationPersistence(db);
  const txWrap: { current: ((tx: MessageTxScope) => MessageTxScope) | null } = { current: null };
  const service = new ConversationMessageService({
    uow: uowWithScopeWrap(persistence.message.uow, () => txWrap.current),
    threadFollow: persistence.threadFollow,
    delivery: persistence.delivery,
    unreadPublish: createUnreadPublishAdapter({ db, events }),
    runtimeHost: fake as unknown as AgentRuntimeHost,
    events,
    logger,
    // The boundary's verdict (#task:2072), reduced to the half a fixture with no
    // `BackendContext` can compute HONESTLY: the agent exists and is agent-scoped.
    // That is the clause of `canInitiateDirectMessageToAgent` this suite has cases
    // for — the refused population is conversation-scoped agents. Its ACL half
    // (`canViewAgent`) is not stubbed true here and then asserted: the real gate is
    // wired in `tests/utils/app.ts`, so the route-level suites carry the production
    // verdict, and `tests/routes/direct-pairs.test.ts` owns the gate itself.
    directLineTargetFor: (_userId, agentHandle) => {
      const target = agents.getByName(agentHandle);
      if (!target || target.session_scope !== 'agent') return null;
      return target.id;
    },
  });

  return {
    db,
    localHostId,
    agents,
    workspaces,
    conversations,
    inboxes,
    messages,
    notifications,
    events,
    fake,
    logger,
    persistence,
    txWrap,
    service,
    workspace,
    channel,
    insider,
    outsider,
    convScoped,
    cleanup: tmp.cleanup,
  };
}

type Fixture = ReturnType<typeof bootstrap>;

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** The post-commit half is `void`-ed by the send, so its observable effects are
 *  awaited on the log line that closes each copy's dispatch. */
const logCalls = (spy: BackendLogger['info'] | BackendLogger['warn']): Array<Record<string, unknown>> =>
  vi.mocked(spy).mock.calls.map(call => call[0] as Record<string, unknown>);

const logEvents = (spy: BackendLogger['info'] | BackendLogger['warn']): string[] =>
  logCalls(spy).map(fields => String(fields.event));

const send = (t: Fixture, content: string) =>
  t.service.sendMessage({
    conversationId: t.channel.id,
    actor: { kind: 'user', userId: 'local' },
    destination: { kind: 'own_main_line' },
    content,
  });

/** `cc_source_message_id` is a persistence-level idempotency key, not a DTO
 *  field: read it from the row. */
const ccSourceOf = (t: Fixture, messageId: string): string | null =>
  t.db
    .prepare<[string], { cc_source_message_id: string | null }>(
      `SELECT cc_source_message_id FROM messages WHERE id = ?`,
    )
    .get(messageId)?.cc_source_message_id ?? null;

const humanMemberIdsOf = (t: Fixture, conversationId: string): string[] =>
  t.db
    .prepare<[string], { user_id: string }>(
      `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
    )
    .all(conversationId)
    .map(row => row.user_id);

const workspaceMemberAgentIdsOf = (t: Fixture, workspaceId: string): string[] =>
  t.db
    .prepare<[string], { agent_id: string }>(
      `SELECT agent_id FROM workspace_members WHERE workspace_id = ?`,
    )
    .all(workspaceId)
    .map(row => row.agent_id);

const canonical = (handle: string): string => `<silverhand://agent/${handle}>`;

/**
 * The CC's destination, LOOKED UP rather than precomputed (#task:2072).
 *
 * The line does not exist until a CC (or a human pressing "Message") opens it, so a
 * fixture that handed one out would be testing a different world — and every "the CC
 * wrote nothing" case below is `null` here, which is a stronger statement than an
 * empty message list in a pre-made conversation.
 */
const pairOf = (t: Fixture, agentId: string): string | null =>
  t.conversations.findDirectPair(
    { kind: 'human', id: 'local' },
    { kind: 'agent', id: agentId },
  )?.id ?? null;

/** Messages in the author's line with this agent, `[]` when the line was never
 *  opened — so a caller does not have to branch on existence to say "no copy". */
const copiesTo = (t: Fixture, agentId: string): MessageDto[] => {
  const pair = pairOf(t, agentId);
  return pair === null ? [] : t.messages.listForConversation(pair);
};

describe('mention CC — the copy, in the send transaction', () => {
  it('lands in the author’s direct line with the agent, with source provenance, a delivery row, and the author notification', async () => {
    const t = bootstrap();
    try {
      const viewerFrames: Array<{ kind: string; payload: unknown }> = [];
      const workspaceFrames: Array<{ kind: string; payload: unknown }> = [];
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerFrames.push({ kind: e.kind, payload: e.payload });
      });
      const unsubWorkspace = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        workspaceFrames.push({ kind: e.kind, payload: e.payload });
      });

      const result = await send(t, `${canonical('cc-outsider')} can you look at the parser?`);
      // The destination is minted BY this send, so it can only be subscribed to
      // after the fact; the conversation-scoped frame is asserted from the message
      // repo and from the second case below, which drives the dispatcher directly.
      await waitFor(() => pairOf(t, t.outsider.id) !== null);
      const pair = pairOf(t, t.outsider.id)!;
      // The wake HAPPENS (see `FakeRuntimeHost`): wait for the copy's own live
      // dispatch into the line, which is the last post-commit effect.
      await waitFor(() => t.fake.delivered.some(d => d.conversationId === pair));
      unsubViewer();
      unsubWorkspace();

      // ── the destination ─────────────────────────────────────────────────
      // A `direct_pair` between the AUTHOR and the agent: the copy lands somewhere
      // the recipient can answer, which is the whole of #task:2072.
      const destination = t.conversations.get(pair)!;
      expect(destination.placement_kind).toBe('direct_pair');
      expect(destination.workspace_id).toBeNull();

      // ── the copy ────────────────────────────────────────────────────────
      const copies = t.messages.listForConversation(pair);
      expect(copies).toHaveLength(1);
      const copy = copies[0]!;
      expect(copy.from_kind).toBe('system');
      expect(copy.metadata).toMatchObject({
        subtype: 'mention_cc',
        source_workspace_id: t.workspace.id,
        source_workspace_name: 'eng',
        source_conversation_id: t.channel.id,
        source_conversation_title: 'general',
        source_message_id: result.committed.message.id,
        source_from_kind: 'user',
        source_from_user_id: 'local',
        source_message_content: result.committed.message.content,
      });
      // The idempotency key, which is what makes a second copy a constraint
      // failure instead of a second notification.
      expect(ccSourceOf(t, copy.id)).toBe(result.committed.message.id);

      // ── the durable half of the delivery ────────────────────────────────
      // `conversation_inboxes` is the per-(conversation, agent) DELIVERY QUEUE, not
      // the retired `agent_inbox` placement: the queue row moved with the copy.
      const pending = t.inboxes.listPending(pair, t.outsider.id);
      expect(pending.map(item => item.message.id)).toEqual([copy.id]);

      // ── the author's notification (option A: SOURCE coordinates) ────────
      const notifications = t.notifications.list({ userId: 'local' });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        kind: 'mention_external',
        user_id: 'local',
        agent_id: t.outsider.id,
        conversation_id: t.channel.id,
        message_id: result.committed.message.id,
        source_conversation_id: t.channel.id,
        source_message_id: result.committed.message.id,
      });
      expect(notifications[0]!.payload).toMatchObject({
        source_workspace_name: 'eng',
        source_conversation_title: 'general',
        mention_excerpt: `${canonical('cc-outsider')} can you look at the parser?`,
      });
      // SOURCE coordinates even though the author CAN now read the destination: the
      // notification answers "where were you mentioned", and that is the channel.
      expect(notifications[0]!.conversation_id).not.toBe(pair);
      expect(notifications[0]!.message_id).not.toBe(copy.id);

      // ── the frames ──────────────────────────────────────────────────────
      // The destination is new, so the author's DM LIST is stale until it is told —
      // #task:2035's obligation, discharged after commit because the mint ran inside
      // the transaction.
      expect(
        viewerFrames.filter(f => f.kind === 'direct_pairs_changed').map(f => f.payload),
      ).toEqual([{ conversation_id: pair }]);
      expect(
        viewerFrames.filter(f => f.kind === 'notification').map(f => f.payload),
      ).toEqual([
        {
          kind: 'mention_external',
          conversation_id: t.channel.id,
          message_id: result.committed.message.id,
        },
      ]);
      // No channel-list fan-out for a placement that is in no workspace.
      expect(workspaceFrames.map(f => f.kind)).not.toContain('workspace_channels_changed');
      // And NO unread frame FOR THE DESTINATION, even though it now has a human
      // participant — `UNREAD_GUARDS` excludes `from_kind = 'system'`, so the wrap is
      // not an unanswered message the author owes anyone a read of. This is the fact
      // that keeps "the copy landed in a stream you can see" from turning every
      // mention into a badge on the author's own sidebar.
      //
      // Filtered by conversation, not by frame kind: the author's OWN send into the
      // channel legitimately moves their channel unread, and asserting the absence of
      // the kind outright would pass for that reason instead of this one.
      expect(
        viewerFrames
          .filter(f => f.kind === 'unread_updated')
          .map(f => (f.payload as { conversation_id: string }).conversation_id),
      ).not.toContain(pair);
    } finally {
      t.cleanup();
    }
  });

  it('grants no membership anywhere: the line’s participation is its ENDPOINTS, and the channel is untouched', async () => {
    const t = bootstrap();
    try {
      await send(t, `${canonical('cc-outsider')} heads up`);
      const pair = pairOf(t, t.outsider.id)!;

      // The retired #1989 admission block, asserted absent one row at a time. A
      // `direct_pair`'s two participants are derived from its ENDPOINT columns, so
      // there is nothing to project into a roster table — and the reason that matters
      // is that a roster row is a thing another rule can later filter or join on,
      // while an endpoint is the aggregate's identity.
      expect(humanMemberIdsOf(t, pair)).toEqual([]);
      expect(t.conversations.listAgents(pair)).toEqual([]);
      expect(t.conversations.listUserMembers(pair)).toEqual([]);
      expect(t.conversations.get(pair)?.workspace_id).toBeNull();
      // The mention did NOT put the agent in the source workspace or its channel —
      // the CC exists precisely because it may not. This is the invariant that keeps
      // "type a handle" from being a roster mutation (#task:2000 layer ①).
      expect(workspaceMemberAgentIdsOf(t, t.workspace.id)).toEqual([t.insider.id]);
      expect(t.conversations.isAgentParticipant(t.channel.id, t.outsider.id)).toBe(false);
      // Both endpoints participate in the line, through the one authority.
      expect(t.conversations.isAgentParticipant(pair, t.outsider.id)).toBe(true);
      expect(t.conversations.isAgentParticipant(pair, t.insider.id)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('tells the agent the truth: it cannot read the channel, but this line IS answerable', async () => {
    const t = bootstrap();
    try {
      await send(t, 'ship it <silverhand://agent/cc-outsider>');
      const copy = copiesTo(t, t.outsider.id)[0]!;

      expect(copy.content).toContain(canonical('cc-outsider'));
      // Free-text labels ride in code spans so a channel title cannot fabricate
      // Markdown structure in a body the agent reads verbatim on stdin.
      expect(copy.content).toContain('`eng`');
      expect(copy.content).toContain('`general`');
      // The quoted original is a blockquote, which is also why re-stating its
      // references cannot re-deliver them.
      expect(copy.content).toContain('> ship it <silverhand://agent/cc-outsider>');
      // The v71 wrap ended in a dead end ("there is nothing to answer here") because
      // the destination had no other participant. It does now, and the text says the
      // one true thing about the two streams: the channel is unreadable, this line is
      // answerable. Asserting the retired sentence is ABSENT is the half that catches
      // a revert of the destination without a revert of the text.
      expect(copy.content).not.toMatch(/nothing to answer here/i);
      expect(copy.content).toContain('answer here');
      expect(copy.content).toMatch(/cannot read it or reply there/i);
      // And it does not promise the agent a way INTO the channel: only a person can
      // put it there (#task:2072 keeps the roster gate where it is).
      expect(copy.content).toContain('only a person can put you in it');
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC — what does NOT get copied', () => {
  it('skips an agent that is already a member: it received the original', async () => {
    const t = bootstrap();
    try {
      const result = await send(t, `${canonical('cc-insider')} please review`);
      await waitFor(() => logEvents(t.logger.info).includes('mention_cc.skip'));

      expect(copiesTo(t, t.insider.id)).toEqual([]);
      // No line was opened either: a skip happens BEFORE the mint, so a member's
      // mention leaves no `direct_pair` behind for the author to wonder about.
      expect(pairOf(t, t.insider.id)).toBeNull();
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      expect(logCalls(t.logger.info).find(f => f.event === 'mention_cc.skip')).toMatchObject({
        reason: 'already_member',
        handle: 'cc-insider',
        agentId: t.insider.id,
        sourceConversationId: t.channel.id,
        sourceMessageId: result.committed.message.id,
      });
      // The member's own delivery is the normal fan-out, not a CC.
      expect(t.fake.delivered).toEqual([
        {
          conversationId: t.channel.id,
          agentId: t.insider.id,
          messageId: result.committed.message.id,
        },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('copies once for a handle written twice in one message', async () => {
    const t = bootstrap();
    try {
      await send(t, `${canonical('cc-outsider')} and again ${canonical('cc-outsider')}`);
      await waitFor(() => t.fake.starts.length > 0);

      // One copy, one notification, and — the part worth stating — NO skip: the
      // shared parser already dedupes by `(kind, handle)`, so the second spelling
      // never reaches the write half at all. The write half's own duplicate guard
      // is about its argument type, not about user input; it is exercised in the
      // write-half suite below.
      expect(copiesTo(t, t.outsider.id)).toHaveLength(1);
      expect(t.notifications.list({ userId: 'local' })).toHaveLength(1);
      expect(logEvents(t.logger.info)).not.toContain('mention_cc.skip');
    } finally {
      t.cleanup();
    }
  });

  it('skips an unknown handle without failing the send', async () => {
    const t = bootstrap();
    try {
      const result = await send(t, `${canonical('cc-nobody')} hello?`);
      await waitFor(() => logEvents(t.logger.info).includes('mention_cc.skip'));

      expect(result.committed.message.content).toContain('cc-nobody');
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      expect(logCalls(t.logger.info).find(f => f.event === 'mention_cc.skip')).toMatchObject({
        reason: 'unknown_handle',
        handle: 'cc-nobody',
        agentId: null,
      });
    } finally {
      t.cleanup();
    }
  });

  it('ignores the plain `@handle` alias and human references', async () => {
    const t = bootstrap();
    try {
      // #task:2000: the alias renders a chip and addresses nobody, and a human
      // reference addresses a person, who is not an agent the CC can copy to.
      await send(t, '@cc-outsider ping — <silverhand://human/local-test> fyi');

      expect(copiesTo(t, t.outsider.id)).toEqual([]);
      expect(pairOf(t, t.outsider.id)).toBeNull();
      expect(t.notifications.list({ userId: 'local' }).map(n => n.kind)).not.toContain(
        'mention_external',
      );
      expect(logEvents(t.logger.info)).not.toContain('mention_cc.skip');
    } finally {
      t.cleanup();
    }
  });

  it('does not CC an AGENT-authored mention: an agent cannot reach into a channel it was not put in', async () => {
    const t = bootstrap();
    try {
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.insider.id, conversationId: t.channel.id },
        destination: stream(t.channel.id),
        content: `${canonical('cc-outsider')} take this over`,
      });

      // `POLICIES.agent.ccMentions` is false, so the write half never runs — no
      // copy, no notification, and nothing skipped (a skip would mean the
      // decision was made per-handle instead of per-policy).
      expect(copiesTo(t, t.outsider.id)).toEqual([]);
      expect(pairOf(t, t.outsider.id)).toBeNull();
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      expect(logEvents(t.logger.info)).not.toContain('mention_cc.skip');
    } finally {
      t.cleanup();
    }
  });

  it('skips an agent no human may open a direct line to, and tells the author it reached nobody', async () => {
    const t = bootstrap();
    try {
      // A conversation-scoped agent (#task:2072). It is a REAL, viewable, addressable
      // handle — `extractMessageReferences` resolves it and the send commits — but its
      // human entry is its own workspace, so `canInitiateDirectMessageToAgent` refuses
      // the line and the CC has no destination it may create.
      //
      // This is the arm that makes the redirect honest. Minting unconditionally would
      // have been a text-typed privilege escalation: the pair-endpoint arm of
      // `canViewAgent` means holding a line with an agent GRANTS visibility of it, so
      // anyone who could guess a globally unique handle could self-grant it.
      const result = await send(t, `${canonical('cc-conv-scoped')} can you take this?`);
      await waitFor(() => logEvents(t.logger.info).includes('mention_cc.skip'));

      // Nothing was created, and nothing was written.
      expect(pairOf(t, t.convScoped.id)).toBeNull();
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      // The author's message stands — a refused CC is not a refused send.
      expect(t.messages.listForConversation(t.channel.id).map(m => m.id)).toContain(
        result.committed.message.id,
      );
      // NOT silent: the author is told the reference reached nobody, through the one
      // reason-free channel that already reports every other unreachable reference —
      // so a refused mention cannot be mistaken for a delivered one, and the report
      // still says nothing about WHY (which would make it an existence oracle).
      expect(result.unresolvedReferences).toEqual([
        { kind: 'agent', handle: 'cc-conv-scoped' },
      ]);
      // The operator-facing half carries the reason, where an oracle costs nothing.
      expect(
        logCalls(t.logger.info)
          .filter(fields => fields.event === 'mention_cc.skip')
          .map(fields => ({ handle: fields.handle, reason: fields.reason })),
      ).toEqual([{ handle: 'cc-conv-scoped', reason: 'no_direct_line' }]);
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC — one transaction with the send (§5)', () => {
  it('rolls the human send back when the CC write fails', async () => {
    const t = bootstrap();
    try {
      const before = t.messages.listForConversation(t.channel.id).length;
      // Injected through the tx scope, so this also proves the CC read the
      // notification port THROUGH the scope rather than through a captured
      // outside repo.
      t.txWrap.current = tx =>
        overrideScope(tx, {
          notifications: {
            insertMentionExternal: () => {
              throw new Error('notification insert exploded');
            },
          },
        });

      await expect(send(t, `${canonical('cc-outsider')} hi`)).rejects.toThrow(
        'notification insert exploded',
      );
      t.txWrap.current = null;

      // The message the human wrote is gone WITH the copy. Under the pre-v71
      // post-commit CC, the source message would be committed here and only the
      // copy lost — silently.
      expect(t.messages.listForConversation(t.channel.id)).toHaveLength(before);
      expect(copiesTo(t, t.outsider.id)).toEqual([]);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      expect(t.fake.starts).toEqual([]);
      // …and so is the DESTINATION (#task:2072). The mint runs in this same
      // transaction for exactly this reason: a pair that survived the rollback would
      // be an empty line in the author's DM list, announced or not, that nothing in
      // the model explains. This is also why the announcement could not be published
      // at the mint — it would have described a row that no longer exists.
      expect(pairOf(t, t.outsider.id)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('copies to a RESERVED-but-failed agent: the handle is addressable, so the send mints its destination', async () => {
    const t = bootstrap();
    try {
      // The mention resolver reads `agents` with no `materialization_status` filter,
      // so a handle is addressable from the reserve INSERT onward — including for a
      // row whose materialization failed and is waiting for `?retry=true`. What that
      // costs the CC changed with #task:2072: the destination is minted on demand from
      // the two principals, so an addressable handle can ALWAYS be copied to, and no
      // provisioning outcome can make a human's own send fail.
      const reserved = createSqliteAgentProvisioningPersistence(
        t.db,
      ).reserveAgentRow({
        input: { name: 'cc-reserved', runtime: 'claude', session_scope: 'agent' },
        defaultHostId: t.localHostId,
        createdByUserId: 'local',
        idempotencyKey: 'k-cc-reserved',
      });
      t.agents.flipToFailed(reserved.id, 'host_attach_pending', 1);
      expect(t.agents.getRow(reserved.id)?.materialization_status).toBe('failed');

      const result = await send(t, `${canonical('cc-reserved')} hello`);

      const pair = pairOf(t, reserved.id)!;
      const copies = t.messages.listForConversation(pair);
      expect(copies).toHaveLength(1);
      expect(ccSourceOf(t, copies[0]!.id)).toBe(result.committed.message.id);
      expect(t.inboxes.listPending(pair, reserved.id)).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it('a committed copy always carries its delivery row and notification', async () => {
    const t = bootstrap();
    try {
      await send(t, `${canonical('cc-outsider')} one`);
      await send(t, `${canonical('cc-outsider')} two`);

      const pair = pairOf(t, t.outsider.id)!;
      const copies = t.messages.listForConversation(pair);
      expect(copies).toHaveLength(2);
      // The three facts are written together, so their counts cannot diverge —
      // which is the property that makes "copy exists but nobody was told" and
      // "told but nothing queued" both unreachable.
      expect(t.inboxes.listPending(pair, t.outsider.id)).toHaveLength(2);
      expect(t.notifications.list({ userId: 'local' })).toHaveLength(2);
      expect(new Set(copies.map(copy => ccSourceOf(t, copy.id))).size).toBe(2);
      // The SECOND send opened nothing — `getOrCreateDirectPair` found the row — so
      // only the first sees the announcement. The list still owes a frame for the
      // second (its order and preview moved), which is why the report's opened-ids
      // set is deliberately not the copies set; that frame is the ordinary
      // conversation `message` frame the copy already publishes.
      expect(
        logCalls(t.logger.error).filter(f => f.event === 'mention_cc.pair_open_unannounced'),
      ).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC — the write half on states a user send cannot produce', () => {
  /** The write half, run in a real transaction through the production scope.
   *  `references` defaults to what the send boundary would derive, and
   *  `directLineAgentIds` to the boundary's verdict for the fixture's target — the
   *  cases here are about states BEFORE that gate, so passing an empty set would
   *  make every one of them pass for the wrong reason. */
  const runWrite = (
    t: Fixture,
    input: {
      message: MessageDto;
      sourceConversation: ConversationDto;
      references?: readonly Reference[];
      directLineAgentIds?: ReadonlySet<string>;
    },
  ): MentionCcReport =>
    t.persistence.message.uow.atomically(tx =>
      writeMentionCcCopies(tx, {
        message: input.message,
        sourceConversation: input.sourceConversation,
        references: input.references ?? extractMessageReferences(input.message.content),
        directLineAgentIds:
          input.directLineAgentIds ?? new Set([t.outsider.id]),
      }),
    );

  const authoredMessage = (t: Fixture, content: string): MessageDto =>
    t.messages.insertForConversation({
      conversationId: t.channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content,
    });

  it('skips a repeated reference rather than letting the partial UNIQUE abort the send', () => {
    const t = bootstrap();
    try {
      const message = authoredMessage(t, `${canonical('cc-outsider')} twice`);
      // The send boundary cannot produce this list — `extractMessageReferences`
      // dedupes by `(kind, handle)` and handles are unique — so the guard being
      // tested here defends the write half's DECLARED input (a reference list),
      // not user input. Without it the second copy hits
      // `UNIQUE(cc_source_message_id, conversation_id)` and the human's send dies
      // on a constraint error; with it, one copy and a domain-shaped skip.
      const twice: Reference[] = [
        { kind: 'agent', handle: 'cc-outsider' },
        { kind: 'agent', handle: 'cc-outsider' },
      ];
      const report = runWrite(t, {
        message,
        sourceConversation: t.conversations.get(t.channel.id)!,
        references: twice,
      });

      expect(report.copies).toHaveLength(1);
      expect(report.skipped).toEqual([
        { handle: 'cc-outsider', reason: 'duplicate_reference', agentId: t.outsider.id },
      ]);
      expect(copiesTo(t, t.outsider.id)).toHaveLength(1);
      expect(t.notifications.list({ userId: 'local' })).toHaveLength(1);
      // One mint, announced once: the guard runs before `openDirectPair`, so a
      // repeated reference cannot double-announce a line either.
      expect(report.openedPairConversationIds).toEqual([pairOf(t, t.outsider.id)]);
    } finally {
      t.cleanup();
    }
  });

  it('skips a row with no resolvable author: option A has no viewer without one', () => {
    const t = bootstrap();
    try {
      const message = authoredMessage(t, `${canonical('cc-outsider')} legacy row`);
      // Only legacy rows reach this state — a user send always carries its
      // actor's id — and guessing a viewer would send someone else's mention
      // notification to whoever happens to be the only human.
      const report = runWrite(t, {
        message: { ...message, from_user_id: null },
        sourceConversation: t.conversations.get(t.channel.id)!,
      });

      expect(report.copies).toEqual([]);
      expect(report.skipped).toEqual([
        { handle: 'cc-outsider', reason: 'unresolved_author', agentId: t.outsider.id },
      ]);
      expect(copiesTo(t, t.outsider.id)).toEqual([]);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      // Ordered BEFORE the direct-line check on purpose: with no author there is no
      // human endpoint to open a line with, so asking whose line it is would be
      // asking the wrong question — and a pair keyed on a guessed viewer is a line
      // between two principals who never spoke.
      expect(pairOf(t, t.outsider.id)).toBeNull();
      expect(report.openedPairConversationIds).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('skips a workspace-less source instead of throwing: the copy has no coordinate, the send is still valid', () => {
    const t = bootstrap();
    try {
      const message = authoredMessage(t, `${canonical('cc-outsider')} from a DM`);
      // The insider's own direct line as the SOURCE. The write step is driven
      // directly because its RETURN VALUE is the contract the post-commit
      // dispatcher consumes — the integration twin below asserts the same verdict
      // through a real human send, but only from the outside. What changed in
      // #task:2021 P4-5 is the ANSWER: this used to throw, and throwing from inside
      // the send transaction rolls back a message the write gate had already
      // admitted. A source with no workspace has no coordinate to name the copy
      // after (the wrap text and the `mention_external` row are both keyed by it),
      // so the CC is declined AS DATA and the send commits.
      const source = t.conversations.get(
        t.conversations.getOrCreateDirectPair(
          { kind: 'human', id: 'local' },
          { kind: 'agent', id: t.insider.id },
          1_700_000_000_000,
        ).conversation.id,
      )!;
      expect(source.workspace_id).toBeNull();
      const report = runWrite(t, {
        message,
        sourceConversation: source,
      });

      expect(report.copies).toEqual([]);
      expect(report.skipped).toEqual([
        { handle: 'cc-outsider', reason: 'source_not_workspace_placed' },
      ]);
      // A skip, not a partial write: no copy, no queued delivery, no notification —
      // and no line opened, because the refusal precedes the mint.
      expect(copiesTo(t, t.outsider.id)).toEqual([]);
      expect(pairOf(t, t.outsider.id)).toBeNull();
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

/**
 * The workspace-less source is REACHABLE (#task:2021: P4-4 opened the write gate
 * for a DM's human endpoint, P4-5 makes such a send deliver). So the case above
 * gets an integration twin: the exact human send that used to 500 AFTER passing
 * every gate — a durable-looking failure on the human's screen for the crime of
 * naming a third agent in a DM.
 */
describe('mention CC — a DM source declines the CC without failing the send', () => {
  it('commits the DM message, writes no copy, and reports the skip after commit', async () => {
    const t = bootstrap();
    try {
      // The human endpoint of a DM with `insider`, built through the aggregate's
      // only constructor.
      const dm = t.conversations.getOrCreateDirectPair(
        { kind: 'human', id: 'local' },
        { kind: 'agent', id: t.insider.id },
        1_700_000_000_000,
      ).conversation.id;
      expect(t.conversations.get(dm)!.workspace_id).toBeNull();

      const result = await t.service.sendMessage({
        conversationId: dm,
        actor: { kind: 'user', userId: 'local' },
        destination: { kind: 'own_main_line' },
        content: `${canonical('cc-outsider')} take a look`,
      });
      await waitFor(() => logEvents(t.logger.info).includes('mention_cc.skip'));

      // The send is intact: one message in the DM, content unchanged.
      expect(t.messages.listForConversation(dm).map(m => m.id)).toEqual([
        result.committed.message.id,
      ]);
      expect(result.committed.message.content).toBe(
        `${canonical('cc-outsider')} take a look`,
      );
      // …and the CC wrote nothing anywhere, and opened no line.
      expect(copiesTo(t, t.outsider.id)).toEqual([]);
      expect(pairOf(t, t.outsider.id)).toBeNull();
      // No notification of ANY kind: not a mention CC (declined as data), and not
      // an `agent_start_failed` either — the DM endpoint's wake is an ORDINARY
      // one, because a workspace-less placement has a session scope (#task:2019).
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      // The ONE warn this send produces is the author's own report (#task:2021
      // P4-5-b): the CC declined and `cc-outsider` is not an endpoint of this DM,
      // so the reference reached nobody — which is exactly what the human is told,
      // while the message itself stands.
      expect(logEvents(t.logger.warn)).toEqual(['send.references_unresolved']);
      expect(result.unresolvedReferences).toEqual([
        { kind: 'agent', handle: 'cc-outsider' },
      ]);
      // The decision is REPORTED, not silent: an operator asking "why did my
      // mention not arrive" has the reason and the handle.
      expect(
        logCalls(t.logger.info)
          .filter(fields => fields.event === 'mention_cc.skip')
          .map(fields => ({ handle: fields.handle, reason: fields.reason })),
      ).toEqual([{ handle: 'cc-outsider', reason: 'source_not_workspace_placed' }]);
      // The other endpoint still receives the message itself — the CC declining is
      // not the delivery path (#task:2021 P4-5 layer ①).
      await waitFor(() =>
        t.fake.delivered.some(
          d => d.agentId === t.insider.id && d.messageId === result.committed.message.id,
        ),
      );
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC — the post-commit half is the only best-effort part', () => {
  /** One copy into `pair-1`, which THIS send opened — the ordinary shape. `opened`
   *  is overridable so the coverage proof below can be handed the one shape the
   *  dispatcher must not accept silently. */
  const report = (
    overrides: Partial<MentionCcReport['copies'][number]> = {},
    opened: string[] = ['pair-1'],
  ): MentionCcReport => ({
    copies: [
      {
        agentId: 'agent-1',
        agentHandle: 'cc-outsider',
        conversationId: 'pair-1',
        wrapped: { id: 'copy-1' } as MessageDto,
        notifiedUserId: 'local',
        ...overrides,
      },
    ],
    skipped: [],
    openedPairConversationIds: opened,
    source: { conversationId: 'channel-1', messageId: 'source-1' },
  });

  const deps = (start: (c: string, a: string) => Promise<void>, deliver = async () => {}) => {
    const logger: BackendLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const events = new ScopeEventBus('test-epoch');
    const delivered: string[] = [];
    return {
      logger,
      events,
      delivered,
      deps: {
        runtimeStart: { start },
        runtimeDeliver: {
          deliverMessage: async (c: string, a: string, m: string) => {
            delivered.push(m);
            await deliver();
          },
        },
        events,
        logger,
      },
    };
  };

  it('keeps the durable row when the wake fails — one arm, for every reason', async () => {
    const h = deps(async () => {
      throw new Error('spawn refused');
    });
    await dispatchMentionCcEffects(report(), h.deps);

    // ONE arm on purpose. v71 also had a typed
    // `runtime_placement_unsupported` deferral here, and its only `throw` site in
    // the whole repo was a fake in THIS file — a failure shape no production host
    // can produce, asserted by manufacturing it. #task:2019 made the refusal
    // impossible and P4-5 deleted the class, the branch and that case
    // rather than keeping them as defensive contract, because a caller reading
    // them would take the shape for supported host semantics. What survives is the
    // claim that actually holds for every refusal: the copy and its durable inbox
    // row are already committed, so a failed wake is a delayed wake.
    expect(logEvents(h.logger.warn)).toEqual(['mention_cc.wake_failed']);
    expect(h.delivered).toEqual([]);
  });

  it('keeps the durable row when the live dispatch fails after a successful start', async () => {
    const h = deps(
      async () => {},
      async () => {
        throw new Error('deliver refused');
      },
    );
    await dispatchMentionCcEffects(report(), h.deps);

    expect(h.delivered).toEqual(['copy-1']);
    expect(logEvents(h.logger.warn)).toEqual(['mention_cc.dispatch_failed']);
  });

  it('tells the author the line EXISTS before it puts a message in it, then wakes', async () => {
    const order: string[] = [];
    const h = deps(async () => {
      order.push('start');
    });
    const pairFrames: string[] = [];
    const viewerFrames: unknown[] = [];
    h.events.subscribe('pair-1', e => {
      order.push('frame');
      pairFrames.push(e.kind);
    });
    h.events.subscribeScope('viewer:local', e => {
      order.push(`viewer:${e.kind}`);
      viewerFrames.push({ kind: e.kind, payload: e.payload });
    });

    await dispatchMentionCcEffects(report(), h.deps);

    expect(pairFrames).toEqual(['message']);
    expect(viewerFrames).toEqual([
      { kind: 'direct_pairs_changed', payload: { conversation_id: 'pair-1' } },
      {
        kind: 'notification',
        payload: {
          kind: 'mention_external',
          conversation_id: 'channel-1',
          message_id: 'source-1',
        },
      },
    ]);
    // ORDER IS THE CLAIM (#task:2035 + #task:2072). The list invalidation goes out
    // FIRST because the list is the authority for what exists: a live client that
    // received a `message` frame for a conversation it has never heard of has nothing
    // to apply it to. Then the copy's own frame, then the wake — the frames do not
    // depend on the wake succeeding, because a client with the line open must see the
    // copy even on the deferred path.
    expect(order).toEqual([
      'viewer:direct_pairs_changed',
      'frame',
      'viewer:notification',
      'start',
    ]);
    expect(logCalls(h.logger.warn)).toEqual([]);
    expect(logCalls(h.logger.error)).toEqual([]);
  });

  it('PROVES it announced every pair the transaction opened, instead of trusting the caller', async () => {
    // The obligation #task:2035 fused to the allocation, discharged the only way an
    // in-transaction minter can: recorded as data, published after commit. What makes
    // it an obligation and not a hope is this check — the dispatcher walks the ids the
    // transaction opened and reports any it did not cover.
    //
    // The state below is unreachable through `writeMentionCcCopies` today (every mint
    // there is followed by a copy that names it), and that is exactly why it is
    // asserted here rather than left to the code being read correctly: the next way to
    // skip a copy AFTER the mint would otherwise reintroduce the #task:2035 bug — an
    // opened line the author's list never learns about — with every test still green.
    const h = deps(async () => {});
    await dispatchMentionCcEffects(report({}, ['pair-1', 'pair-orphan']), h.deps);

    expect(
      logCalls(h.logger.error).map(fields => ({
        event: fields.event,
        conversationId: fields.conversationId,
      })),
    ).toEqual([
      { event: 'mention_cc.pair_open_unannounced', conversationId: 'pair-orphan' },
    ]);
  });
});
