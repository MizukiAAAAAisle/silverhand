/**
 * Agent-provisioning ports (#task:1990) — the driver-free contract between the
 * create-agent transactions and persistence.
 *
 * Same discipline as `application/membership-ports.ts` / `services/channel/ports.ts`:
 * no driver types, no SQL, and the whole relative import closure of this module
 * stays driver-free (gated by the db-boundary port-contract suite).
 *
 * ## What this scope covers
 *
 * TWO units of work, independent, and only the second one atomic
 * (spec §5 note / §2.2):
 *
 * 1. the ROW reserve — {@link AgentProvisioningPersistence.reserveAgentRow}
 *    writes the `agents` row. One statement, its own commit;
 * 2. the DEPENDENT GRAPH —
 *    `create-agent.ts::insertProvisioningDependents` flips a
 *    `pending_materialization` agent to `active` and inserts everything that
 *    exists only BECAUSE the daemon materialized a home on disk. What that is
 *    depends on the agent's session scope (#task:2034): the CONVERSATION arm
 *    builds the agent-home workspace, the onboarding DM channel + both
 *    membership edges, the owner-human membership/pointer, and the onboarding
 *    system message; the AGENT arm has no home and no DM, so its graph is its
 *    direct line with the CREATOR plus the onboarding message in it.
 *    All of those writes plus the authoritative re-read the workspace insert
 *    needs are the faces below.
 *
 * The split is the lifecycle: `pending_materialization | active | failed` are all
 * legal states of an Agent, and only (2) is conditional on materialization
 * succeeding.
 *
 * (1) USED TO BE AN AGGREGATE and is not one any more (#task:2072). It paired the
 * row with an `agent_inbox` placement, because a handle is addressable from the
 * instant it is reserved and the mention CC of the day copied INTO that inbox —
 * so a `pending_materialization` or `failed` row needed a destination it could not
 * mint for itself. The CC now copies into the AUTHOR's direct line with the agent
 * and mints that line at the send boundary, so a bare row is a complete Agent: the
 * destination is a function of the sender, not a possession of the agent. What is
 * left is one INSERT, and the reason it is still its own commit is unchanged — the
 * L2 materialize dispatch depends on the row being durable before it runs.
 *
 * ## Atomicity, not isolation — but the conditional transition IS the gate
 *
 * This UnitOfWork promises **atomicity only**, and `atomically` is deliberately
 * **deferred, unkeyed, and without BEGIN IMMEDIATE**: the saga's single-winner
 * property comes from CONDITIONAL writes — the reserve INSERT on a fresh key,
 * `flipFailedToReserveAgain`'s `UPDATE … WHERE status='failed'` on a retry, and
 * the FIRST statement inside the callback:
 * {@link AgentProvisioningAgentsTxPort.flipToActiveAndGet}'s
 * `UPDATE … WHERE materialization_status = 'pending_materialization'`.
 *
 * That last conditional transition is the callback's read-then-write gate:
 * `pending_materialization` is the ONLY legal pre-state of the provisioning
 * operation. A row that is `active` already has its graph (a second run must
 * never build a second one), and a row that is `failed` lost to a concurrent
 * transition — BOTH are `lost` eligibility. The mechanism is the conditional
 * write itself (the matched-row count), not a write lock, so this stays
 * deferred — a pooled/PG adapter owes the SAME conditional semantics, never an
 * unconditional flip.
 *
 * ## Losing eligibility is NOT a failure of this transaction
 *
 * When `flipToActiveAndGet` returns `lost`, another transition already won
 * (the row is failed under a DIFFERENT authoritative code, or active with a
 * complete graph). The caller MUST NOT run L3b compensation: overwriting the
 * row with `dependent_row_insert_failed` would erase the winner's terminal
 * stamp. The use case routes `lost` to a distinct control flow that re-reads
 * the row and reports its actual state — the loser never compensates the
 * winner.
 *
 * ## R4 — return only what the caller uses
 *
 * Every face returns the MINIMAL projection the callback or the post-commit
 * effects actually consume, not a full physical row or even a full DTO:
 *  - `flipToActiveAndGet` returns `{ status:'transitioned', row:{id,name} }`
 *    (the only fields `insertAgentHome` needs) or `{ status:'lost' }`;
 *  - `workspaces.insertAgentHome` / `conversations.insertDmChannel` /
 *    `messages.insertForConversation` return `{ id }` — downstream
 *    (`successFromInserted`, post-commit deliver/start) consumes only ids;
 *  - `addOwnerMember` / `setOwnerUserId` / `addAgent` / `addUser` return `void` —
 *    the callback ignores their DTO returns today, so a future caller gets
 *    nothing to accidentally depend on.
 *
 * ## Savepoint semantics
 *
 * Under SQLite the callback may nest operations that open their own
 * transactions (`MessageRepo.insertForConversation`'s seq + stream-head bump,
 * `WorkspaceRepo.setOwnerUserId`'s owner-pointer + role flip). Inside this
 * `db.transaction` those become savepoints — pre-existing behavior preserved
 * exactly. A pooled/PG adapter must run the same statements on the TX client
 * without opening new transactions.
 */

import type {
  AgentRow,
  CanonicalConversationTitle,
  ConversationEndpointIdentity,
  CreateAgentInput,
} from '@silverhand/shared';

/** The agent face: the conditional transition and the authoritative re-read
 *  that follows it, as ONE operation. */
export interface AgentProvisioningAgentsTxPort {
  /**
   * L1 reserve — INSERT the `agents` row in `pending_materialization`. Returns
   * the reserved row because the row (never the request body) is the source of
   * truth for the wire intent that follows.
   *
   * Exposed on the tx scope because {@link AgentProvisioningPersistence.reserveAgentRow}
   * is composed from the same faces as the dependent graph, not because the
   * reserve needs a transaction: it is one statement.
   */
  reserveForMaterialize(args: {
    input: CreateAgentInput;
    defaultHostId: string;
    createdByUserId: string;
    idempotencyKey: string;
  }): AgentRow;
  /**
   * Flip `pending_materialization` → `active` (clears failure stamps) AND
   * return the minimal `{id, name}` projection of the row.
   *
   * Returns `{ status:'lost' }` when the conditional UPDATE matched NO row:
   * the agent is no longer `pending_materialization` — it is `active` (another
   * winner already built the graph), `failed` (another transition won with its
   * own stamp), or vanished. The caller MUST treat `lost` as "another
   * transition already won" — fail closed BEFORE any dependent write, and do
   * NOT run compensation that would overwrite the winner's terminal state.
   *
   * The `WHERE materialization_status = 'pending_materialization'` guard is
   * what makes the transition conditional and single-winner; the `lost` result
   * is what makes the condition observable to the callback. A pooled/PG adapter
   * must keep this same conditional semantics (the UPDATE's matched-row count
   * decides), not a blind unconditional flip.
   */
  flipToActiveAndGet(id: string): AgentProvisioningFlipOutcome;
}

/** Outcome of the provisioning's conditional transition. */
export type AgentProvisioningFlipOutcome =
  | {
      status: 'transitioned';
      row: { id: string; name: string; sessionScope: 'agent' | 'conversation' };
    }
  | { status: 'lost' };

/** The workspace face: the agent-home row and the owner-human stamping. */
export interface AgentProvisioningWorkspacesTxPort {
  /** Insert the `agent_home` workspace for the agent. Returns only its id. */
  insertAgentHome(args: { agent: { id: string; name: string } }): { id: string };
  /** Insert the owner-human membership row. OWNER-ONLY semantics: the role is
   *  fixed by the adapter, not an argument — a provisioning callback has no
   *  business granting `member`/`admin` on the agent's own home. */
  addOwnerMember(workspaceId: string, userId: string): void;
  /** Stamp `workspaces.owner_user_id` + promote the role row to `owner`. */
  setOwnerUserId(workspaceId: string, userId: string): void;
}

/** The conversation face: the onboarding DM channel and its two edges, plus the
 *  creator's direct line the agent-scoped arm onboards into. */
export interface AgentProvisioningConversationsTxPort {
  /** Insert the DM channel under the (already-inserted) agent-home workspace.
   *  Returns only its id — the edges below and the message insert key off it.
   *
   *  The title IS the channel's address in the new home (#task:2016), which is
   *  why it arrives as the canonical pair rather than a bare string. No conflict
   *  is possible here — the home was created empty by `insertAgentHome`, two
   *  statements earlier in this transaction. */
  insertDmChannel(args: {
    workspaceId: string;
    title: CanonicalConversationTitle;
    agentId?: string | null;
  }): { id: string };
  /**
   * Get-or-create the `direct_pair` for these two endpoints — the AGENT-SCOPED
   * arm's onboarding destination: the creator's direct line with the new agent
   * (#task:2072).
   *
   * The member name, the argument order and the `created` flag are
   * `DirectPairMintPort`'s (`application/open-direct-pair.ts`) so that this face
   * can be handed to `openDirectPair` verbatim. That matters more than it looks:
   * the mint and its `direct_pairs_changed` announcement are ONE operation there,
   * and reaching the mint means holding the announcement capability. A second
   * hand-rolled mint here would be a door that can forget to announce, which is
   * the whole of #task:2035.
   *
   * WRITTEN INSIDE THE DEPENDENT GRAPH, not beside the `agents` row: it is needed
   * only by the write that consumes it (the onboarding message), so it belongs to
   * the same atomicity — a line that outlived a rolled-back graph would be an
   * empty conversation in the creator's DM list. Get-or-create rather than insert
   * for the same reason it is safe under `?retry=true`: the creator may already
   * have a line with this agent (they could have mentioned it while it was still
   * `pending_materialization`), and that line is the destination, not a conflict.
   */
  getOrCreateDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
    now: number,
  ): { conversation: { id: string }; created: boolean };
  /** Owner-agent edge on the DM. */
  addAgent(conversationId: string, agentId: string): void;
  /** Owner-human edge on the DM. */
  addUser(conversationId: string, userId: string): void;
}

/** The message face: the onboarding system message. */
export interface AgentProvisioningMessagesTxPort {
  /** Insert the onboarding system message. Returns only its id (the
   *  post-commit deliver effect needs it). */
  insertForConversation(args: {
    conversationId: string;
    fromKind: 'system';
    content: string;
    metadata?: Record<string, unknown> | null;
  }): { id: string };
}

/** The transaction-scoped capability bundle. ALL persistence inside an
 *  `atomically` callback MUST come from this scope — never a captured factory
 *  repo (a future pooled adapter would read/write on the wrong connection). No
 *  effect capability exists here BY CONSTRUCTION: external effects (daemon
 *  deliver / start) run post-commit in the use case. */
export interface AgentProvisioningTxScope {
  agents: AgentProvisioningAgentsTxPort;
  workspaces: AgentProvisioningWorkspacesTxPort;
  conversations: AgentProvisioningConversationsTxPort;
  messages: AgentProvisioningMessagesTxPort;
}

/** Atomic write boundary for the provisioning dependent-graph. Atomicity only —
 *  see the module doc for why there is no key and no write-lock policy. */
export interface AgentProvisioningUnitOfWork {
  atomically<T>(fn: (tx: AgentProvisioningTxScope) => T): T;
}

export interface AgentProvisioningPersistence {
  uow: AgentProvisioningUnitOfWork;
  /**
   * L1 reserve, as its own commit: INSERT the `agents` row in
   * `pending_materialization`.
   *
   * Its own commit because the L2 materialize dispatch depends on the row being
   * durable before it runs — NOT because two rows have to move together. It used
   * to be the AGENT AGGREGATE FACTORY, pairing the row with an `agent_inbox`
   * placement in one transaction; #task:2072 retired the inbox, and with it the
   * only reason a reserved row needed anything beside it (see the module doc).
   *
   * Still a named operation on this face rather than a bare
   * `agents.reserveForMaterialize` at the call site: the use case holds ports, not
   * repos, and "the reserve is one statement" is a fact about the ADAPTER — a
   * pooled/PG implementation is free to need more, and would have nowhere honest
   * to put it if the use case reached past this face.
   */
  reserveAgentRow(args: {
    input: CreateAgentInput;
    defaultHostId: string;
    createdByUserId: string;
    idempotencyKey: string;
  }): AgentRow;
}
