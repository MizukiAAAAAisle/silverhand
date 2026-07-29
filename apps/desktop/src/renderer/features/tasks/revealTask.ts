/**
 * The reveal one-shot's decision contract (#task:1715).
 *
 * "Open the task board and take me to this row" is a TRANSIENT intent, not a
 * location: the pulse self-expires, so it lives in app memory and must be
 * consumed exactly once. Three separate things can go wrong, and each one is a
 * named input below rather than an implicit assumption:
 *
 * 1. RENDERABILITY. `present` must mean "in the collection this surface actually
 *    maps to DOM", not "in the unfiltered directory behind it". A board filtered
 *    by assignee holds the task in `allTasks` while rendering no row for it, so
 *    an unfiltered lookup lets the directory vouch for a DOM node that does not
 *    exist — the rAF then pulses nothing and consumes the intent (Cindy
 *    BLOCKER 10). Hence `ensure` runs FIRST for every intent: the surface makes
 *    the target renderable (widen its filters), and only the next commit's
 *    rendered set is allowed to answer `present`.
 *
 * 2. AUTHORITATIVE ABSENCE. `isLoading` cannot answer "not in the list":
 *    TanStack reports `isLoading: false` whenever a cache holds data, so a board
 *    remounting over a stale list is `isLoading: false, isFetching: true` — and a
 *    task the viewer just learned about from a chip is exactly the task that
 *    stale list lacks. Neither can `isFetching`: a list cached inside `staleTime`
 *    counts as fresh and triggers no read at all, though it can be missing a
 *    task created while no board was mounted. So absence is terminal only with
 *    POSITIVE evidence — see `nextRevealEvidence` for what counts as evidence.
 *
 * 3. TERMINATION. Every exit ends the one-shot: it either delivers, or consumes
 *    a terminal outcome. A wait state must always have something that ends it —
 *    `wait` ends when the in-flight read settles, `deliver`'s DOM lookup is
 *    bounded by `MAX_REVEAL_DOM_MISSES`, and the one authoritative read this
 *    intent asks for ends the round either way: absent on success, and
 *    `consume_read_failed` on failure. "The next successful read will rescue it"
 *    is not an invariant — the list query has no refetch interval, no
 *    refetch-on-focus, and a quiet workspace emits no frame.
 *
 * 4. EXCLUSIVITY. There is at most ONE task surface on screen. The `/tasks` rail
 *    section and the Chat/Activity task drawer are not two peers to be
 *    arbitrated: the drawer belongs to Chat/Activity, so both are functions of
 *    the same discriminant (the current rail section) and cannot be visible in
 *    the same commit — see `App`'s `drawerVisible` / `sectionVisible`, which
 *    rendering, hosting and delivery all read. So the intent carries no owner:
 *    the id reaches the visible surface, the other is handed `null`, and an
 *    invisible surface is structurally unable to deliver or consume.
 */
/**
 * A standing reveal one-shot: the target, plus whether a task surface has ever
 * actually been on screen to host it.
 *
 * `hosted` exists because an intent legitimately predates its surface — a reveal
 * from a section with no board at all (Settings, Members, Computers) navigates to
 * `/tasks`, and that navigation need not land in the same commit as the intent.
 * Voiding on the instantaneous "no surface visible" would then cancel the reveal
 * on its way to the very board it asked for. So the void is a transition —
 * hosted, then gone — rather than a snapshot, which is also the only form that
 * survives not knowing how a router batches.
 */
export interface RevealSlot {
  taskId: string | null;
  hosted: boolean;
}

export const EMPTY_REVEAL_SLOT: RevealSlot = { taskId: null, hosted: false };

/** Open a fresh one-shot. Always a full round: no previous slot's `hosted`
 *  carries over, so revealing the same id twice re-runs from the start. */
export function openRevealSlot(taskId: string): RevealSlot {
  return { taskId, hosted: false };
}

/**
 * Fold surface visibility into the slot: latch `hosted` the first time a task
 * surface is on screen, and void the intent once a surface that HAS hosted it
 * goes away (drawer closed, `/tasks` left). Returns `prev` unchanged when nothing
 * moves, so this is safe to run from an effect on every commit.
 */
export function nextRevealSlot(prev: RevealSlot, surfaceVisible: boolean): RevealSlot {
  // `hosted` never outlives its intent — every path that drops the id drops the
  // whole slot — so there is no `{ taskId: null, hosted: true }` to normalize
  // here, and no arm for it.
  if (prev.taskId === null) return prev;
  if (surfaceVisible) return prev.hosted ? prev : { ...prev, hosted: true };
  return prev.hosted ? EMPTY_REVEAL_SLOT : prev;
}

export type RevealStep =
  /** No standing intent. */
  | 'idle'
  /** Make the target renderable on this surface first (widen its filters). */
  | 'ensure'
  /** Target row is in the RENDERED set — scroll + pulse now, then consume. */
  | 'deliver'
  /** A list read is in flight; absence is not yet a fact. */
  | 'wait'
  /** Absent with no read in flight — ask for an authoritative one. */
  | 'refetch'
  /** Absent after an observed SUCCESSFUL read: terminal, consume. */
  | 'consume_absent'
  /** The one authoritative read this intent asked for FAILED. Terminal — but it
   *  asserts nothing about whether the task exists. */
  | 'consume_read_failed'
  /** In the rendered set, but its DOM node never appeared: terminal, consume. */
  | 'consume_no_row';

/** How many animation frames a delivery may look for the row before giving up. */
export const MAX_REVEAL_DOM_MISSES = 3;

export function nextRevealStep(args: {
  /** Is there a standing reveal intent for this surface? */
  revealing: boolean;
  /** Has this surface been asked to make the target renderable yet? */
  ensured: boolean;
  /** Is the target in the collection this surface RENDERS (post-filter)? */
  present: boolean;
  /** Is a list read in flight right now (`isFetching`)? */
  readInFlight: boolean;
  /** Has this intent already demanded its one authoritative read? */
  readRequested: boolean;
  /** Has a SUCCESSFUL list read landed since this intent arrived? */
  readSucceededSince: boolean;
  /** Has a FAILED list read landed since this intent arrived? */
  readFailedSince: boolean;
  /** Has the bounded DOM lookup budget been spent? */
  domBudgetSpent: boolean;
}): RevealStep {
  if (!args.revealing) return 'idle';
  // Before anything is concluded from the rendered set, the surface must have
  // been given its chance to put the target INTO that set.
  if (!args.ensured) return 'ensure';
  if (args.present) return args.domBudgetSpent ? 'consume_no_row' : 'deliver';
  if (args.readInFlight) return 'wait';
  // A success outranks a failure that also landed: positive evidence is positive
  // evidence, whatever failed around it.
  if (args.readSucceededSince) return 'consume_absent';
  if (!args.readRequested) return 'refetch';
  // One authoritative attempt per intent. If it failed, this round is over —
  // WITHOUT claiming the task doesn't exist. Anything else latches: a failed read
  // never advances the success clock, so re-deciding `refetch` forever (and being
  // suppressed by "already requested") leaves a wait with no terminator, and the
  // next click on the SAME task is not an arrival, so nothing re-runs (Cindy
  // BLOCKER 12). There is no reliable rescue to wait for either — the list query
  // has no refetch interval, `refetchOnWindowFocus` is off, and a quiet workspace
  // sends no frame to invalidate it.
  if (args.readFailedSince) return 'consume_read_failed';
  // Requested, neither clock moved yet: a real read is on its way to settling and
  // the observer will advance one of them. Not a dead end, so not terminal.
  return 'wait';
}

/**
 * Per-intent evidence. Keyed by the intent itself, so a previous reveal's
 * settled read can never vouch for this one.
 */
export interface RevealEvidence {
  /** The intent this evidence belongs to. */
  key: string | null;
  /** The list query's `dataUpdatedAt` when this intent arrived. */
  baseline: number;
  /** The list query's `errorUpdateCount` when this intent arrived. */
  errorBaseline: number;
  /** Has the surface been asked to make the target renderable? */
  ensured: boolean;
  /** Have we already demanded an authoritative read for this intent? */
  requested: boolean;
  /** Has a successful read landed since `baseline`? */
  succeeded: boolean;
  /** Has a failed read landed since `errorBaseline`? */
  failed: boolean;
  /** Failed DOM lookups so far. */
  domMisses: number;
}

export const EMPTY_REVEAL_EVIDENCE: RevealEvidence = {
  key: null,
  baseline: 0,
  errorBaseline: 0,
  ensured: false,
  requested: false,
  succeeded: false,
  failed: false,
  domMisses: 0,
};

/**
 * Fold a list-query observation into the evidence.
 *
 * The evidence axis is SUCCESS, not fetch completion. A fetching edge
 * (`wasFetching && !isFetching`) is the same shape for a fulfilled read and a
 * failed one, so using it means a 500 or a dropped connection silently vouches
 * for "that task does not exist" and eats the intent (Cindy BLOCKER 9). TanStack
 * carries the two outcomes as separate, independent facts, and both are read here
 * — success to establish absence, failure to end the round without claiming
 * anything (Cindy BLOCKER 12).
 *
 * The two axes are read differently on purpose. Success is a TIMESTAMP
 * (`dataUpdatedAt`) because the observer's result does not expose a success
 * counter (`dataUpdateCount` only feeds `isFetchedAfterMount`). Failure is the
 * monotone COUNTER (`errorUpdateCount`, incremented unconditionally on every
 * error dispatch, background refetch failures included), which is strictly
 * stronger: it cannot be missed by a settle landing in the same millisecond as
 * the baseline (Alice).
 *
 * KNOWN, BOUNDED RESIDUE — do not build a mechanism for it: because success has
 * only a timestamp, an intent whose baseline is already this millisecond's
 * success value, whose target is absent, and whose refetch then succeeds inside
 * that same millisecond, reads as "neither clock moved" and stays in `wait`. The
 * cost is a longer wait for that one round — it never misreports absence, never
 * writes state, never leaks — and its terminator is the App-level void when the
 * visible surface goes away. Removing it would take a non-reactive cache read or a
 * second clock of our own, which costs more than the cell.
 */
export function nextRevealEvidence(
  prev: RevealEvidence,
  args: {
    revealTaskId: string | null;
    dataUpdatedAt: number;
    errorUpdateCount: number;
  },
): RevealEvidence {
  if (prev.key !== args.revealTaskId) {
    return {
      ...EMPTY_REVEAL_EVIDENCE,
      key: args.revealTaskId,
      baseline: args.dataUpdatedAt,
      errorBaseline: args.errorUpdateCount,
    };
  }
  let next = prev;
  if (!next.succeeded && args.dataUpdatedAt !== next.baseline) {
    next = { ...next, succeeded: true };
  }
  if (!next.failed && args.errorUpdateCount !== next.errorBaseline) {
    next = { ...next, failed: true };
  }
  return next;
}
