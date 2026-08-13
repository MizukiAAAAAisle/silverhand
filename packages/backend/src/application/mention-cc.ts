import { formatReferenceToken, inlineCode, systemSubtype } from '@silverhand/shared';
import type {
  ConversationDto,
  DmChannelDto,
  MessageDto,
  Reference,
  WorkspaceDto,
} from '@silverhand/shared';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { BackendLogger } from '../context.js';
import type { ConversationViewerUnreadPublishPort } from '../services/conversation/unread-publish-port.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import type { WorkspaceRosterUnitOfWork } from './membership-ports.js';

/**
 * The persistence capability this cc fan-out needs, stated as ports
 * (#task:1982 W2). Every method is named after the DOMAIN act it performs, not
 * after the table it touches, so the constant parts of each write (`role =
 * 'member'`, `from_kind = 'system'`, `kind = 'mention_external'`) are decided
 * by WHICH method the use case calls and cannot drift per call site.
 *
 * They live in this file rather than a separate `ports.ts` because this module
 * is their only consumer — the concretes are assembled in
 * `adapters/mention-cc.ts`, which is where the `Database` handle stops.
 */
export interface MentionCcAgentReadPort {
  /** The mentioned handle, resolved to the addressable agent. Returns only the
   *  two fields the wrap needs; a handle that names no agent is `null`. */
  getByName(name: string): { id: string; name: string } | null;
}

export interface MentionCcConversationPort {
  /** Agent members of the SOURCE conversation — the set that already received
   *  the original message and therefore needs no DM copy. */
  listAgentIds(conversationId: string): string[];
  /** The agent's primary DM channel, or the one with the given title. `null`
   *  for a legacy agent provisioned before auto-DM. */
  findDmChannelForAgent(
    agentId: string,
    opts?: { title: string },
  ): DmChannelDto | null;
  /** Create the lazy `Mentions` DM inside the agent's home workspace. */
  insertDmChannel(input: {
    workspaceId: string;
    title: string;
    agentId: string;
  }): DmChannelDto;
  /** The sole human member of a conversation, or `null` when the answer is not
   *  unique. Used only for the legacy null-author path; a non-unique answer
   *  makes this pass skip its human-membership writes rather than guess. */
  singleViewerUserId(conversationId: string): string | null;
}

export interface MentionCcReadCursorPort {
  /** The viewer's cursor for ONE stream — `0` when they have no cursor row.
   *  Stream-qualified: a (user, conversation) has many cursor rows, so the
   *  mainline (`null`) and each thread root are distinct answers. */
  lastReadSeq(
    viewerUserId: string,
    conversationId: string,
    threadRootId: string | null,
  ): number;
}

export interface MentionCcMessageWritePort {
  /** Insert the wrapped `from_kind='system'` copy into the Mentions DM. */
  insertSystemMessage(input: {
    conversationId: string;
    content: string;
    metadata: Record<string, unknown>;
  }): MessageDto;
}

export interface MentionCcNotificationWritePort {
  /** Insert the viewer-scoped `mention_external` notification. */
  insertMentionExternal(input: {
    userId: string;
    agentId: string;
    workspaceId: string;
    conversationId: string;
    messageId: string;
    sourceWorkspaceId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    payload: {
      source_workspace_name: string;
      source_conversation_title: string;
      mention_excerpt: string;
    };
  }): void;
}

export interface MentionCcOpts {
  /** The user message that triggered this CC pass. Only `from_kind='user'`
   *  callers should invoke `ccMentionsFromUserMessage` — agent → agent
   *  mentions are intentionally not fanned out (per spec, agents not in
   *  the channel cannot see / reach into it). */
  message: MessageDto;
  /** Source conversation the message was posted in. */
  sourceConversation: ConversationDto;
  /** Source workspace for context surfacing. */
  sourceWorkspace: WorkspaceDto;
  /** What the message addresses, derived ONCE at the send boundary
   *  (#task:2000, Cindy round-2 MUST FIX 1). Required rather than re-derived
   *  from `message.content` here: a second parse of the same immutable body
   *  would pay the same cost twice and split the definition across two call
   *  sites. */
  references: readonly Reference[];
  agents: MentionCcAgentReadPort;
  conversations: MentionCcConversationPort;
  /**
   * The roster half of the membership UnitOfWork. The three placement rows below
   * are ONE atomic unit, and they belong to two different subjects, so they
   * coordinate on the workspace rather than on a member (#task:1987).
   */
  roster: WorkspaceRosterUnitOfWork;
  reads: MentionCcReadCursorPort;
  messages: MentionCcMessageWritePort;
  notifications: MentionCcNotificationWritePort;
  unread: ConversationViewerUnreadPublishPort;
  runtimeHost: AgentRuntimeHost;
  logger: BackendLogger;
  /** Event bus for WS push — publishes a viewer-scoped notification
   *  frame after insert. */
  events: ScopeEventBus;
}

const MENTIONS_CHANNEL_TITLE = 'Mentions';
const EXCERPT_LIMIT = 160;

/**
 * Fan a user-authored message out to the DM channels of any
 * referenced agents that aren't members of the source conversation.
 *
 * Side effects per delivered mention:
 *  - Lazily creates a `Mentions` DM channel for the recipient
 *    (idempotent — re-uses an existing one).
 *  - Grants the agent-home DM admission / ACL repair (#task:1989): the
 *    recipient agent's edge, the author's edge, and the author's
 *    agent-home workspace row — all idempotent. The workspace row is the
 *    only one that carries a governance role, fixed at plain `member`;
 *    the two conversation edges are role-less ACL edges
 *    (a mention is DM admission, not a workspace invitation).
 *  - Inserts a wrapped system message in the Mentions conversation.
 *  - Auto-starts the agent if not running, then delivers the wrapped
 *    message to its inbox / stdin.
 *  - Inserts a `mention_external` notification row scoped to the
 *    recipient's DM scope.
 *  - Publishes a realtime event for the Mentions conversation.
 *
 * Logged and skipped when:
 *  - mention handle doesn't resolve to an agent
 *  - the agent IS a member of the source conversation (they got the
 *    original — no DM duplicate needed)
 *  - the agent has no DM channel (legacy agents from before
 *    auto-DM provisioning); a warn is logged
 *
 * Throws are swallowed per-mention (and logged) so one bad recipient
 * doesn't fail the user's message send.
 */
export async function ccMentionsFromUserMessage(opts: MentionCcOpts): Promise<void> {
  // #task:2000: only canonical agent references CC. A `silverhand://human/x`
  // reference addresses a person, and a person has no DM channel to fan out to;
  // the plain `@handle` alias addresses nobody at all.
  const handles = opts.references
    .filter(ref => ref.kind === 'agent')
    .map(ref => ref.handle);
  if (handles.length === 0) return;

  // Pre-resolve conversation membership so we don't query per-handle.
  const sourceMembers = new Set(
    opts.conversations.listAgentIds(opts.sourceConversation.id),
  );

  for (const handle of handles) {
    try {
      await deliverOne(handle, sourceMembers, opts);
    } catch (err) {
      opts.logger.warn(
        {
          handle,
          sourceConversationId: opts.sourceConversation.id,
          sourceMessageId: opts.message.id,
          err,
        },
        'mention-cc: delivery failed for one recipient; continuing',
      );
    }
  }
}

async function deliverOne(
  handle: string,
  sourceMembers: Set<string>,
  opts: MentionCcOpts,
): Promise<void> {
  const agent = opts.agents.getByName(handle);
  if (!agent) {
    opts.logger.info(
      {
        event: 'mention_cc.skip',
        reason: 'unknown_handle',
        handle,
        sourceConversationId: opts.sourceConversation.id,
        sourceMessageId: opts.message.id,
      },
      'mention-cc: skipping unknown handle',
    );
    return; // unknown handle, just text
  }

  // Already a conversation member → they received the original directly.
  if (sourceMembers.has(agent.id)) {
    opts.logger.info(
      {
        event: 'mention_cc.skip',
        reason: 'already_member',
        handle,
        agentId: agent.id,
        sourceConversationId: opts.sourceConversation.id,
        sourceMessageId: opts.message.id,
      },
      'mention-cc: mentioned agent is already a source conversation member; skipping DM copy',
    );
    return;
  }

  const dm = opts.conversations.findDmChannelForAgent(agent.id);
  if (!dm) {
    opts.logger.warn(
      {
        event: 'mention_cc.skip',
        reason: 'missing_agent_dm',
        handle,
        agentId: agent.id,
        sourceConversationId: opts.sourceConversation.id,
        sourceMessageId: opts.message.id,
      },
      'mention-cc: mentioned agent has no DM channel; skipping',
    );
    return;
  }

  const mentions = getOrCreateMentionsConversation(
    dm,
    agent.id,
    opts.conversations,
  );
  const mentionsConversation = mentions.conversation;

  // agent-home DM admission / ACL repair (#task:1989): the original message
  // author must be a member of the Mentions conversation, otherwise the
  // permission gates won't let them GET /messages on a DM that is literally
  // about their own @-mention. This is NOT a workspace invitation: it grants
  // no regular-workspace membership, governance role, or agent capability —
  // only the scaffolding that DM needs. Because there is no durable deny
  // state, an absent row means "never provisioned / needs repair", not
  // "revoked", so a later mention rebuilds it idempotently. Resolution order:
  //   1. The triggering user message's `from_user_id`.
  //   2. Legacy null user id → source conversation's sole human member.
  //   3. No unique answer → log+skip membership writes (do NOT insert
  //      empty or guessed membership rows).
  // We also defensively add the agent_home workspace admission
  // — pre-v25 agents are backfilled by the migration, post-v25
  // agents created via createAgentWithHome get the creator added,
  // but a multi-human v2 may have agents whose home was never
  // explicitly joined by this particular human.
  const humanMemberId =
    opts.message.from_user_id
    ?? opts.conversations.singleViewerUserId(opts.sourceConversation.id);
  if (!humanMemberId) {
    opts.logger.warn(
      {
        event: 'mention_cc.skip_user_membership',
        reason: 'unresolved_human_member',
        handle,
        agentId: agent.id,
        sourceConversationId: opts.sourceConversation.id,
        sourceMessageId: opts.message.id,
      },
      'mention-cc: no unique human member id available for legacy null author; skipping user membership writes',
    );
  }

  // ONE transaction for the placement (#task:1987). All three rows are idempotent
  // on their own, which is exactly why they used to be written bare — and why
  // that was wrong: they are not independent. The agent's edge makes the DM
  // deliverable, the human's edge makes it readable, and the human's workspace
  // row is what the permission gates read before either. A failure between them
  // leaves a state no serial order produces: a conversation edge for a workspace
  // non-member, or a Mentions DM the mention's own author cannot open. They also
  // belong to TWO subjects, so the coordination axis is the workspace, not a
  // member — and it is the workspace the Mentions conversation lives in, which is
  // the agent's home, not the source workspace.
  //
  // Together the three rows ARE the agent-home DM admission (#task:1989): the
  // workspace row admits the author into the home, the human edge makes this
  // specific Mentions DM readable, the agent edge makes it deliverable. Only
  // the workspace row carries a governance role, fixed at plain `member` — the
  // roster scope has no face that grants governance — and the two conversation
  // edges are role-less ACL edges. So a repair run on a later mention can only
  // heal the scaffolding, never escalate it.
  //
  // `humanMembershipCreated` comes back from the port's in-lock `created`: it
  // gates a `workspace_channels_changed` fan-out below, and an exactly-once
  // effect may not hang off a read taken before the lock.
  const humanMembershipCreated = opts.roster.atomicallyForWorkspace(
    mentionsConversation.workspace_id,
    tx => {
      tx.roster.addConversationMember(mentionsConversation.id, {
        kind: 'agent',
        id: agent.id,
      });
      if (!humanMemberId) return false;
      const human = tx.roster.addConversationMember(mentionsConversation.id, {
        kind: 'human',
        id: humanMemberId,
      });
      // Plain `member`, idempotent — safe to re-run on every mention.
      tx.roster.addWorkspaceHumanMembership(humanMemberId);
      return human.created;
    },
  );

  const wrapped = opts.messages.insertSystemMessage({
    conversationId: mentionsConversation.id,
    content: renderMentionWrap(agent, opts),
    metadata: {
      subtype: systemSubtype('mention_cc'),
      source_workspace_id: opts.sourceWorkspace.id,
      source_workspace_name: opts.sourceWorkspace.name,
      source_conversation_id: opts.sourceConversation.id,
      source_conversation_title: opts.sourceConversation.title,
      source_message_id: opts.message.id,
      source_from_kind: opts.message.from_kind,
      source_from_user_id: opts.message.from_user_id,
      // Mirror the original content so the UI can render a compact
      // card without re-fetching. The wrapped `content` field stays
      // verbose for the agent's benefit (see renderMentionWrap).
      source_message_content: opts.message.content,
    },
  });

  if (humanMemberId) {
    opts.notifications.insertMentionExternal({
      userId: humanMemberId,
      agentId: agent.id,
      workspaceId: mentionsConversation.workspace_id,
      conversationId: mentionsConversation.id,
      messageId: wrapped.id,
      sourceWorkspaceId: opts.sourceWorkspace.id,
      sourceConversationId: opts.sourceConversation.id,
      sourceMessageId: opts.message.id,
      payload: {
        source_workspace_name: opts.sourceWorkspace.name,
        source_conversation_title: opts.sourceConversation.title,
        mention_excerpt: excerpt(opts.message.content),
      },
    });
  } else {
    opts.logger.warn(
      {
        event: 'mention_cc.skip_notification',
        reason: 'unresolved_human_member',
        handle,
        agentId: agent.id,
        conversationId: mentionsConversation.id,
        sourceConversationId: opts.sourceConversation.id,
        sourceMessageId: opts.message.id,
        wrappedMessageId: wrapped.id,
      },
      'mention-cc: no human member id available; skipping viewer notification insert',
    );
  }

  if (humanMemberId && (mentions.created || humanMembershipCreated)) {
    opts.events.publishToScope(
      `workspace:${mentionsConversation.workspace_id}`,
      'workspace_channels_changed',
      {
        workspace_id: mentionsConversation.workspace_id,
        channel_id: mentionsConversation.id,
      },
    );
  }
  opts.events.publish(mentionsConversation.id, {
    kind: 'message',
    payload: { message: wrapped },
  });
  if (
    humanMemberId
    && opts.reads.lastReadSeq(
      humanMemberId,
      mentionsConversation.id,
      wrapped.thread_root_id ?? null,
    ) < wrapped.seq
  ) {
    // The `Mentions` DM lives in an `agent_home` workspace, so it carries no
    // channel tier and no workspace suppressor — its badge IS its positional
    // unread (#task:1870). Emitted through the co-emitting seam anyway: the
    // frame pair is one fact, and the DM's own badge still has to move.
    opts.unread.publishUnreadUpdatedToViewer(
      mentionsConversation.id,
      mentionsConversation.workspace_id,
      humanMemberId,
    );
  }
  if (humanMemberId) {
    opts.events.publishToScope(`viewer:${humanMemberId}`, 'notification', {
      kind: 'mention_external',
      conversation_id: mentionsConversation.id,
      message_id: wrapped.id,
    });
  }

  // Fire-and-forget start; deliverMessage tolerates "not yet running"
  // by enqueueing to the inbox, so we don't need to await ordering.
  opts.runtimeHost
    .start(mentionsConversation.id, agent.id)
    .catch(err =>
      opts.logger.warn(
        { conversationId: mentionsConversation.id, agentId: agent.id, err },
        'mention-cc: auto-start failed (will still inbox-deliver)',
      ),
    );
  await opts.runtimeHost.deliverMessage(mentionsConversation.id, agent.id, wrapped.id);
}

/**
 * Find the agent's `Mentions` DM conversation, or create one if absent.
 * Title-based lookup keeps the schema unchanged. Single-process writes
 * + WAL means no race here in practice; if two concurrent mentions to
 * the same DM both miss the lookup, the second insert just creates a second
 * conversation with the same title — annoying but not broken (the
 * lookup picks the oldest going forward via ORDER BY created_at ASC).
 */
function getOrCreateMentionsConversation(
  dm: DmChannelDto,
  agentId: string,
  conversations: MentionCcConversationPort,
): { conversation: DmChannelDto; created: boolean } {
  const existing = conversations.findDmChannelForAgent(
    agentId,
    { title: MENTIONS_CHANNEL_TITLE },
  );
  if (existing) return { conversation: existing, created: false };
  return {
    conversation: conversations.insertDmChannel({
      workspaceId: dm.workspace_id,
      title: MENTIONS_CHANNEL_TITLE,
      agentId,
    }),
    created: true,
  };
}

function renderMentionWrap(agent: { name: string }, opts: MentionCcOpts): string {
  // Imperative — the platform prompt tells agents to ignore informational
  // system messages, so we explicitly ask for a decision. Tool names and
  // the "system-triggered" disclaimer are NOT spelled out here; the
  // platform prompt covers send_message mechanics and the from_kind=system
  // framing, and surfacing them again leaks impl into the chat UI.
  // Both interpolated values are free text: the workspace name is a label
  // (#task:1827, no `#` sigil — that spells a channel reference) and a channel
  // title has always been freeform. Since this body reaches the agent verbatim
  // on stdin, each goes in a code span so a label cannot fabricate Markdown
  // structure or a reference destination out of the label.
  //
  // The recipient is named with a canonical reference (#task:2000): this body is
  // server-authored, so it models the one form the prompt teaches instead of the
  // legacy alias. The quoted original below is a blockquote, which is precisely
  // why re-stating its references cannot re-deliver them.
  return [
    `The user mentioned you (${formatReferenceToken({ kind: 'agent', handle: agent.name })}) in ${inlineCode(opts.sourceWorkspace.name)} · ${inlineCode(opts.sourceConversation.title)}.`,
    `You're not a member of that channel — you can't see or reply there directly.`,
    ``,
    `Original message:`,
    blockquote(opts.message.content),
    ``,
    `Decide if this needs your attention. If yes, reply here in this DM and the user will see it; if not, just stop.`,
  ].join('\n');
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;
  return flat.slice(0, EXCERPT_LIMIT - 1) + '…';
}
