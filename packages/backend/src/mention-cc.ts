import { extractMentions } from '@silverhand/shared';
import type { AgentDto, ChannelDto, MessageDto, SessionDto } from '@silverhand/shared';
import type { AgentRepo } from './repos/agent-repo.js';
import type { ChannelRepo } from './repos/channel-repo.js';
import type { MessageRepo } from './repos/message-repo.js';
import type { NotificationRepo } from './repos/notification-repo.js';
import type { SessionRepo } from './repos/session-repo.js';
import type { SessionManager } from './session-manager.js';
import type { BackendLogger } from './context.js';

export interface MentionCcOpts {
  /** The user message that triggered this CC pass. Only `from_kind='user'`
   *  callers should invoke `ccMentionsFromUserMessage` — agent → agent
   *  mentions are intentionally not fanned out (per spec, agents not in
   *  the channel cannot see / reach into it). */
  message: MessageDto;
  /** Source session the message was posted in. */
  sourceSession: SessionDto;
  /** Source channel for context surfacing (channel name in the wrap). */
  sourceChannel: ChannelDto;
  agents: AgentRepo;
  channels: ChannelRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
  notifications: NotificationRepo;
  sessionManager: SessionManager;
  logger: BackendLogger;
}

const MENTIONS_SESSION_TITLE = 'Mentions';
const EXCERPT_LIMIT = 160;

/**
 * Fan a user-authored message out to the DM channels of any
 * @-mentioned agents that aren't members of the source session.
 *
 * Side effects per delivered mention:
 *  - Lazily creates a `Mentions` session in the recipient's DM channel
 *    (idempotent — re-uses an existing one).
 *  - Adds the agent as a member of that session (also idempotent).
 *  - Inserts a wrapped system message in the Mentions session.
 *  - Auto-starts the agent if not running, then delivers the wrapped
 *    message to its inbox / stdin.
 *  - Inserts a `mention_external` notification row scoped to the
 *    recipient's DM channel.
 *  - Publishes an SSE event for the Mentions session.
 *
 * Skipped silently when:
 *  - mention handle doesn't resolve to an agent
 *  - the agent IS a member of the source session (they got the
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

  // Pre-resolve session membership so we don't query per-handle.
  const sourceMembers = new Set(
    opts.sessions.listAgents(opts.sourceSession.id).map(sa => sa.agent_id),
  );

  for (const handle of handles) {
    try {
      await deliverOne(handle, sourceMembers, opts);
    } catch (err) {
      opts.logger.warn(
        {
          handle,
          sourceSessionId: opts.sourceSession.id,
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
  if (!agent) return; // unknown handle, just text

  // Already a session member → they received the original directly.
  if (sourceMembers.has(agent.id)) return;

  const dm = opts.channels.findDmByAgentId(agent.id);
  if (!dm) {
    opts.logger.warn(
      { handle, agentId: agent.id },
      'mention-cc: mentioned agent has no DM channel; skipping',
    );
    return;
  }

  const mentionsSession = getOrCreateMentionsSession(dm.id, opts.sessions);
  // Make sure the agent is a member of the Mentions session — addAgent
  // is INSERT OR IGNORE, so re-running is a no-op.
  opts.sessions.addAgent(mentionsSession.id, agent.id);

  const wrapped = opts.messages.insert({
    sessionId: mentionsSession.id,
    fromKind: 'system',
    content: renderMentionWrap(agent, opts),
    metadata: {
      subtype: 'mention_cc',
      source_channel_id: opts.sourceChannel.id,
      source_channel_name: opts.sourceChannel.name,
      source_session_id: opts.sourceSession.id,
      source_session_title: opts.sourceSession.title,
      source_message_id: opts.message.id,
      source_from_kind: opts.message.from_kind,
      source_from_user_id: opts.message.from_user_id,
      // Mirror the original content so the UI can render a compact
      // card without re-fetching. The wrapped `content` field stays
      // verbose for the agent's benefit (see renderMentionWrap).
      source_message_content: opts.message.content,
    },
  });

  // Fire-and-forget start; deliverMessage tolerates "not yet running"
  // by enqueueing to the inbox, so we don't need to await ordering.
  opts.sessionManager
    .start(mentionsSession.id, agent.id)
    .catch(err =>
      opts.logger.warn(
        { sessionId: mentionsSession.id, agentId: agent.id, err },
        'mention-cc: auto-start failed (will still inbox-deliver)',
      ),
    );
  await opts.sessionManager.deliverMessage(mentionsSession.id, agent.id, wrapped.id);

  opts.notifications.insert({
    kind: 'mention_external',
    // v1 single-user; multi-user migration will backfill 'local'.
    userId: null,
    agentId: agent.id,
    channelId: dm.id,
    sessionId: mentionsSession.id,
    messageId: wrapped.id,
    sourceChannelId: opts.sourceChannel.id,
    sourceSessionId: opts.sourceSession.id,
    sourceMessageId: opts.message.id,
    payload: {
      source_channel_name: opts.sourceChannel.name,
      source_session_title: opts.sourceSession.title,
      mention_excerpt: excerpt(opts.message.content),
    },
  });
}

/**
 * Find the channel's `Mentions` session, or create one if absent.
 * Title-based lookup keeps the schema unchanged. Single-process writes
 * + WAL means no race here in practice; if two concurrent mentions to
 * the same DM both miss the lookup, the second insert just creates a
 * second session with the same title — annoying but not broken (the
 * lookup picks the oldest going forward via ORDER BY created_at ASC).
 */
function getOrCreateMentionsSession(
  dmChannelId: string,
  sessions: SessionRepo,
): SessionDto {
  const existing = sessions
    .listForChannel(dmChannelId)
    .filter(s => s.parent_session_id === null && s.title === MENTIONS_SESSION_TITLE);
  if (existing.length > 0) return existing[0]!;
  return sessions.insert({ channelId: dmChannelId, title: MENTIONS_SESSION_TITLE });
}

function renderMentionWrap(agent: { name: string }, opts: MentionCcOpts): string {
  // Imperative — the platform prompt tells agents to ignore informational
  // system messages, so we explicitly ask for a decision. Tool names and
  // the "system-triggered" disclaimer are NOT spelled out here; the
  // platform prompt covers send_message mechanics and the from_kind=system
  // framing, and surfacing them again leaks impl into the chat UI.
  return [
    `The user @-mentioned you (@${agent.name}) in #${opts.sourceChannel.name} · ${opts.sourceSession.title}.`,
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
