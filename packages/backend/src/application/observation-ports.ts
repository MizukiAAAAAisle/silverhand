/**
 * Observation write ports (#task:1987 E) — the driver-free contract between the
 * single Attention eliminate primitive (`application/observe.ts`) and
 * persistence.
 *
 * Same discipline as `application/membership-ports.ts` /
 * `application/agent-teardown-ports.ts`: no driver types, no SQL, and the whole
 * relative import closure stays driver-free (gated by the db-boundary
 * port-contract suite).
 *
 * ## Scope: the WRITE boundary only
 *
 * E converges the bare `db.transaction` the observation batch used to open. The
 * use case's resolve phase (channel visibility, thread-root validation, stream
 * head → seq) still reads through concrete repos, and so does the post-commit
 * publish; those are #task:1983's cut, and pretending otherwise here would need
 * a read port nobody has designed yet. What this port DOES promise is that no
 * read state is written outside the scope below.
 *
 * ## The key is the VIEWER, and that is the whole authorization story
 *
 * Every row this port writes — `conversation_reads` cursors and
 * `notifications.read_at` — is keyed by viewer. No method on
 * {@link ViewerObservationTxPort} takes a user id, so clearing SOMEONE ELSE'S
 * read state is not expressible. That matters more here than on the other axes:
 * the endpoint accepts arbitrary conversation ids AND arbitrary notification ids
 * in its body, and the notification arm has no per-source pre-validation at all
 * (a foreign id is meant to be an idempotent no-op, not an error). With the face
 * bound to the key, "no-op" is a property of the mechanism instead of a `WHERE`
 * clause every future call site has to remember.
 *
 * ## Atomic, NOT serializing — and each write says why it needs no lock
 *
 * The scope is a plain (deferred) transaction: it takes no write lock at BEGIN,
 * unlike the membership / teardown axes. Those two decide from an authoritative
 * read that PRECEDES their writes, so they must hold the mechanism first.
 *
 * A pre-write read DOES exist here — {@link
 * ViewerObservationTxPort.advanceStreamCursor} reads the current cursor before it
 * decides whether to write. The claim is narrower and exact: NO correctness or
 * isolation invariant rests on that value. It only spares a redundant upsert and
 * produces the `changed` bookkeeping; the write is safe on its own terms, item by
 * item:
 *
 *  - {@link ViewerObservationTxPort.advanceStreamCursor} is MONOTONE in
 *    persistence (the cursor upsert keeps `max(existing, new)`), so a concurrent
 *    advance can never be clobbered by a lower target — including when the
 *    pre-read was already stale by the time the upsert ran. The boolean is
 *    bookkeeping — "did THIS call move it" — and both ways it can be stale are
 *    harmless: two callers that both see the old cursor each publish, and the
 *    payloads are ABSOLUTE (no increments to double-apply); a caller that sees a
 *    cursor already past its own target publishes nothing, because the observer
 *    that put it there published the strictly newer state.
 *  - {@link ViewerObservationTxPort.clearStreamMentions} and
 *    {@link ViewerObservationTxPort.clearNotification} are CONDITIONAL on the row
 *    still being unread and report only the rows they themselves flipped. A
 *    concurrent clear therefore takes those ids and fans them out itself; neither
 *    caller can claim a dismissal it did not cause, and none is lost.
 *    `clearNotification` also reads the row first, to project the badge
 *    attribution — but it acts on it only through the same conditional,
 *    viewer-scoped write, so that read decides nothing either.
 *
 * So the lock-free policy is a stated property, not an omission. A pooled /
 * PostgreSQL adapter must preserve exactly that property — keep the cursor write
 * monotone and the clears conditional — rather than "fix" it with a lock. The
 * day a rule needs more (e.g. "the cursor moved from exactly X"), the decision
 * WOULD rest on a pre-write read, and this doc, the mechanism and its inventory
 * row all have to change together.
 *
 * ## What stays outside the scope
 *
 * The per-source validation runs BEFORE it (an illegal source fails the whole
 * batch — no partial clear), and every publish runs AFTER it: one coalesced
 * `unread_updated` per changed conversation plus at most one badge variant, all
 * carrying absolute counts read post-commit. No effect capability exists inside
 * the scope by construction.
 */
import type { NotificationKind } from '@silverhand/shared';

/**
 * One resolved stream position: the cursor target for a `stream` source, already
 * validated and resolved (an `at_seq` the client pinned, or the head this stream
 * had when the batch was resolved).
 *
 * ONE type for both stream methods on purpose: the directed clear's upper bound
 * IS the seq the cursor advanced to (the §3 overlap rule), so the two calls
 * cannot drift apart into "advanced to N, cleared mentions up to M".
 */
export interface ObservedStream {
  conversationId: string;
  /** NULL = mainline; a root message id = that reply-cluster's stream. */
  threadRootId: string | null;
  targetSeq: number;
}

/**
 * What a directed clear yields. A DISCRIMINATED UNION so the facts exist only
 * when the row was actually flipped by THIS call: attributing a badge (or a
 * dismissal) to a notification this batch did not clear — someone else's row, an
 * unknown id, an already-read row — is not expressible.
 *
 * `kind` is the RAW row kind, not a "feeds the badge" boolean: which kinds carry
 * the badge's directed term (only `mention_self` today) is a domain rule and
 * stays in the use case, where its tests can see it.
 */
export type NotificationClearOutcome =
  | { cleared: false }
  | {
      cleared: true;
      kind: NotificationKind;
      /**
       * The workspace of the row's CONVERSATION anchor, resolved in the same
       * scope — the axis the badge's positional term groups by, so the directed
       * term must attribute the same way or one workspace's badge would split
       * across two groupings. Null when the notification is anchorless
       * (`agent_start_failed`) or its conversation is gone: either way there is
       * no badge to move.
       */
      anchorWorkspaceId: string | null;
    };

/**
 * The in-transaction face, bound to the viewer the enclosing scope coordinated
 * on (see the module doc).
 *
 * Advancing the cursor and clearing the stream's mentions are deliberately TWO
 * methods, not one `observeStream()`: the overlap rule is that a positional
 * clear folds in the directed clear EVEN WHEN THE CURSOR DID NOT MOVE (a
 * lingering mention at or below the cursor is still a real change), and that is a
 * domain rule. Merging them would bury it in persistence, where no test of the
 * use case could see it.
 */
export interface ViewerObservationTxPort {
  /** Advance this stream's cursor to {@link ObservedStream.targetSeq}. Monotone:
   *  a cursor already past the target is left alone. Returns whether THIS call
   *  moved it — the use case's "something changed" bookkeeping, nothing more. */
  advanceStreamCursor(stream: ObservedStream): boolean;
  /** Mark the viewer's `mention_self` notifications in this stream read up to
   *  and including the target seq. Returns the ids it flipped unread→read (the
   *  caller fans exactly those out to the OS-dismiss projection), so an
   *  already-read mention yields nothing. */
  clearStreamMentions(stream: ObservedStream): string[];
  /** Clear ONE of the viewer's notifications by id. A foreign / unknown /
   *  already-read id is an idempotent `{cleared: false}`, never an error. */
  clearNotification(notificationId: string): NotificationClearOutcome;
}

export interface ObservationTxScope {
  viewer: ViewerObservationTxPort;
}

/** Whose read state this transaction may clear. */
export interface ObservationKey {
  viewerUserId: string;
}

/**
 * The atomic write boundary for one observation batch: every source in the batch
 * commits together or not at all, so the §3 overlap (a positional clear folding
 * in the directed one) can never be half-applied and leave the non-derived
 * notification badge as a second truth.
 *
 * Atomicity only — no isolation claim, by design and with a per-write
 * justification in the module doc.
 */
export interface ObservationUnitOfWork {
  atomicallyForViewer<T>(
    key: ObservationKey,
    fn: (tx: ObservationTxScope) => T,
  ): T;
}

export interface ObservationPersistence {
  uow: ObservationUnitOfWork;
}
