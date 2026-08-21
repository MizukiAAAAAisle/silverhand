import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_REVEAL_EVIDENCE,
  EMPTY_REVEAL_SLOT,
  MAX_REVEAL_DOM_MISSES,
  nextRevealEvidence,
  nextRevealSlot,
  nextRevealStep,
  openRevealSlot,
} from './revealTask';

/**
 * The one-shot's lifecycle, owned by App rather than by a delivering surface: a
 * hook only knows whether IT can deliver, which is a different question from
 * whether the intent is still live.
 *
 * There is no owner in the intent, because there is at most one task surface on
 * screen: the drawer belongs to Chat/Activity and `/tasks` is an independent rail
 * section, so both are functions of the current section and cannot be visible in
 * the same commit (shiki). What remains is a single visibility bit.
 */
describe('reveal slot lifecycle', () => {
  it('starts every intent as a full round', () => {
    // No previous slot's `hosted` carries over, so revealing the same id a second
    // time re-widens, re-reads and re-pulses instead of resuming a spent round —
    // which is also what makes a re-click after a failed read a real retry.
    const spent = { taskId: 't1', hosted: true };
    expect(openRevealSlot('t1')).toEqual({ taskId: 't1', hosted: false });
    expect(nextRevealSlot(spent, true).hosted).toBe(true);
  });

  it('does NOT void an intent that predates the board it is navigating to', () => {
    // Revealing from Settings/Members/Computers navigates to `/tasks`, and that
    // navigation need not land in the same commit as the intent. Voiding on the
    // instantaneous "no surface visible" would cancel the reveal on its way to the
    // very board it asked for — so the void is a hosted→gone TRANSITION.
    const inTransit = openRevealSlot('t1');
    expect(nextRevealSlot(inTransit, false)).toBe(inTransit);
    // …and it survives an arbitrary number of such commits.
    expect(nextRevealSlot(nextRevealSlot(inTransit, false), false)).toBe(inTransit);
  });

  it('voids once the surface that HOSTED it goes away', () => {
    // The drawer closed, Chat was left, or the user left `/tasks`. Clearing is what
    // makes the next reveal of the same id a new round rather than a latched no-op
    // (Cindy BLOCKER 11).
    const hosted = nextRevealSlot(openRevealSlot('t1'), true);
    expect(hosted.hosted).toBe(true);
    expect(nextRevealSlot(hosted, false)).toEqual(EMPTY_REVEAL_SLOT);
  });

  it('is a no-op fold on an empty slot, so an effect may run it every commit', () => {
    expect(nextRevealSlot(EMPTY_REVEAL_SLOT, true)).toBe(EMPTY_REVEAL_SLOT);
    expect(nextRevealSlot(EMPTY_REVEAL_SLOT, false)).toBe(EMPTY_REVEAL_SLOT);
  });
});

/**
 * The reveal one-shot's timing contract. Every case below is a state a real
 * board reaches, and the dangerous ones are the "absent" pair: concluding
 * absence from a loading flag — or from a FAILED read — consumes the intent
 * before an authoritative answer lands, and the row that appears a moment later
 * is never scrolled to.
 */
describe('nextRevealStep', () => {
  const step = (over: Partial<Parameters<typeof nextRevealStep>[0]> = {}) =>
    nextRevealStep({
      revealing: true,
      ensured: true,
      present: false,
      canWiden: false,
      canFetch: false,
      authorityKnown: true,
      readInFlight: false,
      readRequested: false,
      readSucceededSince: false,
      readFailedSince: false,
      domBudgetSpent: false,
      ...over,
    });

  it('is idle without an intent', () => {
    expect(step({ revealing: false })).toBe('idle');
    // …even when everything else would say "deliver".
    expect(step({ revealing: false, present: true })).toBe('idle');
  });

  it('makes the target renderable BEFORE reading anything into the rendered set', () => {
    // The whole point of the gate: an un-widened board's rendered set cannot be
    // trusted to answer "is the row there", in EITHER direction. So no other
    // input may win before `ensured` — not a hit, and not an authoritative miss.
    expect(step({ ensured: false })).toBe('ensure');
    expect(step({ ensured: false, present: true })).toBe('ensure');
    expect(step({ ensured: false, readSucceededSince: true })).toBe('ensure');
    expect(step({ ensured: false, readInFlight: true })).toBe('ensure');
  });

  it('delivers when the row is in the RENDERED set', () => {
    // No read is demanded for a hit: presence needs no proof.
    expect(step({ present: true })).toBe('deliver');
    expect(step({ present: true, readInFlight: true })).toBe('deliver');
    expect(step({ present: true, readSucceededSince: false })).toBe('deliver');
  });

  it('waits while a read is in flight over a list missing the target', () => {
    // The falsifier: a remounted board with cached data is
    // `isLoading: false, isFetching: true`, and the chip/deep-link task is
    // exactly the one that cache lacks. Consuming here loses the reveal.
    expect(step({ present: false, readInFlight: true })).toBe('wait');
    expect(
      step({ present: false, readInFlight: true, readSucceededSince: true }),
    ).toBe('wait');
  });

  it('demands a read when the target is absent from a FRESH list with none in flight', () => {
    // The second falsifier: a list cached inside `staleTime` counts as fresh and
    // triggers no fetch, yet can be missing a task created while nothing was
    // invalidating it. `isFetching: false` is not authoritative absence.
    expect(step({ present: false, readInFlight: false })).toBe('refetch');
  });

  it('only calls absence terminal after a SUCCESSFUL read this intent observed', () => {
    expect(
      step({ present: false, readInFlight: false, readSucceededSince: true }),
    ).toBe('consume_absent');
    // Cindy MUST FIX: a success no longer outranks a failure. Both clocks are now
    // scoped to ONE authority — the target column under the current filter — so
    // "succeeded and failed both moved" means that column answered once and
    // errored once, which is not a clean bill of health for the read this round
    // depends on. The old ordering let a SIBLING column's success cover the
    // target column's failure and call the task absent.
    expect(
      step({
        present: false,
        readRequested: true,
        readSucceededSince: true,
        readFailedSince: true,
      }),
    ).toBe('consume_read_failed');
  });

  it('waits when nobody is in a position to answer', () => {
    // `authorityKnown: false` is the detail read not having landed a status yet
    // AND no row located: there is no column to page and none to vouch for
    // absence. Concluding anything here would be a guess, so the round waits for
    // an authority to exist — but a row already in the rendered set still wins,
    // because presence needs no authority.
    expect(step({ authorityKnown: false })).toBe('wait');
    expect(step({ authorityKnown: false, readSucceededSince: true })).toBe('wait');
    expect(step({ authorityKnown: false, present: true })).toBe('deliver');
    // A failure still ends the round: it is the detail read that failed.
    expect(step({ authorityKnown: false, readFailedSince: true })).toBe(
      'consume_read_failed',
    );
  });

  it('widens a located row without reading anything', () => {
    // The row is IN this column's loaded pages, just below the render window.
    // That is a local window write, not a read — so it outranks every read arm,
    // including an in-flight fetch and a failure that would otherwise end the
    // round. Keeping the two separate is what lets the failure arm sit ahead of
    // paging without stranding a row the surface already holds.
    expect(step({ canWiden: true })).toBe('widen');
    expect(step({ canWiden: true, readInFlight: true })).toBe('widen');
    expect(step({ canWiden: true, readFailedSince: true })).toBe('widen');
    expect(step({ canWiden: true, canFetch: true })).toBe('widen');
    // …but not the two gates ahead of it.
    expect(step({ canWiden: true, present: true })).toBe('deliver');
    expect(step({ canWiden: true, ensured: false })).toBe('ensure');
  });

  it('ends the round when the one read this intent asked for FAILED', () => {
    // BLOCKER 12: without a terminal arm here the intent latches. A failed read
    // never advances the success clock, so the machine keeps deciding `refetch`,
    // `readRequested` suppresses it, and the wait has no terminator — and the
    // next click on the SAME task is not an arrival, so nothing re-runs. There is
    // no rescue to wait for either: the list query has no refetch interval,
    // `refetchOnWindowFocus` is off, and a quiet workspace sends no frame.
    expect(step({ readRequested: true, readFailedSince: true })).toBe(
      'consume_read_failed',
    );
    // It is a SEPARATE verdict from absence on purpose — ending the round asserts
    // nothing about whether the task exists.
    expect(step({ readRequested: true, readFailedSince: true })).not.toBe(
      'consume_absent',
    );
    // A failure the target column recorded before this round asked for anything
    // still ends it. The clock is baselined at intent arrival AND re-baselined
    // whenever the authority changes, so "moved since baseline" already means
    // "this column failed while this round was waiting on it" — there is nothing
    // left for `readRequested` to disambiguate, and the round has no honest way
    // to keep waiting on a column that just errored.
    expect(step({ readRequested: false, readFailedSince: true })).toBe(
      'consume_read_failed',
    );
    // Nor does it pre-empt an in-flight read or a row that is already there.
    expect(
      step({ readRequested: true, readFailedSince: true, readInFlight: true }),
    ).toBe('wait');
    expect(
      step({ readRequested: true, readFailedSince: true, present: true }),
    ).toBe('deliver');
  });

  it('waits while the demanded read is still on its way to settling', () => {
    // Requested, and neither clock has moved: a real read is in flight or about
    // to be, and the observer will advance one of the two axes. Not a dead end,
    // so not terminal — and NOT derived from `requested && !isFetching`, which
    // cannot tell "about to settle" from "settled as a failure".
    expect(
      step({ readRequested: true, readSucceededSince: false, readFailedSince: false }),
    ).toBe('wait');
  });

  it('ends the one-shot when the row is in the data but its node never commits', () => {
    // A DOM miss is a bounded wait, not a delivery — but it still has to end.
    expect(step({ present: true, domBudgetSpent: true })).toBe('consume_no_row');
    // The budget is irrelevant to every other arm.
    expect(step({ present: false, domBudgetSpent: true })).toBe('refetch');
  });

  /**
   * The paged board (#task:1885). A surface now renders a bounded prefix of five
   * independently-paged columns, so "not in my rendered rows" has a third meaning
   * that is not absence: the row is further down a column nobody has read that far.
   */
  describe('a column that can still yield rows', () => {
    it('pages instead of concluding absence', () => {
      expect(step({ present: false, canFetch: true })).toBe('page');
    });

    it('outranks a settled read, which only vouches for the pages it read', () => {
      // The regression this ordering exists for: page 1 came back clean, the target
      // is on page 7, and `readSucceededSince` would otherwise call that absence —
      // consuming the intent while the row is one fetch away.
      expect(
        step({ present: false, canFetch: true, readSucceededSince: true }),
      ).toBe('page');
      // Likewise it must not be mistaken for the "ask for an authoritative read"
      // arm: the read this surface needs is the NEXT PAGE, not a re-read of the
      // pages it already has.
      expect(step({ present: false, canFetch: true, readRequested: false })).toBe(
        'page',
      );
    });

    it('stops paging when a page FAILED, even though the cursor survived', () => {
      // Cindy MUST FIX, third falsifier: `next_cursor` lives on the last page that
      // came back, so a failed `fetchNextPage` leaves `canFetch` true forever. With
      // paging ahead of the failure arm the machine re-decided `page` on every
      // commit and walked the same failing request without end. The failure arm now
      // sits FIRST, so a dead column ends the round after one attempt.
      expect(
        step({ present: false, canFetch: true, readFailedSince: true }),
      ).toBe('consume_read_failed');
      // And it is not silently converted into an absence claim: the column never
      // answered, so nothing is known about whether the task is in it.
      expect(
        step({ present: false, canFetch: true, readFailedSince: true }),
      ).not.toBe('consume_absent');
      // The bound is one retry, not zero: a failure that landed before this round
      // is what `nextRevealEvidence` re-baselines away (see below), so a fresh
      // round over the same column does get to fetch.
    });

    it('yields to an in-flight read, so one page is fetched at a time', () => {
      // Paging is what CAUSES the read; re-deciding `page` while that read is in
      // flight would walk the whole column in a burst of parallel fetches.
      expect(step({ present: false, canFetch: true, readInFlight: true })).toBe(
        'wait',
      );
    });

    it('never pre-empts a row that is already rendered or one page-free widen away', () => {
      expect(step({ present: true, canFetch: true })).toBe('deliver');
      // …nor the widening gate: an un-widened rendered set cannot say whether
      // paging is even needed.
      expect(step({ ensured: false, canFetch: true })).toBe('ensure');
      // A row already in the loaded pages is widened, never re-fetched — the two
      // are mutually exclusive in `useBoardReveal` (`canFetch` requires
      // `located === null`), and the order holds even if they ever overlap.
      expect(step({ canWiden: true, canFetch: true })).toBe('widen');
    });

    it('hands the round back to the evidence arms once the column is exhausted', () => {
      // `canFetch` going false is the paging round's ONLY terminator (`next_cursor
      // === null`), so absence stays reachable and the walk cannot loop forever.
      expect(step({ present: false, canFetch: false })).toBe('refetch');
      expect(
        step({ present: false, canFetch: false, readSucceededSince: true }),
      ).toBe('consume_absent');
    });
  });
});

/**
 * Which observations count as proof that "this task is not in the list", which
 * count as "the read we asked for failed", and — the part Cindy's MUST FIX turns
 * on — WHOSE read either of those was.
 *
 * The absence axis is SUCCESS, not fetch completion: a fetching edge looks
 * identical for a fulfilled read and a failed one, so a 500 or a dropped
 * connection would otherwise vouch for terminal absence and eat the intent
 * (Cindy BLOCKER 9). The failure axis is the monotone `errorUpdateCount` rather
 * than a timestamp, so a settle landing in the baseline's millisecond cannot hide
 * (Alice).
 *
 * Both clocks belong to ONE query. `authority` names it — `'row'`/`'detail'` plus
 * that column's `(status, filterKey)` identity — and a change to it invalidates
 * every observation taken under the old one: React Query starts a new query's
 * clocks at 0, and a different column's clocks were never comparable to begin
 * with.
 */
describe('nextRevealEvidence', () => {
  const TODO = 'row|todo|all';
  const arrive = (
    taskId: string,
    dataUpdatedAt: number,
    errorUpdateCount = 0,
    authority: string | null = TODO,
  ) =>
    nextRevealEvidence(EMPTY_REVEAL_EVIDENCE, {
      revealTaskId: taskId,
      authority,
      dataUpdatedAt,
      errorUpdateCount,
    });

  it('re-keys onto a new intent, taking BOTH clocks and the authority as its baseline', () => {
    const e = arrive('t1', 500, 7);
    expect(e).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't1',
      authority: TODO,
      baseline: 500,
      errorBaseline: 7,
    });
  });

  it('does NOT accept a failed read as evidence of absence', () => {
    // The reproduction: nothing in the cache → the reveal demands a read → the
    // column read 500s or the backend is unreachable. `isFetching` goes
    // true→false, but no data landed, so `dataUpdatedAt` has not moved.
    let e = { ...arrive('t1', 500, 7), requested: true };
    e = nextRevealEvidence(e, {
      revealTaskId: 't1',
      authority: TODO,
      dataUpdatedAt: 500,
      errorUpdateCount: 8,
    });
    expect(e.succeeded).toBe(false);
    // …it is recorded on its own axis instead, so the round can end without
    // claiming the task doesn't exist (BLOCKER 12).
    expect(e.failed).toBe(true);
    expect(
      nextRevealStep({
        revealing: true,
        ensured: true,
        present: false,
        canWiden: false,
        canFetch: false,
        authorityKnown: true,
        readInFlight: false,
        readRequested: e.requested,
        readSucceededSince: e.succeeded,
        readFailedSince: e.failed,
        domBudgetSpent: false,
      }),
    ).toBe('consume_read_failed');
  });

  it('sees a failure even when the error settles in the baseline millisecond', () => {
    // Why the failure axis is the monotone counter and not `errorUpdatedAt`: an
    // intent that arrives right after a previous error, whose own read then fails
    // inside the same millisecond, would read as "nothing failed" on a timestamp
    // and latch in `wait` forever.
    const e = nextRevealEvidence(
      { ...arrive('t1', 500, 7), requested: true },
      { revealTaskId: 't1', authority: TODO, dataUpdatedAt: 500, errorUpdateCount: 8 },
    );
    expect(e.failed).toBe(true);
  });

  it('accepts a successful read that landed after the intent arrived', () => {
    const e = nextRevealEvidence(
      { ...arrive('t1', 500), requested: true },
      { revealTaskId: 't1', authority: TODO, dataUpdatedAt: 900, errorUpdateCount: 0 },
    );
    expect(e.succeeded).toBe(true);
    // Latched: a later failure cannot take the proof back — but it is recorded,
    // and the machine's failure-first ordering is what decides between them.
    const then = nextRevealEvidence(e, {
      revealTaskId: 't1',
      authority: TODO,
      dataUpdatedAt: 900,
      errorUpdateCount: 1,
    });
    expect(then.succeeded).toBe(true);
    expect(then.failed).toBe(true);
  });

  it('never lets a previous intent\'s read vouch for the next one, in either direction', () => {
    // The stale-evidence trap: t1 got its authoritative read, then t2 arrives
    // with nothing fetched since. Inheriting `succeeded` would consume t2 on
    // sight; inheriting `failed` would end t2's round before it ever read.
    const t1 = nextRevealEvidence(
      { ...arrive('t1', 500), requested: true },
      { revealTaskId: 't1', authority: TODO, dataUpdatedAt: 900, errorUpdateCount: 3 },
    );
    expect(t1.succeeded).toBe(true);
    expect(t1.failed).toBe(true);
    const t2 = nextRevealEvidence(t1, {
      revealTaskId: 't2',
      authority: TODO,
      dataUpdatedAt: 900,
      errorUpdateCount: 3,
    });
    expect(t2).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't2',
      authority: TODO,
      baseline: 900,
      errorBaseline: 3,
    });
  });

  it('lets a re-click after a failed read run a whole new round', () => {
    // The other half of BLOCKER 12: the failure ends the round, App's void clears
    // the intent, and clicking the SAME chip again must re-baseline both clocks
    // and demand a fresh read — not resume a spent round.
    const failed = nextRevealEvidence(
      { ...arrive('t1', 500, 7), ensured: true, requested: true },
      { revealTaskId: 't1', authority: TODO, dataUpdatedAt: 500, errorUpdateCount: 8 },
    );
    expect(failed.failed).toBe(true);
    const voided = nextRevealEvidence(failed, {
      revealTaskId: null,
      authority: TODO,
      dataUpdatedAt: 500,
      errorUpdateCount: 8,
    });
    const again = nextRevealEvidence(voided, {
      revealTaskId: 't1',
      authority: TODO,
      dataUpdatedAt: 500,
      errorUpdateCount: 8,
    });
    expect(again).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't1',
      authority: TODO,
      baseline: 500,
      errorBaseline: 8,
    });
    expect(
      nextRevealStep({
        revealing: true,
        ensured: true,
        present: false,
        canWiden: false,
        canFetch: false,
        authorityKnown: true,
        readInFlight: false,
        readRequested: again.requested,
        readSucceededSince: again.succeeded,
        readFailedSince: again.failed,
        domBudgetSpent: false,
      }),
    ).toBe('refetch');
  });

  it('resets to a blank slate when the intent is voided, so the same id can run again', () => {
    // BLOCKER 11's mechanism: the surface closes → App clears the intent → the
    // slot re-keys to `null`, dropping `requested` / `succeeded` / `ensured`. The
    // next reveal of the SAME id is therefore a full round, not a resumption.
    const spent = {
      key: 't1',
      authority: TODO,
      baseline: 500,
      errorBaseline: 0,
      ensured: true,
      requested: true,
      succeeded: true,
      failed: false,
      domMisses: 2,
    };
    const voided = nextRevealEvidence(spent, {
      revealTaskId: null,
      authority: TODO,
      dataUpdatedAt: 500,
      errorUpdateCount: 0,
    });
    expect(voided).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: null,
      authority: TODO,
      baseline: 500,
    });
    const again = nextRevealEvidence(voided, {
      revealTaskId: 't1',
      authority: TODO,
      dataUpdatedAt: 500,
      errorUpdateCount: 0,
    });
    expect(again).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't1',
      authority: TODO,
      baseline: 500,
    });
  });

  /**
   * Cindy MUST FIX: 能为"不存在"背书的成功证据必须来自当前 filter/query identity
   * 下的目标列. Each case below is a way the old aggregate evidence answered with
   * somebody else's read.
   */
  describe('evidence belongs to the query that produced it', () => {
    it('does not let a sibling column\'s success cover the target column\'s failure', () => {
      // The old shape aggregated all five columns as `max(dataUpdatedAt)` /
      // `sum(errorUpdateCount)`. `done` refetching successfully while `todo` — the
      // column that would hold the task — 500s therefore produced succeeded AND
      // failed, and success won: `consume_absent` for a task nobody read for.
      //
      // Scoped clocks make the sibling's success unrepresentable here: these are
      // `todo`'s numbers, and only its data clock can move `succeeded`.
      const e = nextRevealEvidence(
        { ...arrive('t1', 500, 7), requested: true },
        {
          revealTaskId: 't1',
          authority: TODO,
          dataUpdatedAt: 500, // the target column never answered
          errorUpdateCount: 8, // …and errored once
        },
      );
      expect(e.succeeded).toBe(false);
      expect(e.failed).toBe(true);
      expect(
        nextRevealStep({
          revealing: true,
          ensured: true,
          present: false,
          canWiden: false,
          canFetch: false,
          authorityKnown: true,
          readInFlight: false,
          readRequested: e.requested,
          readSucceededSince: e.succeeded,
          readFailedSince: e.failed,
          domBudgetSpent: false,
        }),
      ).toBe('consume_read_failed');
    });

    it('discards a clock reading taken under a different filter, success included', () => {
      // The first falsifier: `ensureRenderable` resets the filters, so all five
      // column keys swap. The new query starts at `dataUpdatedAt: 0`, which merely
      // DIFFERS from the old baseline — and "differs" was the success test, so the
      // very act of widening looked like an authoritative read.
      const OTHER = 'row|todo|assignee=me';
      const settled = nextRevealEvidence(
        { ...arrive('t1', 500, 0, OTHER), ensured: true, requested: true },
        { revealTaskId: 't1', authority: OTHER, dataUpdatedAt: 900, errorUpdateCount: 0 },
      );
      expect(settled.succeeded).toBe(true);

      const swapped = nextRevealEvidence(settled, {
        revealTaskId: 't1',
        authority: TODO,
        dataUpdatedAt: 0, // a brand-new query: no read has landed yet
        errorUpdateCount: 0,
      });
      expect(swapped.authority).toBe(TODO);
      expect(swapped.succeeded).toBe(false);
      expect(swapped.failed).toBe(false);
      expect(swapped.requested).toBe(false);
      expect(swapped.baseline).toBe(0);
      // `ensured` and the DOM budget survive the swap on purpose: widening is what
      // CHANGES the authority, so re-arming it here would widen → re-baseline →
      // widen forever.
      expect(swapped.ensured).toBe(true);
      expect(swapped.domMisses).toBe(settled.domMisses);
      // So the round asks the new query for a read instead of consuming absence.
      expect(
        nextRevealStep({
          revealing: true,
          ensured: swapped.ensured,
          present: false,
          canWiden: false,
          canFetch: false,
          authorityKnown: true,
          readInFlight: false,
          readRequested: swapped.requested,
          readSucceededSince: swapped.succeeded,
          readFailedSince: swapped.failed,
          domBudgetSpent: false,
        }),
      ).toBe('refetch');
    });

    it('drops a failure taken under the previous filter, so the new query gets its turn', () => {
      // The symmetric half: inheriting `failed` across the swap would end the
      // round on the strength of a read that answered for a query this surface no
      // longer has.
      const OTHER = 'row|todo|assignee=me';
      const failed = nextRevealEvidence(
        { ...arrive('t1', 500, 7, OTHER), ensured: true, requested: true },
        { revealTaskId: 't1', authority: OTHER, dataUpdatedAt: 500, errorUpdateCount: 8 },
      );
      expect(failed.failed).toBe(true);
      const swapped = nextRevealEvidence(failed, {
        revealTaskId: 't1',
        authority: TODO,
        dataUpdatedAt: 0,
        errorUpdateCount: 0,
      });
      expect(swapped.failed).toBe(false);
      expect(swapped.errorBaseline).toBe(0);
    });

    it('waits rather than concluding while no authority exists', () => {
      // `authority: null` is "no column to ask": the detail read has not produced
      // a status and no row is located. The evidence still tracks, but the machine
      // refuses to spend the intent on it.
      const none = arrive('t1', 0, 0, null);
      expect(none.authority).toBeNull();
      expect(
        nextRevealStep({
          revealing: true,
          ensured: true,
          present: false,
          canWiden: false,
          canFetch: false,
          authorityKnown: none.authority !== null,
          readInFlight: false,
          readRequested: none.requested,
          readSucceededSince: none.succeeded,
          readFailedSince: none.failed,
          domBudgetSpent: false,
        }),
      ).toBe('wait');
    });
  });
});

/**
 * Structural fence for the things the step machine cannot express on its own.
 * Desktop's renderer test env is `node` (no jsdom / RTL — see
 * `vitest.config.ts`), so the hook that consumes the machine is fenced at the
 * source level, the same way the sibling viewer-scope fence is.
 *
 * Comments are stripped before scanning: this hook DOCUMENTS the flags it must
 * not use, and prose must not stand in for behaviour in either direction
 * (Cindy / Alice).
 *
 * Known blind spot, stated so the next reader doesn't over-trust it: the scan
 * covers this file only. A call site is free to pass `isLoading` into the
 * `isFetching` argument — nothing here can see that. Today the prop names carry
 * it (`isFetching` / `dataUpdatedAt` are what the surfaces destructure).
 */
describe('useRevealTaskRow wiring', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./useRevealTaskRow.ts', import.meta.url)),
    'utf8',
  );
  const code = source
    .split('\n')
    .filter(line => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('decides through the step machine, not an ad-hoc loading flag', () => {
    expect(code).toContain('nextRevealStep({');
    // `isLoading` is precisely the signal that cannot answer "not in the list".
    expect(code).not.toContain('isLoading');
  });

  it('takes its absence evidence from the success clock, not a fetching edge', () => {
    expect(code).toContain('nextRevealEvidence(');
    expect(code).toContain('readSucceededSince: evidence.succeeded');
    // The rejected implementation: `wasFetching && !isFetching` cannot tell a
    // fulfilled read from a failed one.
    expect(code).not.toContain('wasFetching');
  });

  it('reads failure on its own monotone axis, and lets the machine end the round', () => {
    // BLOCKER 12. Both axes reach the machine, so a failed read ends the round
    // through a named verdict instead of latching in a wait with no terminator.
    expect(code).toContain('errorUpdateCount');
    expect(code).toContain('readRequested: evidence.requested');
    expect(code).toContain('readFailedSince: evidence.failed');
    expect(code).toContain("case 'consume_read_failed':");
    // A timestamp can be missed by a settle inside one millisecond; the counter
    // cannot (Alice).
    expect(code).not.toContain('errorUpdatedAt');
    // And the one-read-per-intent rule lives in the machine, not in an ad-hoc
    // early return next to `refetch` — that shape is exactly how the arm became a
    // silent permanent wait.
    expect(code).not.toContain('if (evidence.requested) return;');
    // `isError` is a snapshot of the current error, not "a failure landed since
    // this intent arrived", and it never distinguishes whose read failed.
    expect(code).not.toContain('isError');
  });

  it('refuses to act on evidence taken under another query', () => {
    // Cindy MUST FIX: the evidence and the step decision are two effects, so there
    // is a commit where the authority has already changed and `evidence` still
    // describes the previous query. Acting on it is how the filter swap became a
    // success. The phase guard makes that commit a no-op — the evidence effect
    // re-baselines first, and the next commit decides.
    expect(code).toContain('if (evidence.authority !== authority) return;');
    expect(code).toContain('authorityKnown: authority !== null');
  });

  it('widens a loaded row instead of reading for it', () => {
    // The two are different actions with different costs: a window write is local
    // and cannot fail, a page is a request that can. Collapsing them would make a
    // row the surface already holds depend on the network.
    expect(code).toContain("case 'widen':");
    expect(code).toContain('onWidenRef.current()');
  });

  it('carries a generation on the pulse so a repeat reveal re-arms it', () => {
    // Same-value `setState` does not commit, so an id-only highlight leaves the
    // expiry effect's deps unchanged and the second reveal of one task shows
    // nothing.
    expect(code).toContain('generation: prev.generation + 1');
  });

  it('opens a collapsed column before delivering', () => {
    expect(code).toContain('expandColumn(target.status)');
  });

  it('has a CLOSED set of consumption exits, and abandonment is not one of them', () => {
    // The invariant, as a count: this hook consumes on a terminal machine verdict
    // and on a successful DOM delivery. Nothing else. A third call would mean the
    // hook has started deciding the intent's LIFECYCLE — most dangerously in an
    // `active` cleanup, which is wrong twice over: `active` means "I can deliver",
    // not "I own this", and both boards can be active at once; and a ref written
    // during render hands the outgoing cleanup the NEXT render's id, so one commit
    // that both deactivates a surface and stores a fresh intent lets it consume an
    // intent it never held while active (Cindy BLOCKER 11).
    const consumptions = code.match(/onConsumedRef\.current\?\.\(\)/g) ?? [];
    expect(consumptions).toHaveLength(2);
    // The inactive path is a bare return: no side effect may hang off it.
    expect(code).toContain('if (!active || revealTaskId === null) return;');
    // And no cleanup-time consumption of any kind: the only teardowns in the file
    // dispose of the effect's own frame and the pulse's own timer.
    expect(code).not.toContain('standing');
    expect(code.match(/return \(\) => .*/g) ?? []).toEqual([
      'return () => cancelAnimationFrame(frame);',
      'return () => clearTimeout(timer);',
    ]);
  });

  it('treats a DOM miss as a bounded wait rather than a delivery', () => {
    // The dangerous shape: pulse + consume unconditionally after one rAF.
    expect(code).toContain('domMisses: prev.domMisses + 1');
    expect(code).toContain('domBudgetSpent: evidence.domMisses >= MAX_REVEAL_DOM_MISSES');
    expect(MAX_REVEAL_DOM_MISSES).toBeGreaterThan(0);
  });
});

/**
 * Both surfaces must make the target renderable — the obligation lives in the
 * shared hook's REQUIRED argument, so a third board cannot forget it (it would
 * not compile). This fence checks the two of them actually widen, rather than
 * passing a no-op to satisfy the type.
 *
 * Since the board reads a page face (#task:1885), the presence JUDGMENT is no
 * longer written per surface: `useBoardReveal` owns it, so the fence checks that
 * each surface routes through it rather than re-deriving a target from a
 * directory it no longer has.
 */
describe('every reveal surface widens its own view', () => {
  const surfaces = [
    '../../components/tasks/WorkspaceTasksDrawer.tsx',
    '../../components/layout/TasksSection.tsx',
  ];

  for (const rel of surfaces) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const name = rel.slice(rel.lastIndexOf('/') + 1);

    it(`${name} widens its filters and takes presence from the shared judgment`, () => {
      expect(src).toContain('ensureRenderable: ensureRevealRenderable');
      expect(src).toContain('setFilters(');
      // ONE judgment, in `useBoardReveal`. A surface deriving its own `revealTarget`
      // is how the directory-vouches-for-a-missing-row bug (Cindy BLOCKER 10) grew
      // the first time, and on a paged board it cannot even be written correctly —
      // the row may be in no page this surface holds.
      expect(src).toContain('useBoardReveal({');
      expect(src).toContain('target: reveal.target');
      expect(src).not.toContain('const revealTarget =');
      // Widening and paging both have to reach the machine from BOTH surfaces: a
      // board that forwards only `target` reports every row past its window as
      // absent, and one that forwards only `canFetch` re-reads a column for a row
      // it already holds.
      expect(src).toContain('canWiden: reveal.canWiden');
      expect(src).toContain('onWiden: reveal.widen');
      expect(src).toContain('canFetch: reveal.canFetch');
      expect(src).toContain('onPage: reveal.page');
      // The evidence's SCOPE travels with the clocks. A surface that forwards the
      // numbers but not `authority` hands the machine two clocks with no way to
      // tell which query produced them — the shape Cindy's MUST FIX removed.
      expect(src).toContain('authority: reveal.authority');
      // Both evidence axes have to actually arrive: a surface that forwards only
      // the success clock leaves a failed read with no terminator on that board.
      expect(src).toContain('errorUpdateCount');
    });
  }

  /** The judgment itself, now that it is shared. */
  it('judges presence against the RENDER window and pages while the column has more', () => {
    const code = readFileSync(
      fileURLToPath(new URL('./useBoardReveal.ts', import.meta.url)),
      'utf8',
    );
    // A row the surface has LOADED but does not render has no DOM node — the
    // window bound is part of the presence question, not just the fetch question.
    expect(code).toContain('columnVisibleCount(renderWindow, located.status)');
    // …and a row in no loaded page is only absent once the server says the column
    // has ended (`next_cursor === null`, surfaced as `atEnd`).
    expect(code).toContain('!authorityColumn.atEnd');
    // A collapsed column reads nothing and renders nothing, so a reveal into
    // Closed (collapsed by default) would page a column that can never answer.
    expect(code).toContain('expandColumn(targetStatus)');
    // The target's column comes from its own detail projection, read LIVE: a
    // status changed inside the modal is exactly the path "View in Tasks" arrives
    // by, and a snapshot would page the wrong column and then consume the intent.
    expect(code).toContain('detail.data?.status');
    expect(code).not.toContain('isLoading');
  });

  /**
   * Cindy MUST FIX, at the seam the pure tests cannot reach: the clocks handed to
   * the machine must be ONE column's, under the CURRENT filter. The pure cases
   * above prove the machine treats them that way; this pins that the hook does not
   * hand it an aggregate again.
   */
  it('scopes the clocks it reports to the target column alone', () => {
    const code = readFileSync(
      fileURLToPath(new URL('./useBoardReveal.ts', import.meta.url)),
      'utf8',
    );
    // The single named column every read-derived value comes from.
    expect(code).toContain('const authorityColumn =');
    expect(code).toContain('dataUpdatedAt: authorityColumn?.dataUpdatedAt ?? 0');
    // The aggregate shapes that produced the bug: a max over the five success
    // clocks and a sum over the five error counters, in which any sibling's
    // success outranked the target's failure.
    expect(code).not.toContain('Math.max');
    expect(code).not.toContain('.reduce(');
    // The scope itself is reported, so a filter swap invalidates the readings
    // rather than reading as a fresh success.
    expect(code).toContain('authorityColumn.identity');
  });
});

/**
 * App holds the one-shot and decides which board is on screen. The functions
 * above are where the rules live; this pins that App actually routes through
 * them, and that the two boards are mutually exclusive BY DERIVATION rather than
 * by a post-navigation side effect — the effect version leaves a commit where
 * `/tasks` is current and the drawer still counts as a delivery surface (Alice).
 */
describe('App keeps exactly one task surface on screen', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../App.tsx', import.meta.url)),
    'utf8',
  );
  const code = source
    .split('\n')
    .filter(line => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('derives both surfaces\' visibility from the current section', () => {
    expect(code).toContain('const drawerVisible = drawerHostable && tasksDrawerOpen;');
    expect(code).toContain("const sectionVisible = appSection === 'tasks';");
    // The rejected shape: close the drawer from an effect once the route has
    // already committed. The only write of `false` left is the one the USER causes
    // — jumping to a message leaves the board behind — so leaving Chat hides the
    // drawer without discarding the memory bit, and no commit exists where
    // `/tasks` is current and the drawer still counts as a delivery surface.
    expect(code.match(/setTasksDrawerOpen\(false\)/g) ?? []).toHaveLength(1);
  });

  it('hands the id to the visible surface only, and clears once', () => {
    expect(code).toContain('setReveal(openRevealSlot(taskId));');
    expect(code).toContain('revealTaskId={drawerVisible ? reveal.taskId : null}');
    expect(code).toContain('revealTaskId={sectionVisible ? reveal.taskId : null}');
    // A board kept mounted by `deferredSection` for one frame after the user left
    // it must not be a second surface holding the one-shot.
    expect(code).not.toContain('revealTaskId={reveal.taskId}');
  });

  it('gives the drawer no manual entry — reveal-only, gated where it can show', () => {
    // #task:2121: the conversation's manual Tasks entry is the per-conversation
    // Tasks TAB now, not a header button that opens this drawer. So the drawer
    // has NO opener prop anywhere — its sole `true` write is the reveal branch,
    // gated on the same `drawerHostable` predicate as its visibility, so the app
    // still never brings up a drawer that would immediately be hidden.
    expect(code).not.toContain('onOpenTasks');
    expect(code).toContain('if (drawerHostable) {');
    expect(code.match(/setTasksDrawerOpen\(true\)/g) ?? []).toHaveLength(1);
  });

  it('voids through the slot fold, on urgent section state', () => {
    expect(code).toContain(
      'setReveal(prev => nextRevealSlot(prev, drawerVisible || sectionVisible));',
    );
    // `deferredSection` lags a rail click by a frame, and a lag must not read as
    // "the surface went away" — the fold's inputs are the urgent predicates above.
    expect(code).not.toContain('nextRevealSlot(prev, deferred');
  });
});
