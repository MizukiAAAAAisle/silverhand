import { extractMentions, systemSubtype } from '@silverhand/shared';
import type { Database as Db } from 'better-sqlite3';
import type {
  ConversationDto,
  DmChannelDto,
  MessageDto,
  WorkspaceDto,
} from '@silverhand/shared';
import type { AgentRepo } from './repos/agent-repo.js';
import type { ConversationRepo } from './repos/conversation-repo.js';
import type { MessageRepo } from './repos/message-repo.js';
import type { NotificationRepo } from './repos/notification-repo.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import type { BackendLogger } from './context.js';
import type { ScopeEventBus } from './ws/scope-event-bus.js';
import {
  buildUnreadUpdatedMessagePayload,
  singleConversationViewerUserId,
} from './viewer-scope.js';
import { ConversationReadRepo } from './repos/conversation-read-repo.js';

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
  /** SQLite handle — used for membership writes around lazy Mentions DMs. */
  db: Db;
  agents: AgentRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  notifications: NotificationRepo;
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
 * @-mentioned agents that aren't members of the source conversation.
 *
 * Side effects per delivered mention:
 *  - Lazily creates a `Mentions` DM channel for the recipient
 *    (idempotent — re-uses an existing one).
 *  - Adds the agent as a member of that conversation (also idempotent).
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
  const handles = extractMentions(opts.message.content);
  if (handles.length === 0) return;

  // Pre-resolve conversation membership so we don't query per-handle.
  const sourceMembers = new Set(
    opts.conversations.listAgents(opts.sourceConversation.id).map(ca => ca.agent_id),
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
  // Make sure the agent is a member of the Mentions conversation — addAgent
  // is INSERT OR IGNORE, so re-running is a no-op.
  opts.conversations.addAgent(mentionsConversation.id, agent.id);

  // v25 human membership: the original message author must be a member
  // of the Mentions conversation, otherwise the v25 permission gates
  // won't let them GET /messages on a DM that is literally about their
  // own @-mention. Resolution order:
  //   1. The triggering user message's `from_user_id`.
  //   2. Legacy null user id → source conversation's sole human member.
  //   3. No unique answer → log+skip membership writes (do NOT insert
  //      empty or guessed membership rows).
  // We also defensively `addUserMember` on the agent_home workspace
  // — pre-v25 agents are backfilled by the migration, post-v25
  // agents created via createAgentWithHome get the creator added,
  // but a multi-human v2 may have agents whose home was never
  // explicitly joined by this particular human.
  const humanMemberId =
    opts.message.from_user_id
    ?? singleConversationViewerUserId(opts.conversations, opts.sourceConversation.id);
  let humanMembershipCreated = false;
  if (humanMemberId) {
    humanMembershipCreated =
      opts.conversations.getUser(mentionsConversation.id, humanMemberId) === null;
    opts.conversations.addUser(mentionsConversation.id, humanMemberId);
    // workspace_users is INSERT OR IGNORE — safe to re-run.
    opts.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users
           (workspace_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(mentionsConversation.workspace_id, humanMemberId, Date.now());
  } else {
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

  const wrapped = opts.messages.insertForConversation({
    conversationId: mentionsConversation.id,
    fromKind: 'system',
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
    opts.notifications.insert({
      kind: 'mention_external',
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
    && viewerHasNotReadMessage(
      opts.db,
      mentionsConversation.id,
      humanMemberId,
      wrapped.seq,
      wrapped.thread_root_id ?? null,
    )
  ) {
    opts.events.publishToScope(
      `viewer:${humanMemberId}`,
      'unread_updated',
      buildUnreadUpdatedMessagePayload(
        new ConversationReadRepo(opts.db),
        mentionsConversation.id,
        mentionsConversation.workspace_id,
        humanMemberId,
      ),
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
  conversations: ConversationRepo,
): { conversation: DmChannelDto; created: boolean } {
  const existing = conversations.findDmChannelForAgent(
    agentId,
    { title: MENTIONS_CHANNEL_TITLE },
  );
  if (existing) return { conversation: existing, created: false };
  return {
    conversation: conversations.insertDmChannel({
      workspaceId: dm.workspace_id,
      workspacePath: dm.workspace_path,
      title: MENTIONS_CHANNEL_TITLE,
      agentId,
    }),
    created: true,
  };
}

function viewerHasNotReadMessage(
  db: Db,
  conversationId: string,
  viewerUserId: string,
  messageSeq: number,
  threadRootId: string | null,
): boolean {
  // Per-stream cursor (#task:1226 §4.1): a (user, conversation) has many cursor
  // rows, so the lookup MUST be stream-qualified or it would pick an arbitrary
  // row. `IS ?` handles both the mainline (NULL) and a thread root id.
  const row = db
    .prepare<[string, string, string | null], { last_read_seq: number }>(
      `SELECT last_read_seq
         FROM conversation_reads
        WHERE user_id = ?
          AND conversation_id = ?
          AND thread_root_id IS ?`,
    )
    .get(viewerUserId, conversationId, threadRootId);
  return (row?.last_read_seq ?? 0) < messageSeq;
}

function renderMentionWrap(agent: { name: string }, opts: MentionCcOpts): string {
  // Imperative — the platform prompt tells agents to ignore informational
  // system messages, so we explicitly ask for a decision. Tool names and
  // the "system-triggered" disclaimer are NOT spelled out here; the
  // platform prompt covers send_message mechanics and the from_kind=system
  // framing, and surfacing them again leaks impl into the chat UI.
  return [
    `The user @-mentioned you (@${agent.name}) in #${opts.sourceWorkspace.name} · ${opts.sourceConversation.title}.`,
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
