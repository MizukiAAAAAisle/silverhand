// Activity's LIVE CARRIERS — which viewer-scoped frames re-read the rail
// (#task:2115, @Cindy's realtime blocker).
//
// THE BUG THIS IS THE FALSIFIER FOR. Admitting a workspace-less `direct_pair` to
// Activity fixed the COLD read and left the live one broken, which is the half the
// user actually reported: a DM that arrives while the list is already mounted never
// appears. The reason is that the positional family's frame is chosen by PLACEMENT
// on the emit side — `MessageDeliveryCoordinator.publishUnreadUpdated` sends
// `unread_updated` for a workspace conversation and `direct_pairs_changed` for a
// pair (its unread read model's unit is (viewer, WORKSPACE), which a pair has no
// coordinate in) — so a two-kind invalidation set waits for a frame that, for a DM,
// is never sent.
//
// WHY IT IS A CONSUMER TEST AND NOT A BACKEND ONE. The producer half is already
// pinned where it is produced: `backend/tests/routes/direct-pairs.test.ts` asserts a
// DM send's viewer frames are exactly two `direct_pairs_changed` (and no
// `unread_updated`), and the workspace arm's `unread_updated` is pinned across the
// unread route tests. What was missing is the OTHER end of the same wire — that
// Activity, a second consumer of that fact, listens to it. So this file asserts the
// carrier SET, and its exhaustive form is what makes a fourth carrier (or a fourth
// placement) a decision someone has to record rather than a silent staleness.
//
// The applier is exercised against a real QueryClient rather than a rendered hook:
// `applyActivityFrame` is a pure function of (frame, isViewerScope) precisely so
// this needs no DOM, the same idiom as `attention-frame-gap.test.ts`.
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ServerFrame } from '@silverhand/shared';
import { decodeTransportEpoch, decodeTransportSeq } from '@silverhand/shared';
import {
  ACTIVITY_INVALIDATING_EVENT_KINDS,
  activityKey,
  applyActivityFrame,
} from './hooks';

const EPOCH = decodeTransportEpoch('e1');

function event(kind: string, scope = 'viewer:u1'): ServerFrame {
  return {
    type: 'event',
    scope,
    seq: decodeTransportSeq(7),
    epoch: EPOCH,
    kind,
    payload: {},
  };
}

/** Records the query keys handed to `invalidateQueries`, in order. */
function trackInvalidations(qc: QueryClient): string[] {
  const seen: string[] = [];
  vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters?: unknown) => {
    const key = (filters as { queryKey?: unknown } | undefined)?.queryKey;
    seen.push(JSON.stringify(key));
    return Promise.resolve();
  });
  return seen;
}

const ACTIVITY = JSON.stringify(activityKey());

describe('Activity live carriers (#task:2115)', () => {
  // Named one by one, with the producer each stands for, because the claim is
  // per-carrier: a set that happened to contain three kinds but ignored the DM one
  // at runtime would pass an aggregate assertion.
  it.each([
    // A workspace send / a workspace stream read — the positional family's
    // workspace arm, paired with its badge inside `viewer-scope.ts`.
    ['unread_updated'],
    // A directed insert or read: @me and agent-start failures, both placements.
    ['notification'],
    // The positional family's DM arm, in BOTH directions: a send's post-commit
    // fan-out (`delivery.ts`) and a pair's cursor move (`application/observe.ts`)
    // publish this instead of `unread_updated`. Miss it and a first DM never
    // appears, and a DM read in its own pane leaves its row behind in the rail.
    ['direct_pairs_changed'],
  ])('%s re-reads the rail', kind => {
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    applyActivityFrame(qc, event(kind), true);

    expect(seen).toEqual([ACTIVITY]);
  });

  it('carries exactly these three kinds and no others', () => {
    // Exhaustive rather than a membership check: the point of naming the set is
    // that adding to it is a decision recorded in one place.
    expect([...ACTIVITY_INVALIDATING_EVENT_KINDS]).toEqual([
      'unread_updated',
      'notification',
      'direct_pairs_changed',
    ]);
  });

  it('ignores the other frames the same viewer scope carries', () => {
    // The differential that keeps the fix from being "invalidate on any viewer
    // event": these three ride the SAME subscription and none can change this
    // list, so swallowing them would turn every badge tick into a refetch of the
    // app's hottest read. `task_changed` is here because `kind=task` is out of
    // Activity v1 — a status mirror, not an event.
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    for (const kind of ['attention_badge_updated', 'attention_pref_changed', 'task_changed']) {
      applyActivityFrame(qc, event(kind), true);
    }

    expect(seen).toEqual([]);
  });

  it('ignores a carrier that arrives on another scope', () => {
    // Scope gating is the caller's answer ("is this MY viewer scope"), so the
    // applier must honour it rather than key on the kind alone — otherwise a
    // conversation-scoped frame of a listed kind would re-read the whole rail.
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    applyActivityFrame(qc, event('direct_pairs_changed', 'conversation:c1'), false);
    applyActivityFrame(qc, event('unread_updated', 'workspace:w1'), false);

    expect(seen).toEqual([]);
  });

  it('re-reads on a viewer-scope gap, and only the viewer scope', () => {
    // A gap may have swallowed any of the three, so `snapshot_required` cannot be
    // handled per-kind — and the list is app-lifetime with `refetchOnWindowFocus`
    // off, so nothing else would ever re-read it.
    const gap = (scope: string): ServerFrame => ({
      type: 'snapshot_required',
      scope,
      reason: 'gap_too_large',
      epoch: EPOCH,
      currentSeq: decodeTransportSeq(42),
    });
    const qc = new QueryClient();
    const seen = trackInvalidations(qc);

    applyActivityFrame(qc, gap('workspace:w1'), false);
    expect(seen).toEqual([]);

    applyActivityFrame(qc, gap('viewer:u1'), true);
    expect(seen).toEqual([ACTIVITY]);
  });
});
