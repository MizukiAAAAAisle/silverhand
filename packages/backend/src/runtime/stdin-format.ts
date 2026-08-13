/**
 * Stdin-message formatters used by every (conv, agent) delivery path —
 * live deliveries, inbox drain at spawn, and gated/combined batches.
 * Lifted out of the (now-removed)
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
import { resolveAttachmentLabels } from '@silverhand/shared';
import type { AttachmentSnapshot, FromKind } from '@silverhand/shared';
import {
  extractAttachmentSnapshotsFromRow,
  extractSubtypeFromRow,
  extractTaskHeaderFromRow,
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
  /** Raw message metadata (JSON string, as stored on `MessageRow`). The stdin
   *  header derives the `task=#<number> status=<status>` suffix from this when
   *  the row is a task system event (`task_create` / `task_claim` /
   *  `task_unclaim` / `task_status`) — so an agent woken by the event sees at a
   *  glance it's a task, not plain chat. Replaces the retired flat
   *  `messages.task_*` columns (v60: a task is a first-class aggregate; the
   *  header rides the event's immutable metadata snapshot). The title is
   *  intentionally NOT in the header — read it via `task list` / `task detail`. */
  metadata?: string | null;
}

/**
 * One entry of an inbox batch, as the formatter needs it: the stdin
 * projection plus a PRESENT (possibly null) `metadata` column — attachments,
 * the subtype and the `task=#<n>` header suffix are all parsed out of it, so
 * an entry that merely omitted the field would silently format without them.
 * Structural on purpose: the caller's delivery type is a persistence
 * projection, and this formatter must not depend on which one.
 */
export interface InboxBatchEntry {
  message: MessageLite & { metadata: string | null };
}

/**
 * Format an inbox batch as one human-readable user message. Mirrors §3.1
 * "A 档" payload shape — gives the agent enough metadata to address each
 * sender appropriately. Order = enqueue order.
 */
export function formatInboxBatch(
  items: readonly InboxBatchEntry[],
  agentNameById: (id: string) => string | undefined,
  agentComputerIdById: (id: string) => string | undefined,
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
        agentComputerIdById,
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
 * Format (fields in fixed order, no quoting; the whole envelope is wrapped
 * in `[...]` so it is visually distinct from the body, which follows on the
 * next line):
 *
 *     [msg_id=<full-id> sender=@<handle>|system type=agent|human|system computer=<host-id (agent rows only)> target=channel|thread:<root-id> time=<ISO8601>]
 *
 * - `sender` is the canonical mention handle (`@<agent.name>` /
 *   `@<user.name>`) so an agent can reply with `@<handle>` directly.
 *   For pre-PR-A null-author rows or a row whose `from_user_id` is
 *   unknown, callers may provide a conversation-scoped fallback user
 *   handle; otherwise this degrades to the bare token `user`. System
 *   messages emit `sender=system` with no `@`.
 * - `type` is the surface vocabulary: DB column `from_kind='user'`
 *   maps to `human` here; agent and system pass through.
 * - `computer` (#task:1600, `type=agent` only) is the sender agent's
 *   CURRENT `host_id`, resolved live at render time — never persisted
 *   on the message, so it always reflects where that agent runs NOW.
 *   Human/system rows carry no computer field, and an agent row whose
 *   sender can no longer be resolved simply omits it — there is no
 *   `computer=unknown` token, and a MISSING field must never be read
 *   as "same computer" (the prompt behavior contract says exactly
 *   this). Receivers compare it against their own Computer id to
 *   decide whether the sender shares this filesystem.
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
  agentComputerIdById: (id: string) => string | undefined,
  userNameById: (id: string) => string | undefined,
  defaultUserHandle: string | undefined,
): string {
  const time = formatStdinTimestamp(msg.created_at);
  const target = msg.thread_root_id
    ? `thread:${msg.thread_root_id}`
    : 'channel';
  // Task suffix — appended to every kind's header when the row is a task
  // system event, so an agent sees `task=#<n> status=<status>` regardless of
  // who sent it. Derived from the event's immutable metadata snapshot (v60:
  // a task is a first-class aggregate, not a message column). Machine-scannable;
  // no title (see MessageLite).
  const taskHeader = extractTaskHeaderFromRow({ metadata: msg.metadata ?? null });
  const taskSuffix = taskHeader
    ? ` task=#${taskHeader.task_number} status=${taskHeader.task_status}`
    : '';
  switch (msg.from_kind) {
    case 'agent': {
      const handle = msg.from_agent_id
        ? agentNameById(msg.from_agent_id)
        : undefined;
      const sender = handle ? `@${handle}` : 'agent';
      const computerId = msg.from_agent_id
        ? agentComputerIdById(msg.from_agent_id)
        : undefined;
      const computer = computerId ? ` computer=${computerId}` : '';
      return `[msg_id=${msg.id} sender=${sender} type=agent${computer} target=${target} time=${time}${taskSuffix}]`;
    }
    case 'user': {
      const resolved = msg.from_user_id
        ? userNameById(msg.from_user_id) ?? defaultUserHandle
        : defaultUserHandle;
      const sender = resolved ? `@${resolved}` : 'user';
      return `[msg_id=${msg.id} sender=${sender} type=human target=${target} time=${time}${taskSuffix}]`;
    }
    case 'system': {
      return `[msg_id=${msg.id} sender=system type=system target=${target} time=${time}${taskSuffix}]`;
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

/** Render attachments as a short, deterministic suffix the agent can
 *  parse. Keep this format stable: it's what every delivery path
 *  (live, inbox, gated) appends, and it's the only signal an agent
 *  has that files are attached to a message. */
export function formatAttachmentSuffix(
  attachments: AttachmentSnapshot[] | null | undefined,
): string {
  if (!attachments || attachments.length === 0) return '';
  const labels = resolveAttachmentLabels(attachments);
  const lines = attachments.map(
    (a, i) =>
      `  - ${labels[i]} — id=${a.id} filename=${JSON.stringify(a.filename)} ` +
      `content_type=${a.content_type} size=${a.size}`,
  );
  const header =
    attachments.length === 1
      ? '[1 attachment — the label (e.g. `Image #1`) is how the sender refers to it; use `silverhand file view --attachment-id <id>` with the id below to read it]'
      : `[${attachments.length} attachments — the label (e.g. \`Image #1\`) is how the sender refers to each; use \`silverhand file view --attachment-id <id>\` with each id below to read them]`;
  return `\n\n${header}\n${lines.join('\n')}`;
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
    return (
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
