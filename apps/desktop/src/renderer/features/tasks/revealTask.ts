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
 * 1b. LOADEDNESS. Since the board reads a bounded window of an authority page
 *    face (#task:1885), "not in this surface's rows" has a third meaning that is
 *    not absence at all: the row is in a page the surface has not fetched yet. A
 *    successful read of page 1 is positive evidence about page 1 only, so the
 *    evidence rules below would otherwise let it vouch for a task sitting on page
 *    7. Hence two separate progress inputs: `canWiden` (the row IS loaded, just
 *    past this surface's window — a local write reaches it and no read is
 *    involved) and `canFetch` (the target's column may still hold pages the
 *    server has not sent). Absence is only concluded once the column is exhausted
 *    (`next_cursor === null` — the only end-of-column signal the face has).
 *
 * 1c. WHOSE ANSWER. Evidence is not board-wide. The success that backs "this task
 *    does not exist" must come from THE TARGET'S COLUMN UNDER THE CURRENT
 *    FILTER/QUERY IDENTITY, which is what `authorityKnown` and the re-baselining
 *    in `nextRevealEvidence` enforce (Cindy MUST FIX). Three ways the older
 *    board-wide reading was wrong, all reachable: `ensure` swaps every column's
 *    query key, and the replacement query's `dataUpdatedAt: 0` differs from the
 *    baseline, so a QUERY SWAP read as a fresh success; a max/sum across five
 *    columns let a sibling column's success outrank the target column's failure;
 *    and a target column that cannot answer at all (its status is not known yet)
 *    left the round with no candidate but a passing clock.
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
 *    is not an invariant — the column query has no refetch interval, no
 *    refetch-on-focus, and a quiet workspace emits no frame. Paging is bounded by
 *    the same rule: a FAILED page ends the round instead of asking for the next
 *    one, because the last successful page's `next_cursor` survives the failure —
 *    "there is more to fetch" therefore stays true forever, and a paging arm
 *    ordered ahead of the failure arm walks that cursor in an endless loop (Cindy
 *    MUST FIX).
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
  /** The row IS loaded, just past this surface's window: widen the window over it.
   *  Involves no read, so no read failure may stand in its way. */
  | 'widen'
  /** Not loaded, and the target's column may still hold pages the server has not
   *  sent. Fetch one more page of it and look again — not terminal, and it spends
   *  no DOM budget. */
  | 'page'
  /** A read this round depends on is in flight; absence is not yet a fact. */
  | 'wait'
  /** Absent with no read in flight — ask for an authoritative one. */
  | 'refetch'
  /** Absent after an observed SUCCESSFUL read of the target's own column: terminal,
   *  consume. */
  | 'consume_absent'
  /** A read this round depends on FAILED. Terminal — but it asserts nothing about
   *  whether the task exists. */
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
  /**
   * Is the target LOADED but outside this surface's window? Then one local
   * covering write renders it, with no read involved — which is why this arm sits
   * ahead of every read arm, failure included.
   */
  canWiden: boolean;
  /** Is a read this round depends on in flight right now — the target's own column,
   *  or the detail read that says WHICH column that is? */
  readInFlight: boolean;
  /**
   * Has a FAILED read landed since this intent's evidence was baselined, on the
   * target's own column or on the detail read this round depends on?
   *
   * Ordered ahead of both `canFetch` and the success arm. Ahead of `canFetch`
   * because the surviving `next_cursor` of the last good page would otherwise page
   * forever; ahead of success because a success elsewhere is not this read's
   * result — and the evidence is scoped so "elsewhere" cannot reach this input at
   * all (Cindy MUST FIX).
   */
  readFailedSince: boolean;
  /**
   * Is the column that would have to answer for this target known — i.e. is there
   * a column whose read can vouch for absence at all? False while the detail read
   * has not yet said where the task lives. Nothing may be concluded then: no
   * column is the target's, so no column's success is about it.
   */
  authorityKnown: boolean;
  /** May the target's column still be asked for another page? */
  canFetch: boolean;
  /** Has a SUCCESSFUL read of the target's OWN column landed since this intent's
   *  evidence was baselined? */
  readSucceededSince: boolean;
  /** Has this intent already demanded its one authoritative read? */
  readRequested: boolean;
  /** Has the bounded DOM lookup budget been spent? */
  domBudgetSpent: boolean;
}): RevealStep {
  if (!args.revealing) return 'idle';
  // Before anything is concluded from the rendered set, the surface must have
  // been given its chance to put the target INTO that set.
  if (!args.ensured) return 'ensure';
  if (args.present) return args.domBudgetSpent ? 'consume_no_row' : 'deliver';
  // A row we already hold is reachable without asking anyone anything.
  if (args.canWiden) return 'widen';
  if (args.readInFlight) return 'wait';
  // One failed read ends the round WITHOUT claiming the task doesn't exist.
  // Anything else latches: a failed read never advances the success clock, so
  // re-deciding `refetch` forever (and being suppressed by "already requested")
  // leaves a wait with no terminator, and the next click on the SAME task is not
  // an arrival, so nothing re-runs (Cindy BLOCKER 12). There is no reliable rescue
  // to wait for either — the column query has no refetch interval,
  // `refetchOnWindowFocus` is off, and a quiet workspace sends no frame.
  if (args.readFailedSince) return 'consume_read_failed';
  // Nobody can answer yet. Not terminal and not a dead end: the detail read that
  // decides which column owns the target is either in flight or will fail, and
  // both outcomes move this machine.
  if (!args.authorityKnown) return 'wait';
  // Fetching outranks the evidence arms below, and deliberately so: a settled read
  // of the pages this surface HAS is not evidence about the pages it has not asked
  // for. Ordered after `readInFlight` so one page is fetched at a time instead of
  // the machine re-deciding `page` while its own fetch is in flight.
  if (args.canFetch) return 'page';
  if (args.readSucceededSince) return 'consume_absent';
  if (!args.readRequested) return 'refetch';
  // Requested, neither clock moved yet: a real read is on its way to settling and
  // the observer will advance one of them. Not a dead end, so not terminal.
  return 'wait';
}

/**
 * Per-intent evidence, scoped to the read that may answer for it.
 *
 * Keyed by the intent AND by the authority identity, so neither a previous
 * reveal's settled read nor a read of some other column — or of the same column
 * under different filters — can vouch for this one.
 */
export interface RevealEvidence {
  /** The intent this evidence belongs to. */
  key: string | null;
  /**
   * WHICH read the clocks below belong to: the target column's
   * `(status, filterKey)` plus the composition of the failure axis. Clocks are
   * only comparable within one identity — a replacement query starts at
   * `dataUpdatedAt: 0` / `errorUpdateCount: 0`, so comparing across a swap reads
   * the swap itself as a fresh answer (Cindy MUST FIX). `null` while no column is
   * known to own the target.
   */
  authority: string | null;
  /** The target column's `dataUpdatedAt` when this evidence was baselined. */
  baseline: number;
  /** The failure axis' value when this evidence was baselined. */
  errorBaseline: number;
  /** Has the surface been asked to make the target renderable? */
  ensured: boolean;
  /** Have we already demanded an authoritative read under this authority? */
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
  authority: null,
  baseline: 0,
  errorBaseline: 0,
  ensured: false,
  requested: false,
  succeeded: false,
  failed: false,
  domMisses: 0,
};

/**
 * Fold an observation of the TARGET'S OWN read into the evidence.
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
 * BOTH ARE ONLY COMPARABLE WITHIN ONE AUTHORITY. When the authority changes —
 * `ensure` resetting the filters swaps every column's query key, the detail read
 * naming a different column, the target turning up in a column this surface has
 * loaded — the clocks belong to a different query and the differences mean
 * nothing. So the round re-baselines and drops what it thought it had read
 * (`requested` / `succeeded` / `failed`), while keeping what is a fact about THIS
 * INTENT rather than about a query: `ensured` (the surface was widened) and
 * `domMisses` (the delivery budget). Without this, a filter reset alone read as a
 * successful read and consumed the intent as absent (Cindy MUST FIX).
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
    /** The target column's query identity, or `null` if no column owns it yet. */
    authority: string | null;
    dataUpdatedAt: number;
    errorUpdateCount: number;
  },
): RevealEvidence {
  if (prev.key !== args.revealTaskId) {
    return {
      ...EMPTY_REVEAL_EVIDENCE,
      key: args.revealTaskId,
      authority: args.authority,
      baseline: args.dataUpdatedAt,
      errorBaseline: args.errorUpdateCount,
    };
  }
  if (prev.authority !== args.authority) {
    return {
      ...prev,
      authority: args.authority,
      baseline: args.dataUpdatedAt,
      errorBaseline: args.errorUpdateCount,
      requested: false,
      succeeded: false,
      failed: false,
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
