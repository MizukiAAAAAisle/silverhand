import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TaskStatus } from '@silverhand/shared';
import { expandColumn } from './useKanbanColumnCollapse';
import {
  EMPTY_REVEAL_EVIDENCE,
  MAX_REVEAL_DOM_MISSES,
  nextRevealEvidence,
  nextRevealStep,
} from './revealTask';

/** How long a revealed row stays highlighted. */
const HIGHLIGHT_MS = 1400;

export interface UseRevealTaskRowArgs {
  /** The standing one-shot intent, or `null`. A surface that is not the visible
   *  task surface is passed `null` — see `revealTask`'s EXCLUSIVITY note. */
  revealTaskId: string | null;
  /** Whether this surface can deliver right now — a closed overlay has no row to
   *  scroll to even while it holds the intent. */
  active: boolean;
  /** Scroll root — the row is looked up as `[data-task-id]` beneath it. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * The target as this surface's RENDERED collection holds it, or `null`.
   * Must be derived from the post-filter list the surface actually maps to DOM,
   * never from the unfiltered directory behind it — see `nextRevealStep` (1).
   */
  target: { status: TaskStatus } | null;
  /**
   * Whether the target is LOADED but outside this surface's window — reachable by
   * a local window write, with no read involved (see `nextRevealStep`'s
   * `canWiden`).
   */
  canWiden: boolean;
  /** Widen this surface's window over the loaded row — the `widen` step's action.
   *  Must move the surface forward on every call. */
  onWiden: () => void;
  /**
   * Whether the target's column may still hold pages the server has not sent (see
   * `nextRevealStep`'s `canFetch`). A board that reads a bounded window of a paged
   * face cannot tell "absent" from "not fetched yet" without it.
   */
  canFetch: boolean;
  /** Fetch one more page of the target's column — the `page` step's action.
   *  Must move the surface forward on every call (a no-op call would leave the
   *  machine in a state nothing re-triggers). */
  onPage: () => void;
  /**
   * Put the target into this surface's rendered set (widen its filters).
   * REQUIRED, with no default: "the delivery is shared but making the row
   * renderable is not" is exactly how the second surface ended up without it, so
   * the obligation is in the type rather than in a comment (Alice / Cindy
   * BLOCKER 10). Called at most once per intent, before `present` is trusted.
   */
  ensureRenderable: () => void;
  /**
   * WHICH read the three clocks below belong to — the target column's query
   * identity, or `null` while no column is known to own the target. A change means
   * the clocks describe a different query, so the round re-baselines rather than
   * reading the swap as an answer (see `nextRevealEvidence`).
   */
  authority: string | null;
  /** `isFetching` of the reads this round depends on. */
  isFetching: boolean;
  /** `dataUpdatedAt` of the TARGET's own column read — the SUCCESS clock (see
   *  `nextRevealEvidence`); a failed read does not move it. */
  dataUpdatedAt: number;
  /** `errorUpdateCount` of the reads this round depends on — the FAILURE axis,
   *  monotone so a settle cannot hide inside one millisecond. */
  errorUpdateCount: number;
  /** Force an authoritative read of the target's column (its own `refetch`). */
  refetch: () => void;
  /** Called on a terminal outcome: a successful delivery, or an established
   *  absence. Abandonment is not one — see the note above the effects. */
  onConsumed?: () => void;
}

/**
 * Deliver a reveal intent to whichever task surface is on screen: make the row
 * renderable, scroll it into view, pulse it, and consume the intent — or
 * establish that the row really is absent before giving up (`nextRevealStep`).
 *
 * Shared by the titlebar drawer and the `/tasks` section on purpose (#task:1715,
 * Alice): both are real, complete task surfaces, so a reveal targets "the board
 * that already exists here" and no navigation is needed to manufacture one. One
 * implementation also means the subtleties below are fixed once instead of
 * regrowing on the second surface.
 */
export function useRevealTaskRow(args: UseRevealTaskRowArgs): {
  highlightedTaskId: string | null;
} {
  const { revealTaskId, active, rootRef, target, isFetching, dataUpdatedAt } = args;
  const { canWiden, canFetch, authority, errorUpdateCount } = args;

  // The callbacks are read through refs so a caller passing inline closures
  // (`onConsumed={() => setRevealTaskId(null)}`) does not re-run the step
  // machine on every parent render.
  const refetchRef = useRef(args.refetch);
  refetchRef.current = args.refetch;
  const ensureRef = useRef(args.ensureRenderable);
  ensureRef.current = args.ensureRenderable;
  const onWidenRef = useRef(args.onWiden);
  onWidenRef.current = args.onWiden;
  const onPageRef = useRef(args.onPage);
  onPageRef.current = args.onPage;
  const onConsumedRef = useRef(args.onConsumed);
  onConsumedRef.current = args.onConsumed;

  // The pulse carries a GENERATION, not just an id. Revealing the same task
  // twice in a row would otherwise set state to the value it already holds —
  // React bails out, no commit, and the expiry effect's deps never change, so
  // the second reveal shows no pulse at all (its timer is still the first
  // one's, already fired). The generation makes every delivery a distinct
  // value, which re-arms the timer.
  const [pulse, setPulse] = useState<{ taskId: string | null; generation: number }>(
    { taskId: null, generation: 0 },
  );

  // Per-intent evidence, in state (not a ref) because the step machine below
  // must re-run when it changes.
  const [evidence, setEvidence] = useState(EMPTY_REVEAL_EVIDENCE);
  useEffect(() => {
    setEvidence(prev =>
      nextRevealEvidence(prev, {
        revealTaskId,
        authority,
        dataUpdatedAt,
        errorUpdateCount,
      }),
    );
  }, [revealTaskId, authority, dataUpdatedAt, errorUpdateCount]);

  useEffect(() => {
    if (!active || revealTaskId === null) return;
    // Wait for the evidence slot to re-key onto this intent AND onto the read that
    // may answer for it, so neither a previous intent's evidence nor a clock
    // belonging to a query that has since been replaced can vouch for this round.
    if (evidence.key !== revealTaskId) return;
    if (evidence.authority !== authority) return;

    const step = nextRevealStep({
      revealing: true,
      ensured: evidence.ensured,
      present: target !== null,
      canWiden,
      readInFlight: isFetching,
      readFailedSince: evidence.failed,
      authorityKnown: authority !== null,
      canFetch,
      readSucceededSince: evidence.succeeded,
      readRequested: evidence.requested,
      domBudgetSpent: evidence.domMisses >= MAX_REVEAL_DOM_MISSES,
    });

    switch (step) {
      case 'wait':
      case 'idle':
        return;
      case 'ensure':
        // Both writes land in the same commit, so `ensured: true` also means the
        // widened render has committed — the NEXT run reads a rendered set that
        // already contains the target if the surface can show it at all.
        ensureRef.current();
        setEvidence(prev =>
          prev.key === revealTaskId ? { ...prev, ensured: true } : prev,
        );
        return;
      case 'widen':
        // A row this surface already holds: no read, no budget, and the covering
        // write renders it in the next commit.
        onWidenRef.current();
        return;
      case 'page':
        // Unbudgeted on purpose: fetching a page is progress, not a failed lookup,
        // so it spends neither the DOM budget nor the one authoritative read. Its
        // terminators are the column's own end (`canFetch` goes false) and a failed
        // page, which the machine ranks ahead of this arm.
        onPageRef.current();
        return;
      case 'refetch':
        // One attempt per authority — the machine, not this switch, is what stops a
        // second one (`readRequested`), so there is no arm here that can silently
        // become a wait with no terminator.
        setEvidence(prev =>
          prev.key === revealTaskId ? { ...prev, requested: true } : prev,
        );
        refetchRef.current();
        return;
      case 'consume_absent':
      case 'consume_read_failed':
      case 'consume_no_row':
        onConsumedRef.current?.();
        return;
      case 'deliver':
        break;
    }

    // A revealed task in a collapsed column renders no row, so the scroll and
    // the pulse would land on nothing — Closed is collapsed by default.
    if (target) expandColumn(target.status);
    const frame = requestAnimationFrame(() => {
      const selector = `[data-task-id="${
        typeof CSS !== 'undefined' && CSS.escape
          ? CSS.escape(revealTaskId)
          : revealTaskId
      }"]`;
      const row = rootRef.current?.querySelector(selector) ?? null;
      if (!row) {
        // A miss is NOT a delivery: pulsing and consuming here is how a reveal
        // silently does nothing. Count it and let the machine try again next
        // commit; `MAX_REVEAL_DOM_MISSES` turns a row that never commits into a
        // terminal `consume_no_row` rather than a permanent wait.
        setEvidence(prev =>
          prev.key === revealTaskId
            ? { ...prev, domMisses: prev.domMisses + 1 }
            : prev,
        );
        return;
      }
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setPulse(prev => ({ taskId: revealTaskId, generation: prev.generation + 1 }));
      onConsumedRef.current?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    active,
    revealTaskId,
    target,
    canWiden,
    canFetch,
    authority,
    isFetching,
    evidence,
    rootRef,
  ]);

  // Voiding a standing intent is NOT this hook's job, and an `active` cleanup
  // cannot do it correctly: `active` says "this surface is mounted and open", not
  // "this surface is the one on screen", and it is also racy in principle — a ref
  // written during render hands the outgoing effect's cleanup the id from the NEW
  // render, so one commit that both deactivates a surface and stores a fresh
  // intent lets the cleanup consume an intent this surface never held while
  // active (Cindy BLOCKER 11).
  //
  // So the one-shot's lifecycle belongs to App, which holds it: it hands the id
  // to the visible task surface only, and voids it once a surface that hosted it
  // goes away (`nextRevealSlot`). A surface that is not on screen receives
  // `revealTaskId: null` and is therefore structurally unable to deliver or
  // consume. Consumption here stays exactly two exits: a terminal machine verdict,
  // and a successful DOM delivery.

  useEffect(() => {
    if (pulse.taskId === null) return;
    const timer = setTimeout(() => {
      setPulse(prev =>
        prev.generation === pulse.generation
          ? { taskId: null, generation: prev.generation }
          : prev,
      );
    }, HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [pulse.taskId, pulse.generation]);

  return { highlightedTaskId: pulse.taskId };
}
