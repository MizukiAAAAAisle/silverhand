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
 * TWO units of work, both atomic and independent (spec §5 note / §2.2):
 *
 * 1. the AGGREGATE reserve —
 *    {@link AgentProvisioningPersistence.reserveAgentAggregate} writes the
 *    `agents` row plus its inbox placement (v71 §4.2), the pair that makes an
 *    Agent exist at all;
 * 2. the DEPENDENT GRAPH —
 *    `create-agent.ts::insertProvisioningDependents` flips a
 *    `pending_materialization` agent to `active` and inserts everything that
 *    exists only BECAUSE the daemon materialized a home on disk: the agent-home
 *    workspace, the onboarding DM channel + both membership edges, the
 *    owner-human membership/pointer, and the onboarding system message. All of
 *    those writes plus the authoritative re-read the workspace insert needs are
 *    the faces below.
 *
 * The split is the lifecycle: `pending_materialization | active | failed` are all
 * legal states of an Agent, and only (2) is conditional on materialization
 * succeeding. Putting the inbox in (2) would give a `failed` row no destination
 * for a mention of its already-reserved handle, and would make a retry insert a
 * second inbox for a row that already has one.
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

import type { AgentRow, CreateAgentInput } from '@silverhand/shared';

/** The agent face: the conditional transition and the authoritative re-read
 *  that follows it, as ONE operation. */
export interface AgentProvisioningAgentsTxPort {
  /**
   * L1 reserve — INSERT the `agents` row in `pending_materialization`. Returns
   * the reserved row because the row (never the request body) is the source of
   * truth for the wire intent that follows.
   *
   * Reachable only through {@link AgentProvisioningPersistence.reserveAgentAggregate},
   * which pairs it with the inbox insert; the port exposes it on the tx scope so
   * that pairing is a transaction and not a convention.
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
  | { status: 'transitioned'; row: { id: string; name: string } }
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

/** The conversation face: the onboarding DM channel, its two edges, and the
 *  agent's inbox placement. */
export interface AgentProvisioningConversationsTxPort {
  /** Insert the DM channel under the (already-inserted) agent-home workspace.
   *  Returns only its id — the edges below and the message insert key off it. */
  insertDmChannel(args: {
    workspaceId: string;
    title: string;
    agentId?: string | null;
  }): { id: string };
  /**
   * Insert the agent's INBOX placement (v71, §4.2) — part of the Agent
   * aggregate, so it is written in the SAME transaction as the `agents` row
   * ({@link AgentProvisioningPersistence.reserveAgentAggregate}), never lazily by
   * whatever first needs it. The mention CC depends on this row existing and
   * refuses to create one (`AgentInboxMissingError`): a get-or-create is exactly
   * what let two `Mentions` DMs exist for one agent.
   *
   * NOT part of the dependent graph below: `pending_materialization` and
   * `failed` rows own an inbox too (the mention resolver answers for them), and a
   * retry that re-ran this insert would collide with the inbox its own first
   * attempt already committed.
   *
   * Takes the owner and the owner's `created_at`: the inbox has no workspace, no
   * roster edge, no caller-chosen title and no visibility — `inbox_agent_id` is
   * its whole identity, and the DB's arc CHECK plus
   * `idx_conversations_inbox_agent` make both facts schema-level. The timestamp
   * is the agent's, so aggregate birth reads the same on an upgraded DB as on a
   * fresh create. Returns `{ id }` like its siblings (R4).
   */
  insertAgentInbox(agentId: string, createdAt: number): { id: string };
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
   * The AGENT AGGREGATE FACTORY (v71): the `agents` row and its inbox, in one
   * transaction. This is the only way an Agent comes into existence — the row
   * alone is not an Agent, because the mention resolver can address the handle
   * from the instant it is reserved and `requireAgentInbox` refuses to repair a
   * missing destination.
   *
   * A named operation rather than an inline `atomically` at the call site: the
   * atomicity is the aggregate's rule, so it belongs to the thing that owns the
   * aggregate, and a second caller (a test fixture, a future import path) gets
   * the invariant by calling this instead of re-deriving it. `AgentRepo`'s own
   * `reserveForMaterialize` writes a bare row and is NOT that factory.
   */
  reserveAgentAggregate(args: {
    input: CreateAgentInput;
    defaultHostId: string;
    createdByUserId: string;
    idempotencyKey: string;
  }): AgentRow;
}
