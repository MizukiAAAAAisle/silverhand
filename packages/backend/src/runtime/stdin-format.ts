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
import {
  composeRuntimeDeliveryPresentation,
  formatDeliveryTarget,
  requireAddressableId,
  resolveAttachmentLabels,
  type AttachmentSnapshot,
  type DeliveryTarget,
  type FromKind,
  type Reference,
  type RuntimeDeliveryInstructionSignal,
  type RuntimeDeliveryPresentation,
} from '@silverhand/shared';
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
  /** The stream this message belongs to, as the header's absolute `target`
   *  (#task:2021 P4-3). Carried by the MESSAGE rather than passed in per batch:
   *  the target is a fact about the row, and an agent-scoped runtime is woken for
   *  N conversations, so a per-call conversation parameter would mislabel every
   *  row of any batch that ever spans two of them. */
  conversation_id: string;
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
 * How a formatter obtains the addressing set of a message it is framing.
 *
 * A parameter rather than a call to the parser (#task:2000, shiki's option B):
 * the batch is re-framed per recipient while the addressing set is not
 * per-recipient, so the derivation belongs to the phase's one authority —
 * `runtime/reference-memo.ts`, which memoizes it under the immutability of
 * `messages.content`. Required, not defaulted: a default would let a caller
 * silently reintroduce the per-recipient parse this removed.
 *
 * Keyed by message id on the memo side, so the per-recipient re-projection
 * `formatInboxBatch` does below (a fresh object per framing) is irrelevant to
 * the hit.
 */
export type DeliveryReferencesOf = (
  message: MessageLite,
) => readonly Reference[];

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
  referencesOf: DeliveryReferencesOf,
): string {
  return formatInboxBatchPresentation(
    items,
    agentNameById,
    agentComputerIdById,
    userNameById,
    defaultUserHandle,
    recipientAgentName,
    sendMessageTool,
    referencesOf,
  ).text;
}

/** Return the canonical batch plus composable per-row presentation metadata. */
export function formatInboxBatchPresentation(
  items: readonly InboxBatchEntry[],
  agentNameById: (id: string) => string | undefined,
  agentComputerIdById: (id: string) => string | undefined,
  userNameById: (id: string) => string | undefined,
  defaultUserHandle: string | undefined,
  recipientAgentName: string | undefined,
  sendMessageTool: string,
  referencesOf: DeliveryReferencesOf,
): { text: string; presentations: readonly RuntimeDeliveryPresentation[] } {
  const presentations = items.map(({ message }) => {
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
    return {
      body: `${meta}\n${message.content}${suffix}`,
      instruction: deliveryInstructionSignal(
        {
          ...message,
          subtype: extractSubtypeFromRow(message),
        },
        recipientAgentName,
        referencesOf,
      ),
    } satisfies RuntimeDeliveryPresentation;
  });
  return {
    text: composeRuntimeDeliveryPresentation(presentations, sendMessageTool),
    presentations,
  };
}

/**
 * Classify one message for the shared batch-instruction authority.
 * Addressing is derived in this wake phase from the required memoized resolver;
 * an undirected user message addresses every recipient.
 */
function deliveryInstructionSignal(
  message: MessageLite,
  recipientAgentName: string | undefined,
  referencesOf: DeliveryReferencesOf,
): RuntimeDeliveryInstructionSignal {
  const references = referencesOf(message);
  const addressesRecipient =
    recipientAgentName !== undefined
    && references.some(
      ref => ref.kind === 'agent' && ref.handle === recipientAgentName,
    );
  if (message.from_kind === 'user') {
    return references.length === 0 || addressesRecipient
      ? 'user_for_recipient'
      : 'user_for_other';
  }
  if (message.from_kind !== 'system' && addressesRecipient) {
    return 'non_system_mention';
  }
  return message.from_kind === 'system' ? 'system' : 'other';
}

/**
 * The absolute address of the stream a message row belongs to — the one place a
 * `MessageLite` becomes a {@link DeliveryTarget}.
 *
 * `requireAddressableId` rather than a fail-closed check: both ids come from our
 * own store (`conversations.id` and a `messages.id` used as a thread root are
 * both `randomBytes(12).toString('base64url')`, i.e. exactly the addressable
 * domain), so an id that cannot be spelled is corruption, and a stream with no
 * address has no header token to fall back to. Omitting `target=` instead would
 * hand the reader back the ambient guess this slice exists to remove; throwing
 * names the coordinate that is broken.
 */
export function deliveryTargetOfMessage(msg: MessageLite): DeliveryTarget {
  return {
    conversationId: requireAddressableId(
      msg.conversation_id,
      'messages.conversation_id',
    ),
    threadRootId:
      msg.thread_root_id === null
        ? null
        : requireAddressableId(msg.thread_root_id, 'messages.thread_root_id'),
  };
}

/**
 * Single-line canonical meta header for a message delivered to an
 * agent's stdin (replaces the older two-segment form, #task:394).
 *
 * Format (fields in fixed order, no quoting; the whole envelope is wrapped
 * in `[...]` so it is visually distinct from the body, which follows on the
 * next line):
 *
 *     [msg_id=<full-id> sender=@<handle>|system type=agent|human|system computer=<host-id (agent rows only)> target=#conv:<conversation-id>[/thread:<root-id>] time=<ISO8601>]
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
 * - `target` is the ABSOLUTE address of the stream this message belongs
 *   to (#task:2021 P4-3), rendered by the one codec
 *   (`shared/delivery-target.ts`): `#conv:<conversation-id>` for the
 *   main line, with a `/thread:<root-id>` suffix inside a reply
 *   cluster. It replaced the relative token `channel`, which only
 *   meant anything while a runtime was pinned to exactly one
 *   conversation — an agent-scoped runtime serves N, so `channel`
 *   named whichever one the reader assumed. Being absolute, the token
 *   is the same for every reader — but it is not yet the `--target`
 *   flag's grammar: P4-3 changed what is emitted and taught, and
 *   canonical acceptance on every write surface is P4-4's, so an agent
 *   reads the token's parts (the root id, the bare conversation id)
 *   rather than pasting the whole thing. The message's own `msg_id`
 *   remains the relation handle agents pass to
 *   `silverhand message send --reply-to` to answer in the same thread.
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
  const target = formatDeliveryTarget(deliveryTargetOfMessage(msg));
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
