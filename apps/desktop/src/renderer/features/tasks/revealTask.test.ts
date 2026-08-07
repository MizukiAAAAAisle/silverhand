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
    // triggers no fetch, yet can be missing a task created while no board was
    // mounted (no `useTasks` listener existed to invalidate it). `isFetching:
    // false` is not authoritative absence.
    expect(step({ present: false, readInFlight: false })).toBe('refetch');
  });

  it('only calls absence terminal after a SUCCESSFUL read this intent observed', () => {
    expect(
      step({ present: false, readInFlight: false, readSucceededSince: true }),
    ).toBe('consume_absent');
    // A success outranks a failure that also landed: positive evidence is
    // positive evidence, whatever failed around it.
    expect(
      step({
        present: false,
        readRequested: true,
        readSucceededSince: true,
        readFailedSince: true,
      }),
    ).toBe('consume_absent');
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
    // A failure observed before this intent's own read was even demanded does not
    // end anything: the read it is entitled to has not happened yet.
    expect(step({ readRequested: false, readFailedSince: true })).toBe('refetch');
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
});

/**
 * Which observations count as proof that "this task is not in the list", and
 * which count as "the read we asked for failed".
 *
 * The absence axis is SUCCESS, not fetch completion: a fetching edge looks
 * identical for a fulfilled read and a failed one, so a 500 or a dropped
 * connection would otherwise vouch for terminal absence and eat the intent
 * (Cindy BLOCKER 9). The failure axis is the monotone `errorUpdateCount` rather
 * than a timestamp, so a settle landing in the baseline's millisecond cannot hide
 * (Alice).
 */
describe('nextRevealEvidence', () => {
  const arrive = (taskId: string, dataUpdatedAt: number, errorUpdateCount = 0) =>
    nextRevealEvidence(EMPTY_REVEAL_EVIDENCE, {
      revealTaskId: taskId,
      dataUpdatedAt,
      errorUpdateCount,
    });

  it('re-keys onto a new intent, taking BOTH clocks as its baseline', () => {
    const e = arrive('t1', 500, 7);
    expect(e).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't1',
      baseline: 500,
      errorBaseline: 7,
    });
  });

  it('does NOT accept a failed read as evidence of absence', () => {
    // The reproduction: nothing in the cache → the reveal demands a read →
    // `/api/tasks` 500s or the backend is unreachable. `isFetching` goes
    // true→false, but no data landed, so `dataUpdatedAt` has not moved.
    let e = { ...arrive('t1', 500, 7), requested: true };
    e = nextRevealEvidence(e, {
      revealTaskId: 't1',
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
      { revealTaskId: 't1', dataUpdatedAt: 500, errorUpdateCount: 8 },
    );
    expect(e.failed).toBe(true);
  });

  it('accepts a successful read that landed after the intent arrived', () => {
    const e = nextRevealEvidence(
      { ...arrive('t1', 500), requested: true },
      { revealTaskId: 't1', dataUpdatedAt: 900, errorUpdateCount: 0 },
    );
    expect(e.succeeded).toBe(true);
    // Latched: a later failure cannot take the proof back.
    const then = nextRevealEvidence(e, {
      revealTaskId: 't1',
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
      { revealTaskId: 't1', dataUpdatedAt: 900, errorUpdateCount: 3 },
    );
    expect(t1.succeeded).toBe(true);
    expect(t1.failed).toBe(true);
    const t2 = nextRevealEvidence(t1, {
      revealTaskId: 't2',
      dataUpdatedAt: 900,
      errorUpdateCount: 3,
    });
    expect(t2).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't2',
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
      { revealTaskId: 't1', dataUpdatedAt: 500, errorUpdateCount: 8 },
    );
    expect(failed.failed).toBe(true);
    const voided = nextRevealEvidence(failed, {
      revealTaskId: null,
      dataUpdatedAt: 500,
      errorUpdateCount: 8,
    });
    const again = nextRevealEvidence(voided, {
      revealTaskId: 't1',
      dataUpdatedAt: 500,
      errorUpdateCount: 8,
    });
    expect(again).toEqual({
      ...EMPTY_REVEAL_EVIDENCE,
      key: 't1',
      baseline: 500,
      errorBaseline: 8,
    });
    expect(
      nextRevealStep({
        revealing: true,
        ensured: true,
        present: false,
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
      dataUpdatedAt: 500,
      errorUpdateCount: 0,
    });
    expect(voided).toEqual({ ...EMPTY_REVEAL_EVIDENCE, key: null, baseline: 500 });
    const again = nextRevealEvidence(voided, {
      revealTaskId: 't1',
      dataUpdatedAt: 500,
      errorUpdateCount: 0,
    });
    expect(again).toEqual({ ...EMPTY_REVEAL_EVIDENCE, key: 't1', baseline: 500 });
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
 */
describe('every reveal surface widens its own view', () => {
  const surfaces = [
    '../../components/tasks/WorkspaceTasksDrawer.tsx',
    '../../components/layout/TasksSection.tsx',
  ];

  /** The `revealTarget` derivation only — the block this fence is about. The
   *  negation below has to be scoped to it: widening (#task:1885) legitimately
   *  reads the directory to find the target's page, and a file-wide negation
   *  would forbid that while proving nothing extra about the judgment. */
  const revealTargetBlock = (src: string): string => {
    const start = src.indexOf('const revealTarget = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n  }, [', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  for (const rel of surfaces) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const name = rel.slice(rel.lastIndexOf('/') + 1);

    it(`${name} widens its filters and judges presence on the rendered list`, () => {
      expect(src).toContain('ensureRenderable: ensureRevealRenderable');
      expect(src).toContain('setFilters(');
      // `allTasks` is the unfiltered directory; the rendered list is `tasks`.
      const judgment = revealTargetBlock(src);
      expect(judgment).toContain('const found = tasks.find(t => t.id === revealTaskId);');
      expect(judgment).not.toContain('allTasks');
      // Both evidence axes have to actually arrive: a surface that forwards only
      // the success clock leaves a failed read with no terminator on that board.
      expect(src).toContain('errorUpdateCount');
    });
  }
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

  it('offers the drawer only where it can be shown', () => {
    // One predicate for "this position hosts the drawer", read by the titlebar
    // button, the drawer's visibility, and the reveal's navigation branch — so the
    // app cannot offer a drawer that would immediately be hidden.
    expect(code).toContain('drawerHostable ? () => setTasksDrawerOpen(true) : undefined');
    expect(code).toContain('if (drawerHostable) {');
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
