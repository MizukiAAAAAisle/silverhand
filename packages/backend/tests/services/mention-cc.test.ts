/**
 * Mention CC, v71 (#task:2014 / agent-scoped-session-v1 §4.2 + §5).
 *
 * The model this suite gates is the one the ticket introduced, and every case
 * below exists because a DIFFERENT way of getting it wrong would go unnoticed:
 *
 *  1. The destination is the mentioned agent's INBOX PLACEMENT — workspace-less,
 *     rosterless, one participant. The retired model copied into a `Mentions` DM
 *     under the agent's home workspace and ADMITTED the human author to it
 *     (`conversation_users` + `workspace_users`, #task:1989). So "no human
 *     participant anywhere" is asserted directly, not implied: that admission is
 *     the regression this file is here to catch.
 *  2. The copy is written INSIDE THE SEND'S TRANSACTION. It used to be a
 *     post-commit best-effort call, where a crash in the gap committed the
 *     human's message and lost the copy silently. Both directions are gated:
 *     a failure anywhere in the CC rolls the human's send back, and there is no
 *     path that commits one without the other.
 *  3. The wake is the ONLY best-effort part, and today it DEFERS: an inbox has no
 *     workspace to derive a session cwd from until #task:2019. The fake runtime
 *     host below therefore mirrors production's placement gate rather than
 *     accepting every start — a permissive fake would let this suite claim a wake
 *     that cannot happen, and would go green on the day #2019 regresses it.
 *
 * Driven through `ConversationMessageService.sendMessage` wherever the claim is
 * about the send's transaction, because "same transaction" is not a property of
 * `writeMentionCcCopies` in isolation — it is a property of who calls it and
 * where. The write half is called directly only for the two states a user send
 * cannot produce (a legacy authorless row, a workspace-less source).
 */
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
  AgentInboxMissingError,
  dispatchMentionCcEffects,
  writeMentionCcCopies,
} from '../../src/application/mention-cc.js';
import type { MentionCcReport } from '../../src/application/mention-cc.js';
import type { MessageTxScope } from '../../src/services/conversation-message/ports.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { RuntimePlacementUnsupportedError } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import { overrideScope, uowWithScopeWrap } from '../utils/tx-fault.js';

/**
 * A runtime host that refuses to start a run in a conversation with no workspace
 * placement — the same rule production applies in
 * `outbound-event-fanout.runtimeStartOptions` (v71 §7.3), and the reason the
 * inbox wake is deferred rather than performed. Mirrored here so the integration
 * cases assert TODAY's end state; a fake that accepted the start would assert a
 * capability that does not exist.
 */
class FakeRuntimeHost {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];

  constructor(private readonly workspaceOf: (conversationId: string) => string | null) {}

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
    if (this.workspaceOf(conversationId) === null) {
      throw new RuntimePlacementUnsupportedError(conversationId);
    }
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
 * conversation insert — including the inboxes created below. With it on, "the
 * inbox has no human participant" would be untestable, and worse, the retired
 * #1989 admission writes would be indistinguishable from the seed.
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
  const fake = new FakeRuntimeHost(id => conversations.get(id)?.workspace_id ?? null);
  const logger: BackendLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const workspace = workspaces.insert({ name: 'eng', description: null });
  const channel = conversations.insertChannel({
    name: 'ch-1',
    workspaceId: workspace.id,
    title: 'general',
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
  const insider = agents.create({ name: 'cc-insider', runtime: 'claude' }, localHostId, 'local');
  const outsider = agents.create({ name: 'cc-outsider', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, insider.id);
  conversations.addAgent(channel.id, insider.id);

  // The Agent aggregate's inbox invariant. `reserveAgentAggregate` performs
  // exactly this insert in the same transaction as the `agents` row; the v71
  // migration performed it for pre-existing agents. A test that skipped it would
  // be testing a broken aggregate — which is its own case, `agent with no inbox`
  // below.
  const insiderInbox = conversations.insertAgentInbox(insider.id, insider.created_at);
  const outsiderInbox = conversations.insertAgentInbox(outsider.id, outsider.created_at);

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
    insiderInbox,
    outsiderInbox,
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

describe('mention CC v71 — the copy, in the send transaction', () => {
  it('lands in the mentioned agent inbox with source provenance, a delivery row, and the author notification', async () => {
    const t = bootstrap();
    try {
      const inboxFrames: Array<{ kind: string; payload: unknown }> = [];
      const viewerFrames: Array<{ kind: string; payload: unknown }> = [];
      const workspaceFrames: Array<{ kind: string; payload: unknown }> = [];
      const unsubInbox = t.events.subscribe(t.outsiderInbox.id, e => {
        inboxFrames.push({ kind: e.kind, payload: e.payload });
      });
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerFrames.push({ kind: e.kind, payload: e.payload });
      });
      const unsubWorkspace = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        workspaceFrames.push({ kind: e.kind, payload: e.payload });
      });

      const result = await send(t, `${canonical('cc-outsider')} can you look at the parser?`);
      await waitFor(() => logEvents(t.logger.warn).includes('mention_cc.wake_deferred'));
      unsubInbox();
      unsubViewer();
      unsubWorkspace();

      // ── the copy ────────────────────────────────────────────────────────
      const copies = t.messages.listForConversation(t.outsiderInbox.id);
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
      const pending = t.inboxes.listPending(t.outsiderInbox.id, t.outsider.id);
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
      // Never the inbox copy: the author cannot read the inbox, and a pointer
      // there would be a click into a 403.
      expect(notifications[0]!.conversation_id).not.toBe(t.outsiderInbox.id);
      expect(notifications[0]!.message_id).not.toBe(copy.id);

      // ── the frames ──────────────────────────────────────────────────────
      expect(inboxFrames.map(f => f.kind)).toEqual(['message']);
      expect((inboxFrames[0]!.payload as { message: MessageDto }).message.id).toBe(copy.id);
      // No per-viewer unread for a conversation no human is in, and no channel
      // list fan-out for a placement that is in no workspace.
      expect(inboxFrames.map(f => f.kind)).not.toContain('unread_updated');
      expect(workspaceFrames.map(f => f.kind)).not.toContain('workspace_channels_changed');
      expect(
        viewerFrames.filter(f => f.kind === 'notification').map(f => f.payload),
      ).toEqual([
        {
          kind: 'mention_external',
          conversation_id: t.channel.id,
          message_id: result.committed.message.id,
        },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('admits nobody: no human participant, no roster row, no workspace membership', async () => {
    const t = bootstrap();
    try {
      await send(t, `${canonical('cc-outsider')} heads up`);

      // The whole retired #1989 admission block, asserted absent one row at a
      // time. The inbox's single participant is derived from `inbox_agent_id`;
      // nothing is projected into a roster table for it (§4.2).
      expect(humanMemberIdsOf(t, t.outsiderInbox.id)).toEqual([]);
      expect(t.conversations.listAgents(t.outsiderInbox.id)).toEqual([]);
      expect(t.conversations.listUserMembers(t.outsiderInbox.id)).toEqual([]);
      // …and the placement itself still has no workspace to be admitted INTO.
      expect(t.conversations.get(t.outsiderInbox.id)?.workspace_id).toBeNull();
      expect(workspaceMemberAgentIdsOf(t, t.workspace.id)).toEqual([t.insider.id]);
      // Participation without a roster row is exactly what the inbox owner has.
      expect(t.conversations.isAgentParticipant(t.outsiderInbox.id, t.outsider.id)).toBe(true);
      expect(t.conversations.isAgentParticipant(t.outsiderInbox.id, t.insider.id)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('tells the agent the truth: no reply route, and the original quoted', async () => {
    const t = bootstrap();
    try {
      await send(t, 'ship it <silverhand://agent/cc-outsider>');
      const copy = t.messages.listForConversation(t.outsiderInbox.id)[0]!;

      expect(copy.content).toContain(canonical('cc-outsider'));
      // Free-text labels ride in code spans so a channel title cannot fabricate
      // Markdown structure in a body the agent reads verbatim on stdin.
      expect(copy.content).toContain('`eng`');
      expect(copy.content).toContain('`general`');
      // The quoted original is a blockquote, which is also why re-stating its
      // references cannot re-deliver them.
      expect(copy.content).toContain('> ship it <silverhand://agent/cc-outsider>');
      // The retired wrap promised a reply route that never existed for an inbox.
      expect(copy.content).not.toMatch(/reply here/i);
      expect(copy.content).toContain('there is nothing to answer here');
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC v71 — what does NOT get copied', () => {
  it('skips an agent that is already a member: it received the original', async () => {
    const t = bootstrap();
    try {
      const result = await send(t, `${canonical('cc-insider')} please review`);
      await waitFor(() => logEvents(t.logger.info).includes('mention_cc.skip'));

      expect(t.messages.listForConversation(t.insiderInbox.id)).toEqual([]);
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
      expect(t.messages.listForConversation(t.outsiderInbox.id)).toHaveLength(1);
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
      // reference addresses a person, who has no inbox to copy into.
      await send(t, '@cc-outsider ping — <silverhand://human/local-test> fyi');

      expect(t.messages.listForConversation(t.outsiderInbox.id)).toEqual([]);
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
        content: `${canonical('cc-outsider')} take this over`,
      });

      // `POLICIES.agent.ccMentions` is false, so the write half never runs — no
      // copy, no notification, and nothing skipped (a skip would mean the
      // decision was made per-handle instead of per-policy).
      expect(t.messages.listForConversation(t.outsiderInbox.id)).toEqual([]);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      expect(logEvents(t.logger.info)).not.toContain('mention_cc.skip');
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC v71 — one transaction with the send (§5)', () => {
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
      expect(t.messages.listForConversation(t.outsiderInbox.id)).toEqual([]);
      expect(t.inboxes.listPending(t.outsiderInbox.id, t.outsider.id)).toEqual([]);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      expect(t.fake.starts).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('fails loud on a broken Agent aggregate (an agent with no inbox) and commits nothing', async () => {
    const t = bootstrap();
    try {
      // An agent WITHOUT the inbox its aggregate is supposed to carry. There is
      // no lazy create here on purpose: a get-or-create is what allowed two
      // `Mentions` DMs to exist in the retired model.
      t.agents.create({ name: 'cc-broken', runtime: 'claude' }, t.localHostId, 'local');
      const before = t.messages.listForConversation(t.channel.id).length;

      await expect(send(t, `${canonical('cc-broken')} hello`)).rejects.toThrow(
        AgentInboxMissingError,
      );

      expect(t.messages.listForConversation(t.channel.id)).toHaveLength(before);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('copies to a RESERVED-but-failed agent: the handle is addressable, so the aggregate owes it a destination', async () => {
    const t = bootstrap();
    try {
      // The other half of the aggregate-ownership rule (#task:2014 B1). The
      // mention resolver reads `agents` with no `materialization_status` filter,
      // so a handle is addressable from the reserve INSERT onward — including for
      // a row whose materialization failed and is waiting for `?retry=true`. If
      // the inbox were born in the L3a dependent tx instead, this send would
      // throw `AgentInboxMissingError` INSIDE the human's message transaction:
      // a human losing their own message because someone else's agent failed to
      // provision hours earlier.
      const reserved = createSqliteAgentProvisioningPersistence(
        t.db,
      ).reserveAgentAggregate({
        input: { name: 'cc-reserved', runtime: 'claude' },
        defaultHostId: t.localHostId,
        createdByUserId: 'local',
        idempotencyKey: 'k-cc-reserved',
      });
      t.agents.flipToFailed(reserved.id, 'host_attach_pending', 1);
      expect(t.agents.getRow(reserved.id)?.materialization_status).toBe('failed');

      const result = await send(t, `${canonical('cc-reserved')} hello`);

      const inboxId = t.conversations.getAgentInbox(reserved.id)!.id;
      const copies = t.messages.listForConversation(inboxId);
      expect(copies).toHaveLength(1);
      expect(ccSourceOf(t, copies[0]!.id)).toBe(result.committed.message.id);
      expect(t.inboxes.listPending(inboxId, reserved.id)).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it('a committed copy always carries its delivery row and notification', async () => {
    const t = bootstrap();
    try {
      await send(t, `${canonical('cc-outsider')} one`);
      await send(t, `${canonical('cc-outsider')} two`);

      const copies = t.messages.listForConversation(t.outsiderInbox.id);
      expect(copies).toHaveLength(2);
      // The three facts are written together, so their counts cannot diverge —
      // which is the property that makes "copy exists but nobody was told" and
      // "told but nothing queued" both unreachable.
      expect(t.inboxes.listPending(t.outsiderInbox.id, t.outsider.id)).toHaveLength(2);
      expect(t.notifications.list({ userId: 'local' })).toHaveLength(2);
      expect(new Set(copies.map(copy => ccSourceOf(t, copy.id))).size).toBe(2);
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC v71 — the write half on states a user send cannot produce', () => {
  /** The write half, run in a real transaction through the production scope.
   *  `references` defaults to what the send boundary would derive. */
  const runWrite = (
    t: Fixture,
    input: {
      message: MessageDto;
      sourceConversation: ConversationDto;
      references?: readonly Reference[];
    },
  ): MentionCcReport =>
    t.persistence.message.uow.atomically(tx =>
      writeMentionCcCopies(tx, {
        message: input.message,
        sourceConversation: input.sourceConversation,
        references: input.references ?? extractMessageReferences(input.message.content),
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
      expect(t.messages.listForConversation(t.outsiderInbox.id)).toHaveLength(1);
      expect(t.notifications.list({ userId: 'local' })).toHaveLength(1);
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
      expect(t.messages.listForConversation(t.outsiderInbox.id)).toEqual([]);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('refuses a workspace-less source: a human is never a participant of one (§4.2)', () => {
    const t = bootstrap();
    try {
      const message = authoredMessage(t, `${canonical('cc-outsider')} from an inbox`);
      // The insider's own inbox as the SOURCE. The invariant is that no
      // user-authored message can originate there; if that ever becomes false,
      // this must be redesigned rather than defaulted to some workspace.
      expect(() =>
        runWrite(t, {
          message,
          sourceConversation: t.conversations.get(t.insiderInbox.id)!,
        }),
      ).toThrow(/has no workspace placement/);
      expect(t.messages.listForConversation(t.outsiderInbox.id)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe('mention CC v71 — the post-commit half is the only best-effort part', () => {
  const report = (overrides: Partial<MentionCcReport['copies'][number]> = {}): MentionCcReport => ({
    copies: [
      {
        agentId: 'agent-1',
        agentHandle: 'cc-outsider',
        inboxConversationId: 'inbox-1',
        wrapped: { id: 'copy-1' } as MessageDto,
        notifiedUserId: 'local',
        ...overrides,
      },
    ],
    skipped: [],
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

  it('defers the wake — not "delivery failed" — when the inbox has no session scope (#task:2019)', async () => {
    const h = deps(async (conversationId: string) => {
      throw new RuntimePlacementUnsupportedError(conversationId);
    });
    await dispatchMentionCcEffects(report(), h.deps);

    // The bounded, known gap: the durable row is committed, so the next spawn
    // with a scope drains it. Nothing may be logged as a delivery failure, and
    // no live dispatch may be attempted against a runtime that never started.
    expect(logCalls(h.logger.warn)).toHaveLength(1);
    expect(logCalls(h.logger.warn)[0]).toMatchObject({
      event: 'mention_cc.wake_deferred',
      reason: 'runtime_placement_unsupported',
      agentId: 'agent-1',
      inboxConversationId: 'inbox-1',
      wrappedMessageId: 'copy-1',
      sourceConversationId: 'channel-1',
      sourceMessageId: 'source-1',
    });
    expect(h.delivered).toEqual([]);
  });

  it('keeps the durable row when the wake fails for any other reason', async () => {
    const h = deps(async () => {
      throw new Error('spawn refused');
    });
    await dispatchMentionCcEffects(report(), h.deps);

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

  it('publishes the inbox message frame and the author notification before waking', async () => {
    const order: string[] = [];
    const h = deps(async () => {
      order.push('start');
    });
    const inboxFrames: string[] = [];
    const viewerFrames: unknown[] = [];
    h.events.subscribe('inbox-1', e => {
      order.push('frame');
      inboxFrames.push(e.kind);
    });
    h.events.subscribeScope('viewer:local', e => {
      viewerFrames.push({ kind: e.kind, payload: e.payload });
    });

    await dispatchMentionCcEffects(report(), h.deps);

    expect(inboxFrames).toEqual(['message']);
    expect(viewerFrames).toEqual([
      {
        kind: 'notification',
        payload: {
          kind: 'mention_external',
          conversation_id: 'channel-1',
          message_id: 'source-1',
        },
      },
    ]);
    // The frames do not depend on the wake succeeding — a client that has the
    // conversation open must see the copy even on the deferred path.
    expect(order).toEqual(['frame', 'start']);
    expect(logCalls(h.logger.warn)).toEqual([]);
  });
});
