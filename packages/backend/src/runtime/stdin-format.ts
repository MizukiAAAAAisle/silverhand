/**
 * Stdin-message formatters used by every (conv, agent) delivery path —
 * live wakes, inbox drain at spawn, gated/combined batches, and the
 * soft-stop directive. Lifted out of the (now-removed)
 * `conversation-manager.ts` during the daemon cutover so both runtime
 * paths used byte-identical wire format. The legacy CM runtime was
 * deleted in #task:512 cleanup Commit B; these formatters are now the
 * single source of truth for stdin encoding and are consumed only by
 * `DaemonAgentRuntimeHost`.
 *
 * # What's NOT here
 *
 * - prompt hydration / spawn-prep — daemon-host-owned D2.g boundary.
 * - `sanitizeParsedEventForBroadcast` — its own module (`event-sanitize.ts`).
 *
 * # Surface
 *
 * `MessageLite` is the minimum projection both `MessageRepo` DTOs and
 * `ConversationInboxRepo`'s joined rows satisfy. Every formatter takes
 * either a single `MessageLite` (live path) or a list (inbox-drain
 * path), plus the name-resolver callbacks the formatters call to turn
 * agent/user ids into `@<handle>` text.
 */
import { extractMentions } from '@silverhand/shared';
import type { AttachmentSnapshot, FromKind } from '@silverhand/shared';
import type { PendingConversationInboxItem } from '../repos/conversation-inbox-repo.js';
import {
  extractAttachmentSnapshotsFromRow,
  extractSubtypeFromRow,
} from '../repos/message-repo.js';

/** The CLI tool name an agent should call to reply. */
export function sendMessageToolName(): string {
  return 'silverhand message send';
}

/** Minimal projection both InboxRepo's joined rows and MessageRepo
 *  DTOs satisfy — the formatters need these fields plus the metadata
 *  the canonical stdin header carries. */
export interface MessageLite {
  id: string;
  thread_root_id: string | null;
  from_kind: FromKind;
  from_agent_id: string | null;
  from_user_id: string | null;
  content: string;
  created_at: number;
  subtype?: string | null;
  attachments?: AttachmentSnapshot[] | null;
}

/**
 * Format an inbox batch as one human-readable user message. Mirrors §3.1
 * "A 档" payload shape — gives the agent enough metadata to address each
 * sender appropriately. Order = enqueue order.
 */
export function formatInboxBatch(
  items: PendingConversationInboxItem[],
  agentNameById: (id: string) => string | undefined,
  userNameById: (id: string) => string | undefined,
  defaultUserHandle: string | undefined,
  recipientAgentName: string | undefined,
  sendMessageTool: string,
): string {
  const header =
    items.length === 1
      ? 'You have one message waiting since you were last active:'
      : `You have ${items.length} messages waiting since you were last active (oldest first):`;
  const body = items
    .map(({ message }) => {
      const meta = formatStdinMessageHeader(
        message,
        agentNameById,
        userNameById,
        defaultUserHandle,
      );
      const suffix = formatAttachmentSuffix(
        extractAttachmentSnapshotsFromRow(message),
      );
      return `${meta}\n${message.content}${suffix}`;
    })
    .join('\n\n---\n\n');
  return `${header}\n\n${body}\n\n${formatDeliveryInstruction(
    items.map(({ message }) => ({
      ...message,
      subtype: extractSubtypeFromRow(message),
    })),
    recipientAgentName,
    sendMessageTool,
  )}`;
}

/**
 * Single-line canonical meta header for a message delivered to an
 * agent's stdin (replaces the older two-segment form, #task:394).
 *
 * Format (fields in fixed order, no quoting; content body follows on
 * the next line):
 *
 *     msg_id=<full-id> sender=@<handle>|system type=agent|human|system target=channel|thread:<root-id> time=<ISO8601>
 *
 * - `sender` is the canonical mention handle (`@<agent.name>` /
 *   `@<user.name>`) so an agent can reply with `@<handle>` directly.
 *   For pre-PR-A null-author rows or a row whose `from_user_id` is
 *   unknown, callers may provide a conversation-scoped fallback user
 *   handle; otherwise this degrades to the bare token `user`. System
 *   messages emit `sender=system` with no `@`.
 * - `type` is the surface vocabulary: DB column `from_kind='user'`
 *   maps to `human` here; agent and system pass through.
 * - `target` names the stream this message belongs to: `channel` for
 *   main-line messages, or `thread:<root-id>` for a reply cluster.
 *   The message's own `msg_id` remains the relation handle agents pass
 *   to `silverhand message send --reply-to` to answer in the same thread.
 * - `time` is ISO 8601 in the local timezone (offset preserved) so
 *   the agent sees both an absolute instant and the wall clock the
 *   user experienced.
 */
export function formatStdinMessageHeader(
  msg: MessageLite,
  agentNameById: (id: string) => string | undefined,
  userNameById: (id: string) => string | undefined,
  defaultUserHandle: string | undefined,
): string {
  const time = formatStdinTimestamp(msg.created_at);
  const target = msg.thread_root_id
    ? `thread:${msg.thread_root_id}`
    : 'channel';
  switch (msg.from_kind) {
    case 'agent': {
      const handle = msg.from_agent_id
        ? agentNameById(msg.from_agent_id)
        : undefined;
      const sender = handle ? `@${handle}` : 'agent';
      return `msg_id=${msg.id} sender=${sender} type=agent target=${target} time=${time}`;
    }
    case 'user': {
      const resolved = msg.from_user_id
        ? userNameById(msg.from_user_id) ?? defaultUserHandle
        : defaultUserHandle;
      const sender = resolved ? `@${resolved}` : 'user';
      return `msg_id=${msg.id} sender=${sender} type=human target=${target} time=${time}`;
    }
    case 'system': {
      return `msg_id=${msg.id} sender=system type=system target=${target} time=${time}`;
    }
  }
}

/**
 * ISO 8601 with local timezone offset (e.g. `2026-05-18T15:42:30+08:00`).
 * Keeps the agent's view of "when did this happen" honest about both
 * the absolute instant and the wall clock the human experienced —
 * UTC-only would lose the latter, and bare local time would lose the
 * former.
 */
export function formatStdinTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offAbs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(offAbs / 60))}:${pad(offAbs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    offset
  );
}

/** Single-message live-wake form: one message addressed at one
 *  recipient agent, optionally @-mentioning them. */
export function formatLiveMessage(
  message: MessageLite,
  agentNameById: (id: string) => string | undefined,
  userNameById: (id: string) => string | undefined,
  defaultUserHandle: string | undefined,
  recipientAgentName: string | undefined,
  sendMessageTool: string,
): string {
  const meta = formatStdinMessageHeader(
    message,
    agentNameById,
    userNameById,
    defaultUserHandle,
  );
  const suffix = formatAttachmentSuffix(message.attachments);
  return `New message:\n${meta}\n${message.content}${suffix}\n\n${formatDeliveryInstruction(
    [message],
    recipientAgentName,
    sendMessageTool,
  )}`;
}

/** Render attachments as a short, deterministic suffix the agent can
 *  parse. Keep this format stable: it's what every delivery path
 *  (live, inbox, gated) appends, and it's the only signal an agent
 *  has that files are attached to a message. */
export function formatAttachmentSuffix(
  attachments: AttachmentSnapshot[] | null | undefined,
): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map(
    a =>
      `  - id=${a.id} filename=${JSON.stringify(a.filename)} ` +
      `size=${a.size} content_type=${a.content_type}`,
  );
  const header =
    attachments.length === 1
      ? '[1 attachment — use `silverhand file view --attachment-id <id>` with the id below to read it]'
      : `[${attachments.length} attachments — use \`silverhand file view --attachment-id <id>\` with each id below to read them]`;
  return `\n\n${header}\n${lines.join('\n')}`;
}

/** When multiple gated deliveries pile up between safe boundaries, we
 *  flush as one combined user message so claude sees them in order. */
export function combineGatedBatch(
  messages: readonly string[],
  sendMessageTool: string,
): string {
  return (
    `You have ${messages.length} new messages that arrived while you were busy ` +
    `(oldest first):\n\n${messages.join('\n\n---\n\n')}\n\n` +
    `Review all messages above. If any user message or direct mention expects ` +
    `a visible response, call \`${sendMessageTool}\` before stopping. ` +
    `Complete ALL your work before stopping.`
  );
}

/** Append a directive line at the end of the stdin payload that tells
 *  the agent what kind of reply is expected. The directive varies by
 *  whether the batch includes a user-authored message addressed at the
 *  recipient, only references them by mention, or is system-only. */
export function formatDeliveryInstruction(
  messages: MessageLite[],
  recipientAgentName: string | undefined,
  sendMessageTool: string,
): string {
  const nonSystemMentionsRecipient =
    recipientAgentName !== undefined &&
    messages.some(
      m =>
        m.from_kind !== 'system' &&
        extractMentions(m.content).includes(recipientAgentName),
    );
  const userMessages = messages.filter(m => m.from_kind === 'user');
  const hasUserMessage = userMessages.length > 0;
  const hasUserMessageForRecipient = userMessages.some(m => {
    const mentions = extractMentions(m.content);
    return (
      mentions.length === 0 ||
      (recipientAgentName !== undefined && mentions.includes(recipientAgentName))
    );
  });
  const hasOnlySystemMessages = messages.every(m => m.from_kind === 'system');

  if (hasUserMessage && hasUserMessageForRecipient) {
    const mentionHint = nonSystemMentionsRecipient
      ? 'user addressed you by name.\n'
      : '';
    return (
      mentionHint +
      `Respond as appropriate — call \`${sendMessageTool}\` with a brief reply, ` +
      `progress update, blocker question, or final summary before stopping. ` +
      `Complete ALL your work before stopping.`
    );
  }

  if (hasUserMessage) {
    return (
      `The user message appears addressed to another agent. Do not call ` +
      `\`${sendMessageTool}\` unless you own or were assigned the relevant ` +
      `task, or must flag a concrete blocker. Complete ALL work you choose ` +
      `to take before stopping.`
    );
  }

  if (nonSystemMentionsRecipient) {
    return (
      `sender addressed you by name.\n` +
      `Respond as appropriate — call \`${sendMessageTool}\` before stopping. ` +
      `Complete ALL your work before stopping.`
    );
  }

  if (hasOnlySystemMessages) {
    return (
      `Respond as appropriate. System messages do not require a reply ` +
      `unless they explicitly ask for one.`
    );
  }

  return 'Respond as appropriate.';
}

/** PendingConversationInboxItem already carries the raw MessageRow
 *  shape (string `metadata` column). We extract attachments through
 *  the JSON parser, mirroring CM behavior. */
