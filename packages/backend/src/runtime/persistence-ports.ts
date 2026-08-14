/**
 * The persistence capability the outbound runtime fanout needs, stated as
 * driver-free ports (#task:1982 W3).
 *
 * ## Why the fanout gets ports at all
 *
 * The fanout owns in-process runtime authority: the per-host run-state cache,
 * the delivery coordinator, the clear-session waiter registry, the event
 * perimeter. That authority is NOT persistence and deliberately does not sink
 * into an adapter. What DOES sink is every durable read/write it performs —
 * inbox custody, the runtime rows it projects, the directory reads that build a
 * spawn's options. Before this cut those arrived as seven concrete repos built
 * from a `Database` handle the fanout held, plus one hand-prepared JOIN and one
 * bare `db.transaction`; a process-state owner therefore also decided storage.
 *
 * ## Shape rules these ports follow
 *
 *  - **A method's name carries the constant part of its write.** `markCrashed`
 *    and `clearCliSession` exist instead of one general `updateAgentRuntime`
 *    because `{status:'crashed', pid:null}` and `{cliSessionId:null}` are
 *    decided by WHICH act the fanout performs, so they cannot drift per call
 *    site. (The general status write still exists, but it belongs to
 *    `DbRuntimeStatusProjector`, which owns the whole event→status mapping.)
 *  - **Physical rows stop at the adapter (R4).** `hosts.routingView` and
 *    `users.nameOf` return the two/three fields the fanout reads rather than
 *    `HostRow` / `UserRow`, and an inbox delivery carries
 *    {@link RuntimeInboxMessage} — a runtime projection, asserted by the
 *    adapter contract test on the KEY SET, not a `MessageRow` narrowed by type.
 *  - **A facet is one aggregate or one pass.** Where a facet mixes directions
 *    it is because the same pass performs both acts and nothing else calls
 *    them; that reason is stated on the facet.
 */
import type {
  AgentDto,
  AgentRuntimeControlEventRow,
  ConversationAgentDto,
  ConversationAgentStatus,
  ConversationDto,
  FromKind,
  MemberDto,
  MessageDto,
  WorkspaceDto,
} from '@silverhand/shared';
import type {
  RuntimePrincipal,
  RuntimePrincipalScope,
} from '../auth/runtime-principal.js';

/**
 * Per-delivery semantics as the runtime consumes them. Mirrors the persisted
 * `conversation_inboxes.delivery_kind` vocabulary; the adapter's assignment is
 * the drift alarm — a persistence-side union that grows a member stops
 * type-checking there rather than silently reaching the runtime as a string.
 */
export type RuntimeInboxDeliveryKind = 'turn' | 'observe';

/**
 * The message fields a queued delivery carries into the runtime: the stdin
 * batch header/body (`MessageLite`) plus `seq`, which delivery bookkeeping uses
 * as the observed-cursor high-water mark. A RUNTIME PROJECTION — the physical
 * `messages` row additionally carries `conversation_id`, the author snapshot
 * and the retired `task_*` columns, none of which the runtime reads.
 */
export interface RuntimeInboxMessage {
  id: string;
  seq: number;
  thread_root_id: string | null;
  from_kind: FromKind;
  from_agent_id: string | null;
  from_user_id: string | null;
  content: string;
  created_at: number;
  /** Raw metadata JSON. The stdin header derives its `task=#<n>` suffix, the
   *  attachment suffix and the subtype from it, so it crosses as stored. */
  metadata: string | null;
}

export interface RuntimeInboxDelivery {
  inboxId: number;
  message: RuntimeInboxMessage;
  deliveryKind: RuntimeInboxDeliveryKind;
}

/** A delivery this process has taken custody of under a connection lease. */
export interface RuntimeClaimedInboxDelivery extends RuntimeInboxDelivery {
  inFlightOwner: string;
}

export interface RuntimeInboxDeliveryRecord {
  inboxId: number;
  deliveredAt: number | null;
}

/**
 * Inbox custody: the durable queue of messages owed to an agent, and the
 * transitions between pending → in-flight (leased to one connection) →
 * delivered.
 *
 * Read and write live in ONE facet on purpose. The queries here are not a
 * general read model — each is a custody predicate that exists only to decide
 * a transition (`listPending` before a claim, `countInFlightForPairOwner` to
 * tell "already being started" from "nothing to drain",
 * `hasUndeliveredForPair` to gate a respawn-to-drain). Splitting them from the
 * transitions they guard would hand a caller half a protocol.
 */
export interface RuntimeInboxCustodyPort {
  /** Idempotent: the (conversation, agent, message) row is created at most
   *  once. `deliveredAt !== null` means this message was already delivered. */
  ensureDelivery(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): RuntimeInboxDeliveryRecord;
  /** Undelivered, unclaimed, unfailed rows in enqueue order. */
  listPending(conversationId: string, agentId: string): RuntimeInboxDelivery[];
  /** Pending origin conversations for a live AgentSlot, ordered by their
   * first durable inbox row. ConversationSlot callers never need this fold. */
  listPendingConversationIdsForAgent(agentId: string): string[];
  /** Atomically lease every currently-claimable row to `inFlightOwner`.
   *  Concurrent claimants cannot both win a row. */
  claimPending(
    conversationId: string,
    agentId: string,
    inFlightOwner: string,
  ): RuntimeClaimedInboxDelivery[];
  /** Any undelivered row for the pair, claimed or not. */
  hasUndeliveredForPair(conversationId: string, agentId: string): boolean;
  /** Rows the given owner currently holds — a stale owner's lease must never
   *  make an explicit start look successful. */
  countInFlightForPairOwner(
    conversationId: string,
    agentId: string,
    inFlightOwner: string,
  ): number;
  settleDelivered(input: {
    conversationId: string;
    agentId: string;
    inFlightOwner: string;
    inboxIds: readonly number[];
  }): boolean;
  settleUndelivered(input: {
    conversationId: string;
    agentId: string;
    inFlightOwner: string;
    inboxIds: readonly number[];
  }): boolean;
  /** Return rows leased to THIS owner to pending custody. */
  rollbackInFlight(inboxIds: readonly number[], inFlightOwner: string): void;
  /** Return rows to pending custody regardless of which owner holds them —
   *  for a startup path whose own lease identity is not the row's. */
  rollbackInFlightAnyOwner(inboxIds: readonly number[]): void;
  /** Sweep a dead connection's whole lease set. */
  rollbackInFlightForOwner(inFlightOwner: string): void;
  /** Reclaim a pair's rows held by any OTHER (older) connection. Returns how
   *  many leases were broken, which the caller logs as a reclaim. */
  rollbackInFlightForPairExceptOwner(
    conversationId: string,
    agentId: string,
    currentOwner: string,
  ): number;
}

export interface RuntimeAgentReadPort {
  get(agentId: string): AgentDto | null;
  /** True while a runtime-switch owns the agent; spawn/delivery must stand
   *  down instead of starting the outgoing runtime. */
  isRuntimeTransitioning(agentId: string): boolean;
}

export interface RuntimeConversationReadPort {
  get(conversationId: string): ConversationDto | null;
  /** Placement-aware participant authority. Runtime policy must not infer
   * participation from roster projection rows: AgentInbox deliberately has
   * no `conversation_agents` row and DirectPair will add another arm. */
  isAgentParticipant(conversationId: string, agentId: string): boolean;
  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null;
  listAgents(conversationId: string): ConversationAgentDto[];
  /** The sole human member, or `null` when the answer is not unique. Used only
   *  to pick the fallback `@handle` for legacy null-author rows in the stdin
   *  header; a non-unique answer degrades to the bare `user` token. */
  singleViewerUserId(conversationId: string): string | null;
}

export interface RuntimeWorkspaceReadPort {
  get(workspaceId: string): WorkspaceDto | null;
  /** Every workspace the agent is a member of — the spawn's memory index. */
  listForAgent(agentId: string): WorkspaceDto[];
}

export interface RuntimeUserReadPort {
  /** The user's mention handle, or `null` when the id resolves to nobody. */
  nameOf(userId: string): string | null;
}

/** The three host facts dispatch routing turns on. A projection: the physical
 *  `hosts` row also carries install identity and onboarding phase markers, and
 *  a routing decision must not be able to read them. */
export interface RuntimeHostRoutingView {
  id: string;
  /** Owner of the computer — the audience of host-scoped viewer events.
   *  `null` only for a pre-claim legacy/local row. */
  ownerUserId: string | null;
  revokedAt: number | null;
}

export interface RuntimeHostReadPort {
  routingView(hostId: string): RuntimeHostRoutingView | null;
}

export interface RuntimeCustodyPort {
  /** One read of the durable control coordinates used to bind a clear
   * operation. Unlike `current`, this also returns an unclaimed generation. */
  snapshot(scope: RuntimePrincipalScope): {
    generation: number;
    daemonInstanceId: string | null;
    cliSessionId: string | null;
  } | null;
  cliSessionId(scope: RuntimePrincipalScope): string | null;
  current(scope: RuntimePrincipalScope): RuntimePrincipal | null;
  claim(input: {
    scope: RuntimePrincipalScope;
    daemonInstanceId: string;
  }): RuntimePrincipal | null;
  finalize(input: {
    scope: RuntimePrincipalScope;
    generation: number;
    daemonInstanceId: string;
    status: 'idle' | 'crashed';
  }): RuntimePrincipal | null;
}

/** A runtime the DB still claims is live. Projection of the scoped runtime-slot
 * authority; participation is not part of this row. */
export interface DbLiveRuntime {
  scope: RuntimePrincipalScope;
  /** Last presentation target when known. AgentSlot custody itself has no
   * ambient conversation, so this is never part of identity. */
  focusConversationId: string | null;
  agentId: string;
  generation: number;
  daemonInstanceId: string | null;
  status: 'active' | 'starting';
  pid: number | null;
}

/**
 * The two persistence acts of the post-hydrate reconcile pass: ask which
 * runtimes the DB still claims are live on a host, then project a terminal
 * state for the ones the daemon's authoritative snapshot omitted. Both
 * directions sit in one facet because this pass is their only caller and
 * neither is meaningful without the other.
 */
export interface RuntimeHydrateReconcilePort {
  listDbLiveRuntimesForHost(hostId: string): DbLiveRuntime[];
  /** `status='crashed', pid=null` — the constant is in the name. `null` when
   *  the membership row is gone, which the caller skips. */
  markCrashed(runtime: DbLiveRuntime): boolean;
}

/** The roster a spawn's platform prompt is built from. */
export interface RuntimeMemberRosterPort {
  listMembers(conversationId: string): MemberDto[];
}

/**
 * Durable clear-session writes. ConversationSlot pairs the CLI-session clear
 * with its conversation audit message; AgentSlot has no conversation audit
 * surface and clears only the semantic slot. The append-only runtime event
 * stream remains runtime state history; it does not identify the actor or
 * claim to audit the user clear action.
 */
export interface RuntimeSessionTxScope {
  /** `cli_session_id=null` on the semantic runtime slot. Membership is a
   * separate placement-aware precondition; the slot is the only runtime
   * projection authority and AgentSlot has no roster row to return. */
  clearCliSession(input: {
    scope: RuntimePrincipalScope;
    expectedGeneration: number;
  }): RuntimeSessionClearReceipt | null;
  /** AgentSlot-only actor/reason audit. It is paired atomically with the
   * exact-generation clear and intentionally has no conversation coordinate. */
  insertAgentControlEvent(input: {
    agentId: string;
    generation: number;
    actorUserId: string;
    reason: 'session_cleared';
    wasRunning: boolean;
    previousCliSessionIdPrefix: string | null;
    occurredAt: number;
  }): AgentRuntimeControlEventRow;
  /** `from_kind='system'`, decided by the method rather than per call site. */
  insertSystemMessage(input: {
    conversationId: string;
    fromUserId: string | null;
    content: string;
    metadata: Record<string, unknown>;
  }): MessageDto;
}

/**
 * Persistence-minted proof that one semantic slot generation accepted the
 * clear CAS. Daemon identity is deliberately absent: the daemon is the waiter
 * authority, while the database proves settlement by generation after v77's
 * claim-lifecycle trigger makes rebinding inside a generation impossible.
 * Coordinator cleanup accepts this receipt, never the earlier dispatch token.
 */
export interface RuntimeSessionClearReceipt {
  scope: RuntimePrincipalScope;
  generation: number;
  projection: {
    status: ConversationAgentStatus;
    pid: number | null;
    cli_session_id: string | null;
  };
}

/**
 * ## Isolation obligation (R5)
 *
 * The callback contains a real authorization-read → slot-CAS → audit-write
 * invariant. No concurrent writer may change participation or slot custody
 * between those steps.
 *
 * The shipped adapter is SQLite-specific and **root-only**. It refuses when the
 * connection is already inside a transaction, because better-sqlite3 degrades
 * nested `.immediate()` to a SAVEPOINT with no writer reservation. At the root
 * it begins with `BEGIN IMMEDIATE`, so it owns the reservation before the first
 * authorization read; a competing writer fails before the callback starts.
 * The callback is synchronous and must not be given an `await`.
 *
 * A future pooled/PG adapter must supply an equivalent mechanism (for example
 * SERIALIZABLE, or explicit row/advisory locks covering both participation and
 * runtime-slot identities). A plain READ COMMITTED transaction is insufficient.
 */
export interface RuntimeSessionUnitOfWork {
  atomically<T>(fn: (scope: RuntimeSessionTxScope) => T): T;
}

/**
 * Everything durable the fanout touches, one named facet per aggregate or
 * pass. Composition builds this; the fanout never sees a driver handle.
 */
export interface RuntimeFanoutPersistence {
  inbox: RuntimeInboxCustodyPort;
  agents: RuntimeAgentReadPort;
  conversations: RuntimeConversationReadPort;
  workspaces: RuntimeWorkspaceReadPort;
  users: RuntimeUserReadPort;
  hosts: RuntimeHostReadPort;
  runtimeCustody: RuntimeCustodyPort;
  hydrateReconcile: RuntimeHydrateReconcilePort;
  session: RuntimeSessionUnitOfWork;
}
