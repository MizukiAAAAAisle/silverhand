// Mention CC — a user @-mentions an agent that is NOT a member of the
// conversation, so the message is copied into that agent's inbox
// (agent-scoped-session-v1 §4.2 / §5, #task:2014).
//
// What changed in v71, and why the shape of this module changed with it:
//
//  1. The destination is the agent's INBOX PLACEMENT, not a DM that borrows the
//     agent's home workspace. `tx.conversations.agentInbox` keys on the ownership
//     column, so there is no title lookup, no lazy creation and no
//     oldest-per-agent tie-break — the inbox is an invariant of the Agent
//     aggregate, created with it. A missing one is a broken aggregate and fails
//     LOUD ({@link AgentInboxMissingError}); it is not repaired here, because a
//     repair path is exactly what let two `Mentions` DMs exist.
//
//  2. The copy is written INSIDE THE SOURCE MESSAGE'S TRANSACTION (§5). It used
//     to be a post-commit `void ccMentionsBestEffort(...)`: a crash in the gap
//     lost the copy permanently, and the human was told nothing, while the
//     message they wrote was safely committed. Everything whose loss the domain
//     cannot tolerate is therefore in the transaction now — the copy, its durable
//     inbox delivery row, and the author's `mention_external` notification — and
//     `cc_source_message_id` (partial UNIQUE per inbox) makes a duplicate a
//     constraint failure rather than a second notification.
//
//  3. THE INBOX HAS NO HUMAN PARTICIPANT (§4.2). That deletes the
//     entire `#task:1989` admission block this module used to perform — the
//     author's conversation edge, the agent's edge, the author's home-workspace
//     row — along with the `workspace_channels_changed` fan-out and the viewer
//     unread publish that only made sense while a human could open the DM. The
//     human's read path is `mention_external`, which under the settled product
//     contract (shiki 2026-08-14, "option A") stays with the message's AUTHOR and
//     jumps to the SOURCE message they are already authorized to read.
//
// Split by the commit boundary, not by subject: `writeMentionCcCopies` decides
// and writes (transactional, no effects, no logging — a log emitted inside a
// transaction that later rolls back is a lie), then `dispatchMentionCcEffects`
// performs what cannot be committed: the runtime wake, the WS frames, and the
// skip log the decision half returned as data.
//
// A WAKE FAILURE IS NEVER A LOST MENTION, and there is exactly ONE arm saying so.
// v71 gave this module a second, typed arm for "the host refused the placement
// because the inbox has no session cwd"; #task:2019 landed the agent-scoped
// RuntimeScope, which made that refusal impossible, and #task:2021 P4-5 deleted
// it rather than keeping it as defensive contract — a failure
// shape only a test fake can construct reads to the next caller as a supported
// host semantics to mirror. Any throw from `start` now lands in the generic arm
// below: the copy and its durable inbox delivery row are already committed, so the
// next spawn drains them.
import { formatReferenceToken, inlineCode } from '@silverhand/shared';
import { systemSubtype } from '@silverhand/shared';
import type { ConversationDto, MessageDto, Reference } from '@silverhand/shared';
import type {
  AgentMessageDeliveryPort,
  AgentRuntimeStartPort,
} from '../runtime/agent-runtime-host.js';
import type { BackendLogger } from '../context.js';
import { AgentInboxMissingError } from './agent-provisioning-ports.js';
import type { MessageTxScope } from '../services/conversation-message/ports.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

/**
 * The transactional capability this write needs, as a SUBSET of the send's own
 * scope — not a parallel port bundle. Stated as a `Pick` so the list is
 * auditable and a widening shows up here: the CC write may resolve handles, read
 * the source roster, find an inbox, read the source workspace's name, insert the
 * copy, make it deliverable, and notify the author. Nothing else.
 */
export type MentionCcTxScope = Pick<
  MessageTxScope,
  'agents' | 'conversations' | 'workspaces' | 'messages' | 'inboxes' | 'notifications'
>;

export interface MentionCcInput {
  /** The just-inserted source message. Only a `from_kind='user'` send reaches
   *  here (`POLICIES.user.ccMentions`): an agent's mention of a non-member
   *  agent deliberately does NOT fan out — an agent cannot reach into a channel
   *  it was not put in. */
  message: MessageDto;
  /** The conversation the message was posted in. Workspace-placed by
   *  construction: a human is never a participant of a non-workspace placement
   *  (§4.2), so a user send cannot originate in one. Asserted, not assumed. */
  sourceConversation: ConversationDto;
  /** What the message addresses, derived ONCE at the send boundary (#task:2000).
   *  Required rather than re-parsed: a second parse of the same immutable body
   *  would split the definition of "who does this address" across two sites. */
  references: readonly Reference[];
}

/** One committed copy, and everything the post-commit half needs to finish it. */
export interface MentionCcCopy {
  agentId: string;
  agentHandle: string;
  inboxConversationId: string;
  wrapped: MessageDto;
  /** Viewer of the `mention_external` row = the source message's author. */
  notifiedUserId: string;
}

export type MentionCcSkipReason =
  /** The handle names no agent — it is just text. */
  | 'unknown_handle'
  /** The agent is a member of the source conversation: it received the original,
   *  so a copy would be a duplicate of a message it can already see and reply
   *  to. */
  | 'already_member'
  /** The same agent appears twice in the reference list. Not reachable from a
   *  user send today — `extractMessageReferences` dedupes by `(kind, handle)`
   *  and handles are unique — so this guards the DECLARED input of this
   *  function rather than user input: without it a duplicated list would hit
   *  the partial UNIQUE and kill the human's send with a constraint error
   *  instead of copying once. */
  | 'duplicate_reference'
  /** The source message carries no author id (legacy rows only). Option A has no
   *  viewer without one, and a guessed viewer would send someone else's mention
   *  notification to whoever happens to be the sole human. */
  | 'unresolved_author'
  /**
   * The SOURCE conversation is not workspace-placed — a `direct_pair` (a DM).
   * Reachable since P4-4 opened the write gate for the human endpoint of a DM,
   * and #task:2021 P4-5 makes such a send actually deliver.
   *
   * A SKIP rather than the `throw` this used to be: the copy's wrap text and its
   * `mention_external` row are both keyed by the source WORKSPACE (name in the
   * body, id in the notification), so a DM source has no coordinate to write one
   * with — and throwing rolled the human's committed-and-gated DM send back with a
   * 500 for the crime of naming a third agent in it. Skipping is not "silently
   * dropping a mention": the reference still addresses whoever it addresses IN the
   * DM, and this decision is reported in the CC report and logged after commit.
   *
   * DM-sourced CC — a workspace-less wrap plus a notification whose coordinate is
   * the DM — is a product change with its own read surfaces, filed separately.
   */
  | 'source_not_workspace_placed';

export interface MentionCcSkip {
  handle: string;
  reason: MentionCcSkipReason;
  agentId?: string;
}

export interface MentionCcReport {
  copies: MentionCcCopy[];
  skipped: MentionCcSkip[];
  /** Echoed for the post-commit log/effects so the dispatcher needs no second
   *  read of the source. */
  source: { conversationId: string; messageId: string };
}

const EXCERPT_LIMIT = 160;

/**
 * Decide and WRITE the mention CC copies. Runs inside the send transaction, so
 * every return path is either "copied" or "explicitly skipped" — there is no
 * best-effort arm: a failure here rolls the whole send back, which is the point
 * (§5). A skip is a DOMAIN decision and is returned as data; the caller logs it
 * after commit.
 */
export function writeMentionCcCopies(
  tx: MentionCcTxScope,
  input: MentionCcInput,
): MentionCcReport {
  const report: MentionCcReport = {
    copies: [],
    skipped: [],
    source: {
      conversationId: input.sourceConversation.id,
      messageId: input.message.id,
    },
  };
  // #task:2000: only canonical agent references CC. A `silverhand://human/x`
  // reference addresses a person, who has no inbox to copy into, and the plain
  // `@handle` alias addresses nobody at all.
  const handles = input.references
    .filter(ref => ref.kind === 'agent')
    .map(ref => ref.handle);
  if (handles.length === 0) return report;

  const sourceWorkspaceId = input.sourceConversation.workspace_id;
  if (sourceWorkspaceId === null) {
    // A DM source: no workspace coordinate to name the copy after. Reported per
    // handle so the post-commit log says which mentions were not copied — see
    // `source_not_workspace_placed`.
    for (const handle of handles) {
      report.skipped.push({ handle, reason: 'source_not_workspace_placed' });
    }
    return report;
  }
  const sourceWorkspaceName = tx.workspaces.nameOf(sourceWorkspaceId);
  if (sourceWorkspaceName === null) {
    throw new Error(
      `mention cc: workspace ${sourceWorkspaceId} not found for conversation `
        + `${input.sourceConversation.id}`,
    );
  }

  const copiedTo = new Set<string>();

  for (const handle of handles) {
    const agent = tx.agents.getByName(handle);
    if (!agent) {
      report.skipped.push({ handle, reason: 'unknown_handle' });
      continue;
    }
    // PARTICIPATION, not a roster listing (#task:2021 P4-5): the question is
    // "did this agent already receive the original", which is exactly who the
    // placement says participates. Identical for the workspace arm — its
    // participants ARE its roster rows — and it is the only form that stays true
    // if a non-workspace source ever gains a CC.
    if (tx.conversations.isAgentParticipant(input.sourceConversation.id, agent.id)) {
      report.skipped.push({ handle, reason: 'already_member', agentId: agent.id });
      continue;
    }
    if (copiedTo.has(agent.id)) {
      report.skipped.push({
        handle,
        reason: 'duplicate_reference',
        agentId: agent.id,
      });
      continue;
    }
    const authorUserId = input.message.from_user_id;
    if (authorUserId === null) {
      report.skipped.push({
        handle,
        reason: 'unresolved_author',
        agentId: agent.id,
      });
      continue;
    }
    const inbox = tx.conversations.agentInbox(agent.id);
    if (!inbox) throw new AgentInboxMissingError(agent.id);

    const wrapped = tx.messages.insertForConversation({
      conversationId: inbox.id,
      fromKind: 'system',
      content: renderMentionWrap({
        agentHandle: agent.name,
        sourceWorkspaceName,
        sourceConversationTitle: input.sourceConversation.title,
        sourceContent: input.message.content,
      }),
      metadata: {
        subtype: systemSubtype('mention_cc'),
        source_workspace_id: sourceWorkspaceId,
        source_workspace_name: sourceWorkspaceName,
        source_conversation_id: input.sourceConversation.id,
        source_conversation_title: input.sourceConversation.title,
        source_message_id: input.message.id,
        source_from_kind: input.message.from_kind,
        source_from_user_id: input.message.from_user_id,
        // Mirror the original body so a reader can render a compact card
        // without a cross-conversation fetch it may not be authorized to make.
        source_message_content: input.message.content,
      },
      ccSourceMessageId: input.message.id,
    });
    // The DURABLE half of delivery, committed with the copy: "this agent owes
    // this message a turn" must survive a crash even when the live dispatch
    // below cannot run yet. `deliverMessage` is idempotent over this row.
    tx.inboxes.ensureDelivery(inbox.id, agent.id, wrapped.id);
    tx.notifications.insertMentionExternal({
      userId: authorUserId,
      agentId: agent.id,
      sourceWorkspaceId,
      sourceConversationId: input.sourceConversation.id,
      sourceMessageId: input.message.id,
      payload: {
        source_workspace_name: sourceWorkspaceName,
        source_conversation_title: input.sourceConversation.title,
        mention_excerpt: excerpt(input.message.content),
      },
    });
    copiedTo.add(agent.id);
    report.copies.push({
      agentId: agent.id,
      agentHandle: agent.name,
      inboxConversationId: inbox.id,
      wrapped,
      notifiedUserId: authorUserId,
    });
  }
  return report;
}

export interface MentionCcEffectDeps {
  runtimeStart: AgentRuntimeStartPort;
  runtimeDeliver: AgentMessageDeliveryPort;
  events: ScopeEventBus;
  logger: BackendLogger;
}

/**
 * Post-commit half: everything that is NOT a durable fact. Best-effort by
 * nature — the copy is already committed, so a failure here delays a wake, it
 * never loses a mention.
 */
export async function dispatchMentionCcEffects(
  report: MentionCcReport,
  deps: MentionCcEffectDeps,
): Promise<void> {
  for (const skip of report.skipped) {
    deps.logger.info(
      {
        event: 'mention_cc.skip',
        reason: skip.reason,
        handle: skip.handle,
        agentId: skip.agentId ?? null,
        sourceConversationId: report.source.conversationId,
        sourceMessageId: report.source.messageId,
      },
      'mention-cc: mention not copied',
    );
  }
  for (const copy of report.copies) {
    // An inserted message publishes its own conversation frame — the general
    // invariant, not an inbox feature. No `viewer:` unread frame and no
    // `workspace_channels_changed`: the inbox has no human participant and no
    // workspace, so neither frame has an addressee (§4.2).
    deps.events.publish(copy.inboxConversationId, {
      kind: 'message',
      payload: { message: copy.wrapped },
    });
    // Option A: the author's notification points at the SOURCE message.
    deps.events.publishToScope(`viewer:${copy.notifiedUserId}`, 'notification', {
      kind: 'mention_external',
      conversation_id: report.source.conversationId,
      message_id: report.source.messageId,
    });
    try {
      await deps.runtimeStart.start(copy.inboxConversationId, copy.agentId);
    } catch (err) {
      deps.logger.warn(
        {
          event: 'mention_cc.wake_failed',
          agentId: copy.agentId,
          inboxConversationId: copy.inboxConversationId,
          err,
        },
        'mention-cc: auto-start failed (the durable inbox row is kept)',
      );
      continue;
    }
    try {
      await deps.runtimeDeliver.deliverMessage(
        copy.inboxConversationId,
        copy.agentId,
        copy.wrapped.id,
      );
    } catch (err) {
      deps.logger.warn(
        {
          event: 'mention_cc.dispatch_failed',
          agentId: copy.agentId,
          inboxConversationId: copy.inboxConversationId,
          wrappedMessageId: copy.wrapped.id,
          err,
        },
        'mention-cc: live dispatch failed (the durable inbox row is kept)',
      );
    }
  }
}

function renderMentionWrap(args: {
  agentHandle: string;
  sourceWorkspaceName: string;
  sourceConversationTitle: string;
  sourceContent: string;
}): string {
  // Informational, and it says so. The pre-v71 wrap asked the agent to "reply
  // here in this DM and the user will see it" — true while the copy landed in a
  // DM the human was admitted to, and FALSE for an inbox, whose only participant
  // is the agent (§4.2). The human's own view of this mention is the source
  // channel (their `mention_external` notification jumps there), so the honest
  // instruction is to note it, not to answer into a stream nobody reads. A reply
  // route for a non-member agent arrives with DirectPair (#task:2020) /
  // DeliveryTarget (#task:2021).
  //
  // Both interpolated labels are free text (a workspace name is a label, a
  // channel title has always been freeform) and this body reaches the agent
  // verbatim on stdin, so each goes in a code span: a label must not be able to
  // fabricate Markdown structure or a reference destination. The recipient is
  // named with a canonical reference (#task:2000) — server-authored text models
  // the one form the prompt teaches. The quoted original is a blockquote, which
  // is precisely why re-stating its references cannot re-deliver them.
  return [
    `A user mentioned you (${formatReferenceToken({ kind: 'agent', handle: args.agentHandle })}) in ${inlineCode(args.sourceWorkspaceName)} · ${inlineCode(args.sourceConversationTitle)}.`,
    `You are not a member of that channel: you cannot read it or reply there, and this inbox has no other participant — so there is nothing to answer here.`,
    ``,
    `Original message:`,
    blockquote(args.sourceContent),
    ``,
    `This is a notification. The person who wrote it sees your mention in that channel; if the work is yours, expect it to arrive through a channel you are actually in.`,
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
