// Types, error taxonomy, policy table, and small pure helpers shared across
// the conversation-message send aggregate (`ConversationMessageService`) and
// its collaborators (`ThreadFollowManager`, `MessageDeliveryCoordinator`).
//
// This module holds only declarations — no behavior, no `this`. The facade
// re-exports the previously-public names (error classes + input/result types)
// so external importers keep importing from `conversation-message-service.js`.
import type {
  AgentRunTerminalReason,
  AgentSendStaleResolutionReason,
  AttachmentRefInput,
  ConversationDto,
  DeliveryTarget,
  MessageDto,
  MessageEventPayload,
  MessageProjections,
  Reference,
} from '@silverhand/shared';
import type { BackendLogger } from '../../context.js';
import type { MentionCcReport } from '../../application/mention-cc.js';
import type { AgentRuntimeHost } from '../../runtime/agent-runtime-host.js';
import type { ConversationUnreadPublishPort } from '../conversation/unread-publish-port.js';
import type {
  DeliveryReadPort,
  DeliveryWritePort,
  MessageUnitOfWork,
  ThreadFollowDirectWritePort,
  ThreadFollowReadPort,
} from './ports.js';
import type { ScopeEventBus } from '../../ws/scope-event-bus.js';
import type {
  AgentPrincipal,
  UserPrincipal,
} from '../../auth/principal.js';

export type SendMessageActor =
  | UserPrincipal
  | AgentPrincipal;

/**
 * WHERE a send goes, as the caller has ALREADY DECIDED IT (#task:2021 P4-4).
 *
 * Two arms because there are two doors, and they resolve a destination by
 * different authorities:
 *
 *  - `stream` — an absolute coordinate that `resolveDeliveryTarget` produced from
 *    the address the agent spelled. Participation, placement and the thread-root
 *    rule were all decided there, against the target itself; the service does not
 *    re-parse an address and cannot be handed one.
 *  - `own_main_line` / `own_reply_cluster` — a PLACEMENT inside the actor's own
 *    conversation, which is all the human door can express (a person's client
 *    posts where the person is looking). `messageId` may be any message in the
 *    cluster and is normalized to its root in the send transaction — deliberately
 *    NOT the agent rule, which requires the address to name a root already: the
 *    two doors differ in what the sender can be expected to know.
 *
 * There is no default arm and no optional field. An absent destination used to
 * mean "the current conversation", which is the ambient spelling #task:2021
 * exists to remove: it is the one form that becomes silently wrong as soon as a
 * session serves more than one stream.
 */
export type SendMessageDestination =
  | { kind: 'stream'; stream: DeliveryTarget }
  | { kind: 'own_main_line' }
  | { kind: 'own_reply_cluster'; messageId: string };

export interface SendMessageInput {
  /** The conversation the ACTOR is acting from — where its credential lives, and
   *  the run this send resolves. Not where the message goes: that is
   *  {@link destination}, and the two are routinely different now. */
  conversationId: string;
  actor: SendMessageActor;
  content: string;
  /** Attachment references (id + optional compose-time label), already
   *  normalized from the wire union at the route boundary. */
  attachmentRefs?: AttachmentRefInput[];
  destination: SendMessageDestination;
  /** The sender's claim about WHICH STREAM {@link seenUpToSeq} was measured
   *  against, as the canonical id-form token (`#conv:<id>[/thread:<root>]`).
   *  Cross-checked against the stream this send actually resolved to; a mismatch
   *  hard-rejects rather than CAS-ing a boundary read somewhere else (§6.4). */
  assertedStream?: string;
  seenUpToSeq?: number;
  staleEventId?: string;
  staleResolutionReason?: AgentSendStaleResolutionReason;
  freshnessBypass?: boolean;
}

export interface SendMessageResult {
  /** The committed-message payload — the persisted message plus the
   *  viewer-invariant absolute projections computed IN the send transaction.
   *  STRUCTURALLY IDENTICAL to the post-commit `message` WS frame
   *  ({@link MessageEventPayload}): the human send route echoes it verbatim so
   *  the HTTP ACK and the WS echo converge through the renderer's single
   *  committed-message apply seam, independent of WS echo timing (#task:1749).
   *  The service builds this object ONCE and reuses it for both the WS publish
   *  and this return — there is no second, projection-less payload shape. */
  committed: MessageEventPayload;
  targetConversationId: string;
  /**
   * The references in this message that addressed NOBODY (#task:2021 P4-5-b) —
   * the author's own tokens, in their own order, with no reason attached (see
   * `application/reference-addressing.ts` for why a reason would be an existence
   * oracle).
   *
   * SENDER-ONLY, by position: it is a sibling of `committed`, never a field
   * inside it. `committed` is the payload the post-commit WS frame carries to
   * everyone in the conversation, so anything placed inside it is published.
   * BOTH send routes carry this alongside it instead — the agent's typed output
   * field and the human ACK's `MessageSendAck` sibling — and the WS frame stays
   * literally `committed` (#task:1749). One send semantics, one answer: an actor
   * kind is no reason to lose the diagnostic.
   *
   * Total, not optional: "which of your references landed" is answered for every
   * send, and an empty array is that answer. An absent field would make "nothing
   * unresolved" indistinguishable from "not computed".
   */
  unresolvedReferences: readonly Reference[];
  /** Stream head at the moment BEFORE this message was inserted. Set for an
   *  agent send whose insert SKIPPED the freshness CAS — an explicit
   *  `freshnessBypass`, or a loose first touch that carried no
   *  `seenUpToSeq` — because in both cases nothing proved the sender covers
   *  the stream, so the daemon needs a merge prerequisite for its own seq:
   *  once its observed cursor covers everything below this message, the own
   *  seq joins the watermark. Without it, such a send in a quiet stream
   *  leaves the sender permanently stale on its own head (countgame P1,
   *  #task:1854). Absent exactly when the CAS ran — the sender already covered
   *  the stream it wrote into, which is a fact about that stream and not about
   *  whether it was the sender's own conversation (#task:2021 P4-4). Carried
   *  uniformly for main-line AND thread-reply sends. */
  streamHeadBeforeSend?: number;
}

export interface ResolveStaleMessageInput {
  conversationId: string;
  actor: AgentPrincipal;
  staleEventId: string;
  resolutionReason: 'obsolete';
}

/**
 * Per-actor-kind DIFFERENCES in how a send behaves. Every field here is a real
 * product choice with more than one legal value.
 *
 * The send's write authority — lifecycle ∧ participation ∧
 * not-survivor-read-only — is deliberately NOT here. It used to be, as
 * `requireSenderParticipation`, and by the end of #task:2021 P4-4 both arms
 * filled it with `true`: a boolean with no legal current value is not a seam,
 * it is a security invariant demoted to a switch someone can later set to
 * `false`. `assertPostAuthority` therefore takes no policy at all,
 * and a future actor kind has to widen the discriminated union and state its
 * arm there, which is where a reviewer looks for it.
 */
export interface SendMessagePolicy {
  /** May this actor kind address a stream that is NOT the conversation it is
   *  acting from? Two real values: an agent's whole job is cross-stream
   *  collaboration, while a person's client posts where the person is looking —
   *  a human request that named a foreign stream would be a client defect, and
   *  answering it would make the send path a target-existence oracle for
   *  someone who was never shown the target. */
  allowForeignStream: boolean;
  distributeExcludeSender: boolean;
  /**
   * Default auto-start behavior for the actor. The runtime decision in
   * `sendMessage` overrides this for an agent send that lands OUTSIDE the
   * conversation it was sent from — see the `shouldAutoStartIdle` derivation.
   * An agent sending into its own conversation keeps this `false` so in-channel
   * back-and-forth does not ping-pong every idle member; an agent addressing
   * another stream always auto-starts that stream's idle members, because the
   * send is an explicit hand-off and an idle recipient would otherwise leave the
   * message sitting in an inbox.
   */
  autoStartIdleRecipients: boolean;
  ccMentions: boolean;
  resolveRun: boolean;
}

export const POLICIES: Record<SendMessageActor['kind'], SendMessagePolicy> = {
  user: {
    allowForeignStream: false,
    distributeExcludeSender: false,
    autoStartIdleRecipients: true,
    ccMentions: true,
    resolveRun: false,
  },
  agent: {
    allowForeignStream: true,
    distributeExcludeSender: true,
    // Own-conversation baseline: no auto-start. A send that lands in another
    // stream is promoted to auto-start at runtime in `sendMessage`.
    autoStartIdleRecipients: false,
    ccMentions: false,
    resolveRun: true,
  },
};

export type ConversationErrorCode =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'conversation_archived'
  /**
   * The `direct_pair` narrowing of the write gate: the other endpoint's principal
   * is gone, so the DM is READ-ONLY for the survivor (#task:2021 P4-4). Not a
   * lifecycle state — the conversation is neither closed nor archived, and it
   * never becomes postable again — which is why it maps to 403 rather than 409,
   * the same answer the request-layer gate gives for the identical fact.
   */
  | 'conversation_endpoint_gone';

export class ConversationError extends Error {
  constructor(
    public readonly code: ConversationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationError';
  }
}

export type ActorErrorCode =
  | 'agent_not_found'
  /**
   * PARTICIPATION, not roster membership: renamed with the rule it reports
   * (#task:2021 P4-4). `direct_pair` / `agent_inbox` have no `conversation_agents`
   * rows, so "not a member" was the wrong question for two of the three
   * placements and refused every agent send into a DM.
   */
  | 'agent_not_participant_of_conversation'
  /**
   * The human arm of the same refusal (#task:2021 P4-4). A SEPARATE
   * code rather than a shared "not a participant": the two actor kinds reach the
   * wire through different clients, and an operator reading `agent_…` for a
   * person's refused send would look for the wrong subject. Both resolve through
   * one authority; only the reporting is per kind.
   *
   * Same 403 as its agent twin, and deliberately the same code the ROUTE already
   * answers with for a non-participant human — the in-transaction copy exists to
   * catch the gap, not to publish a new concurrency reason.
   */
  | 'user_not_participant_of_conversation';

export class ActorError extends Error {
  constructor(
    public readonly code: ActorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActorError';
  }
}

export type TargetErrorCode =
  | 'reply_target_not_found'
  /**
   * The sender measured its freshness boundary against a DIFFERENT stream from
   * the one this send resolved to (#task:2021 P4-4). 409, like the stale
   * conflict it protects: the sender's view of where it is has to be re-earned
   * before the CAS means anything.
   */
  | 'asserted_stream_mismatch';

export class TargetError extends Error {
  constructor(
    public readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TargetError';
  }
}

export type PolicyErrorCode = 'target_not_allowed_for_user';

export class PolicyError extends Error {
  constructor(
    public readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export type AttachmentErrorCode =
  | 'attachment_outside_channel'
  | 'attachment_label_kind_mismatch';

export class AttachmentError extends Error {
  constructor(
    public readonly code: AttachmentErrorCode,
    message: string,
    public readonly attachmentId?: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export class MessageFreshnessError extends Error {
  readonly code = 'message_stale' as const;

  constructor(
    public readonly conversationId: string,
    public readonly seenUpToSeq: number,
    public readonly currentSeq: number,
    public readonly staleEventId: string,
    /** Target stream the CAS was scoped to (NULL = main line). */
    public readonly threadRootId: string | null = null,
  ) {
    super(
      `message is stale: conversation advanced from seq ${seenUpToSeq} ` +
        `to ${currentSeq} before send`,
    );
    this.name = 'MessageFreshnessError';
  }
}

export class MessageFreshnessGuardError extends Error {
  constructor(
    public readonly conversationId: string,
    public readonly seenUpToSeq: number,
    public readonly currentSeq: number,
    public readonly threadRootId: string | null,
  ) {
    super(
      `message is stale: conversation advanced from seq ${seenUpToSeq} ` +
        `to ${currentSeq} before send`,
    );
    this.name = 'MessageFreshnessGuardError';
  }
}

export interface ConversationMessageServiceOptions {
  /** The ONLY write boundary of the send path: every persistence call inside
   *  the send / materialize / follow transactions comes from its scope. */
  uow: MessageUnitOfWork;
  threadFollow: {
    read: ThreadFollowReadPort;
    directWrite: ThreadFollowDirectWritePort;
  };
  delivery: {
    read: DeliveryReadPort;
    write: DeliveryWritePort;
  };
  /** Post-commit effects. Held OUTSIDE the transaction scope by construction.
   *  The mention CC is deliberately absent: its writes are transactional now
   *  (v71 §5), so it is not an injected effect port — the send calls the use case
   *  with its own `MessageTxScope` and hands the resulting report to the delivery
   *  coordinator after commit. */
  unreadPublish: ConversationUnreadPublishPort;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}

/**
 * A DELIVERY RECIPIENT of a message: the minimal principal identity, and
 * deliberately nothing more (#task:2021 P4-5).
 *
 * It replaced `ConversationAgentDto` on every recipient-shaped signature of the
 * send path. That DTO is a MEMBERSHIP FACT — `joined_at` plus the runtime seat's
 * projected columns — and a `direct_pair` endpoint or an inbox owner has no
 * membership row at all, so widening the fan-out to reach them while keeping the
 * DTO would have meant fabricating a row for a placement that has none: a
 * membership assertion invented by the delivery path, then free to be filtered or
 * joined on downstream.
 *
 * A named object rather than a bare `string[]`: an id list of one principal kind
 * is assignable to an id list of any other, and this set is agents only.
 *
 * Not a participation claim either — it is the OUTPUT of one. The set is
 * enumerated inside the send transaction from the placement authority conjoined
 * with a live `agents` row, and sender exclusion stays at the plan boundary where
 * the plan can be read.
 */
export interface MessageRecipient {
  agentId: string;
}

/**
 * Per-recipient plan for delivering a thread reply (§6 reply-cluster).
 * Current thread messages align with main-line channel delivery: follower
 * agents that are live participants receive a `turn`, excluding the sender.
 * `observe` is reserved for non-waking context paths such as backfill/pull
 * history.
 */
export type ThreadDeliveryKind = 'turn' | 'observe';

export interface ThreadDeliveryRecipient extends MessageRecipient {
  kind: ThreadDeliveryKind;
}

export interface ThreadDeliveryPlan {
  threadRootId: string;
  /** Follower agents that are CURRENT LIVE PARTICIPANTS of the conversation,
   *  EXCLUDING the reply sender. Computed inside the send transaction after
   *  auto-follow upserts so newly-followed agents are included. */
  recipients: ThreadDeliveryRecipient[];
}

export interface SendMessageTxResult {
  sourceConversation: ConversationDto;
  targetConversation: ConversationDto;
  message: MessageDto;
  /** MAIN-LINE recipients: the target conversation's live agent participants,
   *  enumerated in this transaction. Empty for a thread reply, which delivers
   *  through `threadDelivery` instead. References NEVER change this set — the
   *  main line is a full fan-out (#task:2000 layer ①). */
  recipients: MessageRecipient[];
  /** What the in-transaction mention CC wrote, for the post-commit half to
   *  finish (wake / WS frames / skip log). Null when the actor's policy carries
   *  no CC (`POLICIES.agent`), which is NOT the same as an empty report: an
   *  agent send never evaluates the mentions at all. */
  mentionCc: MentionCcReport | null;
  /** Non-null when this send is a thread reply: drives follower-gated
   *  delivery instead of the main-line channel-member fan-out. */
  threadDelivery: ThreadDeliveryPlan | null;
  /** The references that addressed nobody, computed in this transaction from the
   *  same participation authority the fan-out above is built from, plus what the
   *  CC actually copied. Reported to the SENDER after commit; see
   *  {@link SendMessageResult.unresolvedReferences}. */
  unresolvedReferences: Reference[];
  skippedFreshnessReason: string | null;
  /** S1 (#task:1276) authoritative projection deltas computed IN this
   *  transaction, attached to the post-commit `message` event. Null when the
   *  send touches no derived projection (a main-line, non-reply message). */
  projections: MessageProjections | null;
  streamHeadBeforeSend: number | null;
}

export const REPLIED: AgentRunTerminalReason = 'replied';
export const MENTION_EXCERPT_LIMIT = 160;
export const START_FAILURE_ERROR_LIMIT = 240;
export const STALE_MESSAGE_LIMIT = 10;

export function excerpt(s: string): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length <= MENTION_EXCERPT_LIMIT
    ? compact
    : `${compact.slice(0, MENTION_EXCERPT_LIMIT - 1)}…`;
}

export function nonEmptyName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function describeStartFailure(err: unknown): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const compact = message.replace(/\s+/g, ' ').trim() || 'unknown error';
  return compact.length <= START_FAILURE_ERROR_LIMIT
    ? compact
    : `${compact.slice(0, START_FAILURE_ERROR_LIMIT - 1)}…`;
}
