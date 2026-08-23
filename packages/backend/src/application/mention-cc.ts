// Mention CC — a user @-mentions an agent that is NOT a member of the
// conversation, so the message is copied into the DM LINE BETWEEN THAT USER AND
// THAT AGENT (agent-scoped-session-v1 §4.2 / §5, #task:2014; destination
// redirected by #task:2072).
//
// Four facts decide the shape of this module. The first is what #task:2072
// changed:
//
//  1. THE COPY GOES WHERE THE RECIPIENT CAN ANSWER IT. A CC is written only for a
//     NON-participant of the source (`already_member` skips the rest), and a
//     non-participant has no write authority there (`delivery-target-resolution.ts`
//     rule 2) — so the destination can never be the origin channel. It must also
//     not be a stream whose ONLY participant is the recipient: that is a wake with
//     an empty set of writable destinations, which is precisely what the retired
//     `agent_inbox` arm did (#task:2072). The honest destination is the
//     `direct_pair` "author ↔ mentioned agent": the agent is an endpoint, so it
//     participates and may write, and the other endpoint is the person who asked.
//
//  2. WHO MAY HAVE THAT LINE IS NOT THIS MODULE'S DECISION. A human↔agent pair is
//     itself an ACL fact — `agentHumanViewerUserIds` admits the human endpoint of
//     every one of them — so a mention that minted freely would let anybody grant
//     themselves a line to, and visibility of, any agent whose handle they can
//     guess (handles are globally unique). The verdict therefore comes from the ONE
//     named home of "may this human open a direct line to this agent",
//     `canInitiateDirectMessageToAgent` — the same gate the agent page's "Message"
//     button runs, so this path creates nothing its author could not have created
//     with one click. It is asked at the SEND BOUNDARY, outside the transaction,
//     and handed in as {@link MentionCcInput.directLineAgentIds}: it reads
//     authorization state, which is not on the send's scope by construction.
//     A handle it refuses is `no_direct_line` — including every
//     CONVERSATION-scoped agent, whose human entry is its own workspace/Agent Space
//     and which therefore takes no direct pair at all.
//
//  3. THE COPY IS WRITTEN INSIDE THE SOURCE MESSAGE'S TRANSACTION (§5). It used
//     to be a post-commit `void ccMentionsBestEffort(...)`: a crash in the gap
//     lost the copy permanently, and the human was told nothing, while the
//     message they wrote was safely committed. Everything whose loss the domain
//     cannot tolerate is therefore in the transaction now — the copy, its durable
//     delivery row, and the author's `mention_external` notification — and
//     `cc_source_message_id` (partial UNIQUE per destination) makes a duplicate a
//     constraint failure rather than a second notification. Since #task:2072 the
//     MINT is in that transaction too, which is why its announcement is the one
//     thing deferred: see {@link recordDirectPairOpens}.
//
//  4. THE DESTINATION NOW HAS A HUMAN AT THE OTHER END, which is a product change
//     and not only a plumbing one: the copy is visible to the person who wrote the
//     mention, in their own DM list. That list is an authority the post-commit half
//     invalidates (`direct_pairs_changed`); there is still no `viewer:` unread
//     frame, but the reason is no longer "the destination has no human" — it is
//     that a `system` message is excluded from every unread branch by
//     `UNREAD_GUARDS`. The author's jump target is unchanged: `mention_external`
//     stays with the message's AUTHOR and points at the SOURCE message they are
//     already authorized to read (shiki 2026-08-14, "option A").
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
// below: the copy and its durable delivery row (`conversation_inboxes`, the
// per-(conversation, agent) DELIVERY QUEUE — not the retired `agent_inbox`
// placement) are already committed, so the next spawn drains them.
import { formatReferenceToken, inlineCode } from '@silverhand/shared';
import { systemSubtype } from '@silverhand/shared';
import type { ConversationDto, MessageDto, Reference } from '@silverhand/shared';
import type {
  AgentMessageDeliveryPort,
  AgentRuntimeStartPort,
} from '../runtime/agent-runtime-host.js';
import type { BackendLogger } from '../context.js';
import {
  publishDirectPairsChangedToViewer,
  recordDirectPairOpens,
} from './direct-pairs-changed.js';
import { openDirectPair } from './open-direct-pair.js';
import type { MessageTxScope } from '../services/conversation-message/ports.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

/**
 * The transactional capability this write needs, as a SUBSET of the send's own
 * scope — not a parallel port bundle. Stated as a `Pick` so the list is
 * auditable and a widening shows up here: the CC write may resolve handles, read
 * the source roster, open the author's line to the agent, read the source
 * workspace's name, insert the copy, make it deliverable, and notify the author.
 * Nothing else — in particular no authorization read, which is why the
 * direct-line verdict arrives as input (header, fact 2).
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
  /**
   * The agents THIS message's author may open a direct line to — the send
   * boundary's answer from `canInitiateDirectMessageToAgent`, one entry per
   * addressed handle it admits (#task:2072, header fact 2).
   *
   * A SET OF IDS rather than a predicate, for two reasons. The verdict reads
   * authorization state, so evaluating it here would put a non-transactional read
   * inside the send transaction; and keying it by ID rather than by handle makes
   * every drift fail CLOSED — if the handle resolved to a different agent between
   * the boundary and this transaction, the id is simply absent and the mention is
   * skipped rather than minting a line nobody gated.
   */
  directLineAgentIds: ReadonlySet<string>;
}

/** One committed copy, and everything the post-commit half needs to finish it. */
export interface MentionCcCopy {
  agentId: string;
  agentHandle: string;
  /** The `direct_pair` "author ↔ agent" the copy landed in (#task:2072). */
  conversationId: string;
  wrapped: MessageDto;
  /** Viewer of the `mention_external` row = the source message's author, who is
   *  also the human endpoint of {@link conversationId} — by construction of the
   *  mint, not by a roster read. */
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
  | 'source_not_workspace_placed'
  /**
   * The author may not open a direct line to this agent (#task:2072) — the
   * verdict of `canInitiateDirectMessageToAgent`, asked at the send boundary and
   * arriving as {@link MentionCcInput.directLineAgentIds}.
   *
   * Two populations land here, and the reason is deliberately ONE for both. A
   * CONVERSATION-scoped agent takes no direct pair at all (its human entry is its
   * own workspace/Agent Space), and an agent the author is not authorized to see
   * must not become visible to them because they typed its handle. Splitting the
   * two would tell the author which of "this agent does not work that way" and
   * "you may not see this agent" applies, i.e. it would answer a question about an
   * agent they have no access to.
   *
   * NOT SILENT, and not an existence oracle either: with no copy written the agent
   * is absent from `ccReachedAgentIds`, so the reference is reported UNRESOLVED to
   * its author by `reference-addressing.ts` — the same single answer an unknown
   * handle gets, carrying no reason by design.
   */
  | 'no_direct_line';

export interface MentionCcSkip {
  handle: string;
  reason: MentionCcSkipReason;
  agentId?: string;
}

export interface MentionCcReport {
  copies: MentionCcCopy[];
  skipped: MentionCcSkip[];
  /**
   * The pairs THIS transaction brought into existence (#task:2072) — the mint's
   * deferred announcement, carried out as data because the frame may not be
   * published before commit ({@link recordDirectPairOpens}).
   *
   * Exposed rather than published-and-forgotten so the post-commit half can PROVE
   * it covered every one of them instead of the coverage being a property of
   * whoever wrote it. Not the same set as `copies`: a copy into a pair that
   * already existed owes a list frame too (its order and preview moved), and it is
   * absent here.
   */
  openedPairConversationIds: string[];
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
    openedPairConversationIds: [],
    source: {
      conversationId: input.sourceConversation.id,
      messageId: input.message.id,
    },
  };
  // #task:2000: only canonical agent references CC. A `silverhand://human/x`
  // reference addresses a person, who has no runtime to hand a copy to, and the
  // plain `@handle` alias addresses nobody at all.
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
  // The mint's announcement, held as data until the caller has committed
  // (#task:2072). Assembled here rather than at the mint so the file that owns the
  // frame owns every way of not sending it yet — see `recordDirectPairOpens`.
  const opens = recordDirectPairOpens();

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
    // The line the author may have with this agent — the boundary's verdict, read
    // as membership and nothing else (header fact 2). AFTER `unresolved_author` on
    // purpose: the set was computed for THIS author, so asking it about a message
    // whose author is unknown would be asking the wrong question.
    if (!input.directLineAgentIds.has(agent.id)) {
      report.skipped.push({ handle, reason: 'no_direct_line', agentId: agent.id });
      continue;
    }
    // The ONE mint operation both human doors funnel through (#task:2035), reached
    // here with the transaction-aware announcement port: the pair must roll back
    // with the copy, so the frame cannot go out in the same breath.
    const destination = openDirectPair(
      { conversations: tx.conversations, allocations: opens.port },
      { kind: 'human', id: authorUserId },
      { kind: 'agent', id: agent.id },
      input.message.created_at,
    );

    const wrapped = tx.messages.insertForConversation({
      conversationId: destination.id,
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
    tx.inboxes.ensureDelivery(destination.id, agent.id, wrapped.id);
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
      conversationId: destination.id,
      wrapped,
      notifiedUserId: authorUserId,
    });
  }
  report.openedPairConversationIds = [...opens.opened()];
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
  const announced = new Set<string>();
  for (const copy of report.copies) {
    // The DM list is the authority for what lines the author has, so it is
    // invalidated first: for a pair this send minted, it is the only way a live
    // client learns the row exists at all, and for one that already existed its
    // order and preview just moved (#task:2035 / #task:2072). Audience is the
    // pair's human endpoint, which IS the notified author — by construction of the
    // mint above, not by a roster read.
    publishDirectPairsChangedToViewer(deps.events, copy.notifiedUserId, {
      conversation_id: copy.conversationId,
    });
    announced.add(copy.conversationId);
    // An inserted message publishes its own conversation frame — the general
    // invariant, not a destination feature. Still no `viewer:` unread frame: a
    // `system` message is excluded from every unread branch (`UNREAD_GUARDS`), so
    // there is no count to move. No `workspace_channels_changed` either — a
    // `direct_pair` has no workspace coordinate to carry one.
    deps.events.publish(copy.conversationId, {
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
      await deps.runtimeStart.start(copy.conversationId, copy.agentId);
    } catch (err) {
      deps.logger.warn(
        {
          event: 'mention_cc.wake_failed',
          agentId: copy.agentId,
          conversationId: copy.conversationId,
          err,
        },
        'mention-cc: auto-start failed (the durable delivery row is kept)',
      );
      continue;
    }
    try {
      await deps.runtimeDeliver.deliverMessage(
        copy.conversationId,
        copy.agentId,
        copy.wrapped.id,
      );
    } catch (err) {
      deps.logger.warn(
        {
          event: 'mention_cc.dispatch_failed',
          agentId: copy.agentId,
          conversationId: copy.conversationId,
          wrappedMessageId: copy.wrapped.id,
          err,
        },
        'mention-cc: live dispatch failed (the durable delivery row is kept)',
      );
    }
  }
  // The COVERAGE PROOF for the deferred announcement (#task:2072). Every pair the
  // transaction minted was minted for a copy, so the loop above has announced all
  // of them; an id left over means a future edit minted a line whose frame nobody
  // sends — the #task:2035 bug, back. It cannot be repaired here (this half does
  // not know that pair's human endpoint), so it is reported at `error`: silence
  // would make the obligation unfalsifiable again.
  for (const conversationId of report.openedPairConversationIds) {
    if (announced.has(conversationId)) continue;
    deps.logger.error(
      {
        event: 'mention_cc.pair_open_unannounced',
        conversationId,
        sourceConversationId: report.source.conversationId,
        sourceMessageId: report.source.messageId,
      },
      'mention-cc: opened a direct pair with no announcement (see #task:2035)',
    );
  }
}

/** Exported for the cross-implementation contract test (`tests/mention-cc-contract.test.ts`).
 *  Internal to this module's own path — deliberately absent from the package
 *  barrel and from any public surface: it is the production renderer, reached
 *  directly so the contract is asserted against what ships rather than against a
 *  copy of it. */
export function renderMentionWrap(args: {
  agentHandle: string;
  sourceWorkspaceName: string;
  sourceConversationTitle: string;
  sourceContent: string;
}): string {
  // It says what the recipient can and cannot do, and since #task:2072 that
  // includes a reply route. The pre-v71 wrap asked the agent to "reply here in
  // this DM and the user will see it" — true then, false for the `agent_inbox`
  // this landed in afterwards (whose only participant was the agent), and true
  // again now that the destination is the DM line between the agent and the person
  // who mentioned it. What stays false in every version is the ORIGIN: a CC exists
  // only for a non-participant, so "reply in that channel" never was an option,
  // and only a person can put the agent there (`member add`).
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
    `You are not a member of that channel, so you cannot read it or reply there. This line is your direct message with the person who mentioned you — answer here and they will see it.`,
    ``,
    `Original message:`,
    blockquote(args.sourceContent),
    ``,
    `If the work belongs in that channel, say so here: only a person can put you in it.`,
  ].join('\n');
}

/** Quote every LOGICAL line. CommonMark ends a line at a bare CR as well as at LF
 *  and CRLF, so splitting on `\n` alone left the rest of a CR-separated original as
 *  live prose — and a reference in that remainder addressed its subject a second
 *  time, which is the harm quoting exists to prevent. */
function blockquote(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(line => `> ${line}`)
    .join('\n');
}

/** Cut at a count of CHARACTERS, never inside one. `String.length` counts UTF-16
 *  units, so slicing by it can split a surrogate pair and store a lone surrogate —
 *  not text, and not something a second implementation can reproduce. Exported for
 *  the same reason as the renderer above. */
export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const characters = Array.from(flat);
  if (characters.length <= EXCERPT_LIMIT) return flat;
  return characters.slice(0, EXCERPT_LIMIT - 1).join('') + '…';
}
