/**
 * Agent / computer teardown ports (#task:1987 D) — the driver-free contract
 * between the two destructive cascades (`DELETE /api/agents/:id`,
 * `DELETE /api/hosts/:id`) and persistence.
 *
 * Same discipline as `application/membership-ports.ts`: no driver types, no
 * SQL, and the whole relative import closure stays driver-free (gated by the
 * db-boundary port-contract suite).
 *
 * ## Per-phase minimal facts, never one "impact DTO"
 *
 * This replaces `read-model/agent-delete-impact.ts`, which computed ONE wide
 * object (workspace lists, message/attachment counts, a pending-inbox count, a
 * named DM-channel window) for every caller — five of its fields had no consumer
 * at all, and the two counts existed only because the shape looked like a
 * preview payload. It is deliberately NOT replaced by a narrower DTO of the same
 * kind: each face below declares exactly the facts ONE phase consumes.
 *
 *  - {@link AgentTeardownFacts} — what the pre-transaction dispatch (status),
 *    the host-local purge (routing) and the logs (name) read, plus what the
 *    computer cascade's `has_dependents` refusal projects.
 *  - {@link AgentRuntimeSessionFacts} — `(conversation, status)` pairs. The
 *    adapter projects the status; deciding WHICH statuses are "running" is a
 *    domain rule and stays in the use case.
 *  - {@link AgentTeardownCapture} — the post-commit facts whose source rows the
 *    transaction itself deletes: runtime pairs to stop, DM blob refs to sweep,
 *    and the two log counts.
 *
 * No physical row and no repo DTO crosses this boundary, so a column added to
 * `agents` / `workspaces` / `conversations` cannot silently become an input to a
 * delete decision.
 *
 * ## ONE UnitOfWork, two coordination axes, one capture semantics
 *
 * Deleting one agent and deleting the computer that agent sits on destroy the
 * SAME rows. They therefore share one mechanism and one implementation of
 * {@link AgentTeardownTxPort}: the single-agent axis keys on the agent
 * ({@link AgentTeardownUnitOfWork.atomicallyForAgent}), the computer axis keys
 * on the (host, owner) pair ({@link AgentTeardownUnitOfWork.atomicallyForComputer})
 * and reaches each of ITS agents through {@link ComputerTeardownTxPort.forAgent},
 * which hands back that very same face. A non-transactional shortcut for the
 * single-agent path is not expressible here — the only way to delete an agent row
 * is inside one of the two scopes.
 *
 * ## Every scope re-reads eligibility; nothing decides from a pre-lock snapshot
 *
 * Both cascades must read facts BEFORE the transaction: the single-agent path
 * dispatches on materialization status and purges host-local files fail-closed
 * (a purge inside the write lock would put remote IO in it and destroy bytes for
 * a request that then rolls back), and the computer path answers `not_found` /
 * `provisioning_source_not_supported` without taking a write lock to say no.
 * Those reads are {@link AgentTeardownReadPort} — pre-flight HINTS, never the
 * decision.
 *
 * The authoritative facts are re-read INSIDE the scope, under the mechanism:
 * {@link AgentTeardownTxPort.readFacts} for status/eligibility and
 * {@link ComputerTeardownTxPort.listAgentsForUpdate} for host membership. A
 * cascade that trusted the pre-purge snapshot would delete an agent that moved
 * to another computer meanwhile, or tear down a row whose materialization
 * restarted.
 *
 * ## What D does NOT promise (#task:1988)
 *
 * The scope's atomicity covers CONTROL-PLANE ROWS and the capture taken from the
 * same snapshot. Host-local file purge stays outside it (before the commit on the
 * single-agent path, after it on the computer path) and the blob sweep runs
 * post-commit off {@link AgentTeardownCapture.dmBlobRefs}. So the purge→commit
 * window can leave regenerated host-local files, and a post-commit sweep failure
 * leaves blobs with no row left to name them. Both are named residuals of
 * #task:1988, not properties this UnitOfWork claims.
 */
import type {
  AgentMaterializationStatus,
  ConversationAgentStatus,
  HostKind,
  HostProvisioningSource,
  RuntimeKind,
} from '@silverhand/shared';
import type { StoredFileRef } from '../storage/blob-file-storage.js';

/**
 * The agent facts a teardown consumes — one projection, every field with a named
 * consumer:
 *  - `materializationStatus`: the dispatch (pending → refuse, failed → row-only,
 *    active → full cascade) and the in-scope eligibility re-read;
 *  - `hostId`: the host-local purge's ROUTING, the fact the in-scope eligibility
 *    re-read compares it against, and the post-commit runtime stop's routing on
 *    BOTH paths (by then no `agents` row is left to resolve it from);
 *  - `id` / `name` / `displayName` / `runtime`: the summary logs and the
 *    computer cascade's `has_dependents` projection;
 *  - `failedCode`: the row-only delete's log line.
 * Deliberately NOT an `AgentDto`: model, avatar, reasoning effort and idempotency
 * key are not inputs to a delete.
 */
export interface AgentTeardownFacts {
  id: string;
  name: string;
  displayName: string;
  runtime: RuntimeKind;
  hostId: string;
  materializationStatus: AgentMaterializationStatus;
  failedCode: string | null;
  deletionStartedAt: number | null;
}

export interface AgentDeletionAttempt {
  agentId: string;
  hostId: string;
  deletionStartedAt: number;
}

export type BeginAgentDeletionResult =
  | { kind: 'started'; attempt: AgentDeletionAttempt }
  | { kind: 'alreadyPending'; attempt: AgentDeletionAttempt }
  | { kind: 'notFound' }
  | { kind: 'notActive' }
  | { kind: 'runtimeTransitionInProgress' };

export type CompleteAgentDeletionResult =
  | { kind: 'gone' }
  | { kind: 'attemptLost' }
  | {
      kind: 'committed';
      facts: AgentTeardownFacts;
      capture: AgentTeardownCapture;
    };

export interface AgentDeletionLifecyclePort {
  /** Short IMMEDIATE CAS; no remote IO may run inside it. */
  begin(agentId: string, startedAt: number): BeginAgentDeletionResult;
  /** Boot discovery only. Dispatch starts after transport attachment/ready. */
  listPending(): AgentDeletionAttempt[];
  /** Short IMMEDIATE CAS keyed by attempt token + host + active status. */
  complete(attempt: AgentDeletionAttempt): CompleteAgentDeletionResult;
}

/**
 * One `(conversation, agent)` runtime row, with its RAW status. The adapter must
 * not filter: "which statuses are still running" is a domain rule (the control
 * view deliberately includes archived channels — see
 * `AgentRepo.listRuntimeConversations`), and a persistence-side filter would put
 * that rule where no test of the use case can see it.
 */
export interface AgentRuntimeSessionFacts {
  conversationId: string;
  status: ConversationAgentStatus;
}

/**
 * Everything the POST-COMMIT teardown needs, captured inside the scope because
 * the same transaction deletes every row it derives from.
 *
 * `dmBlobRefs` is why this cannot be recomputed afterwards: the storage key
 * lives on the `attachments` row, which cascades away with the agent's home.
 * `runtimeSessions` is the AUTHORITATIVE live-child set for both axes, and on
 * BOTH it is stopped IN FULL: the single-agent path does NOT subtract the pairs
 * its pre-commit phase already acked, because a `(conversation, agent)` pair is
 * an identity and not a generation — the same pair may name a child that spawned
 * after that ack, and this capture reads `active` either way. Re-stopping is
 * sound because `runtime_stop` is idempotent by daemon contract (unknown handle /
 * already exited → success with `stopped: false`). The two counts are log-only
 * facts — the log is the only place a residue-leaving best-effort phase can be
 * accounted for.
 */
export interface AgentTeardownCapture {
  runtimeSessions: AgentRuntimeSessionFacts[];
  dmBlobRefs: StoredFileRef[];
  /** The agent's own DM channel, for the summary log. Null when it owns no home. */
  dmChannelId: string | null;
  /** How many regular workspaces the FK cascade removes this agent from (log-only). */
  regularWorkspaceCount: number;
}

/** The computer facts the pre-flight refusals read: ownership and whether this
 *  computer's lifecycle is user-managed at all. */
export interface ComputerTeardownFacts {
  id: string;
  userId: string | null;
  kind: HostKind;
  provisioningSource: HostProvisioningSource;
}

/**
 * Read-only face, safe OUTSIDE a transaction — and only ever a HINT. Every
 * decision these facts inform is re-taken inside the scope
 * ({@link AgentTeardownTxPort.readFacts},
 * {@link ComputerTeardownTxPort.listAgentsForUpdate},
 * {@link ComputerTeardownTxPort.deleteComputerRow}'s own conditional WHERE).
 */
export interface AgentTeardownReadPort {
  /** Pre-flight dispatch + purge routing. Null when the id is unknown. */
  readAgentFacts(agentId: string): AgentTeardownFacts | null;
  isDeletionPending(agentId: string): boolean;
  /** Pre-commit stop list for the single-agent path — a HINT like the rest of
   *  this face: {@link AgentTeardownCapture.runtimeSessions} is the authoritative
   *  live set and is re-stopped in full afterwards, so a pair this one stopped
   *  early is stopped again rather than trusted (raw statuses; see the type). */
  listRuntimeSessions(agentId: string): AgentRuntimeSessionFacts[];
  /** Pre-flight ownership / lifecycle refusals for the computer path. */
  readComputerFacts(hostId: string): ComputerTeardownFacts | null;
}

/**
 * The in-transaction face for ONE agent, bound to the agent the enclosing scope
 * coordinated on: no method takes an agent id, so tearing down an agent the
 * transaction did not coordinate on is not expressible.
 *
 * The SAME interface serves both axes — the single-agent scope carries one
 * ({@link SingleAgentTeardownTxScope.agent}) and the computer scope mints one per
 * host agent ({@link ComputerTeardownTxPort.forAgent}). That identity is the
 * point: a computer cascade cannot capture or delete differently from a
 * single-agent delete, because there is only one implementation to differ from.
 */
export interface AgentTeardownTxPort {
  /**
   * The AUTHORITATIVE facts, read under the mechanism. Null means the row is
   * gone (a concurrent delete won). The caller compares them against what its
   * pre-flight ALREADY ACTED ON and refuses when either moved:
   *  - `materializationStatus`: a row that left `active`, or arrived at `active`
   *    from `failed`, has had a provisioning transition since — its stop/purge
   *    sequence was decided for a state that no longer holds;
   *  - `hostId`: the single-agent path purged one computer's tree before taking
   *    the lock, so a row now placed elsewhere would be deleted while its CURRENT
   *    computer keeps the files (the computer path gets this for free — its
   *    cascade set comes from `listAgentsForUpdate`, which is keyed on the host).
   */
  readFacts(): AgentTeardownFacts | null;
  /** Capture the post-commit facts (see {@link AgentTeardownCapture}). Read-only:
   *  it must be safe to call before a later precondition rolls the scope back. */
  capture(): AgentTeardownCapture;
  /**
   * Delete the `agents` row. Every dependent row goes with it BY FOREIGN KEY —
   * `workspace_members` (and `workspace_agent_capabilities` transitively through
   * its composite FK), `conversation_agents`, `conversation_inboxes`, and the
   * owned `agent_home` workspace with its conversations, messages and
   * attachments. The adapter owes that cascade as a PERSISTENCE CONTRACT
   * (`tests/repos/agent-teardown-persistence.test.ts` pins it on the real
   * adapter; a future engine must re-run the same contract), which is why the
   * domain no longer walks memberships and conversations itself.
   */
  deleteAgentRow(): void;
}

/** The single-agent scope: the key IS the agent, so the face is already bound. */
export interface SingleAgentTeardownTxScope {
  agent: AgentTeardownTxPort;
}

/**
 * The computer scope. `forAgent` is the ONE place an id names something the key
 * does not, so it carries the binding rule (same as membership's
 * conversation→workspace check): an agent that this host does not currently own
 * is a coordination violation and THROWS, which aborts the whole scope. A cascade
 * cannot lock one computer and delete another computer's agent.
 */
export interface ComputerTeardownTxPort {
  /** The host's agents, read under the mechanism — the authoritative cascade set
   *  the refusals are decided from and the deletes act on. */
  listAgentsForUpdate(): AgentTeardownFacts[];
  /** The per-agent teardown face, bound to `agentId`. Throws when the agent is
   *  not on the coordinated host (see the interface doc). */
  forAgent(agentId: string): AgentTeardownTxPort;
  /**
   * Delete the coordinated computer's `hosts` row. CONDITIONAL by contract — it
   * matches only a `remote` / `user_invite` host owned by the key's user — so
   * `false` means "not deletable by this request" (deleted concurrently, or
   * never user-managed) and the caller rolls back rather than reporting a
   * success it did not cause.
   */
  deleteComputerRow(): boolean;
}

export interface ComputerTeardownTxScope {
  computer: ComputerTeardownTxPort;
}

/** Which agent this transaction may tear down. */
export interface AgentTeardownKey {
  agentId: string;
}

/** Which computer this transaction may tear down, and for whom. The owner is
 *  part of the key because the delete is conditional on it — see
 *  {@link ComputerTeardownTxPort.deleteComputerRow}. */
export interface ComputerTeardownKey {
  hostId: string;
  userId: string;
}

/**
 * The atomic write boundary for both cascades. Atomic AND serializing: each
 * scope decides from an authoritative read that PRECEDES its writes (eligibility,
 * host membership), so the mechanism must be held before the callback's first
 * statement — a deferred BEGIN would take the lock at the first WRITE, after the
 * read it is supposed to protect.
 *
 * Per engine:
 *  - SQLite (this repo): root-only `BEGIN IMMEDIATE` on both axes. The write lock
 *    is file-wide, so the two axes already exclude each other with nothing extra
 *    — which is exactly why they must not diverge into two mechanisms. Nested use
 *    is refused loudly: inside an open transaction `.immediate()` degrades to a
 *    savepoint that takes no lock, and the in-scope re-read would rest on nothing.
 *  - Pooled / PostgreSQL: the two axes must take mechanisms that exclude each
 *    other, and the single-agent axis's lock must be derivable from the COMPUTER
 *    half too (`FOR UPDATE` on the agent's `hosts` row, or
 *    `pg_advisory_xact_lock` over the host id) — a lock on the `agents` row alone
 *    would let a computer cascade and a single-agent delete run concurrently on
 *    the same row set. Locking the agent row in addition is fine; it may not be
 *    what the two scopes agree on. The obligation is SYMMETRIC: it also binds the
 *    ROW the cascade deletes at the root (`agents` / `hosts`), because a lock
 *    taken on a row that is then deleted must still order the two writers.
 *
 * No effect capability exists in either scope BY CONSTRUCTION: runtime stops,
 * the host-local purge, the blob sweep and every publish live in the use cases,
 * outside the transaction.
 */
export interface AgentTeardownUnitOfWork {
  atomicallyForAgent<T>(
    key: AgentTeardownKey,
    fn: (tx: SingleAgentTeardownTxScope) => T,
  ): T;
  atomicallyForComputer<T>(
    key: ComputerTeardownKey,
    fn: (tx: ComputerTeardownTxScope) => T,
  ): T;
}

export interface AgentTeardownPersistence {
  read: AgentTeardownReadPort;
  uow: AgentTeardownUnitOfWork;
  deletion: AgentDeletionLifecyclePort;
}
