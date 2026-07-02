import type { QueryClient } from '@tanstack/react-query';
import type {
  MessageDto,
  MessageProjections,
  ThreadRootReplyCountPatch,
  ThreadSummaryInvariant,
} from '@silverhand/shared';
import {
  hasActiveMainlineReader,
  mergeMainlineReplyCount,
  mergeThreadRootReplyCount,
  openThreadRootReaderRoots,
} from '@/features/channels/hooks';
import {
  hasActiveChannelThreadsReader,
  invalidateChannelThreadsList,
  mergeThreadsListEntry,
} from '@/features/channels/useChannelThreads';

/**
 * S1 projection consumption (#task:1277, docs/projection-recovery-s1-v1.md §7).
 *
 * The renderer half of S1: a `message` frame carries an optional `projections`
 * sidecar of ABSOLUTE, viewer-invariant authoritative values (P1: the replied-to
 * root's reply count). Instead of the old invalidate→whole-window refetch, the
 * client idempotently MERGES the absolute value into the displayed projection.
 *
 * DISPOSITION — 4 states, NOT a boolean (§7 / Cindy gate #5). S1's whole
 * correctness rests on the authoritative-settle state machine (#1261): a merge is
 * one effect in the message frame's `Promise.allSettled` satisfaction join, and
 * flattening it to a bool would erase the "no target to write" ⊥ "needs a refetch
 * that hasn't committed" distinction that keeps the resume floor honest.
 *
 *  - `merged`              — a DISPLAYED projection was written synchronously with
 *                           the absolute value → settles now (an idempotent no-op
 *                           set of the same value still counts: the projection is
 *                           displayed and now authoritatively holds it).
 *  - `cold-absent-vacuous` — no active reader / the cache doesn't hold the target
 *                           row → nothing to write → settles VACUOUSLY (the floor
 *                           advances; the projection's own mount-fetch is the
 *                           authoritative recovery on next open). This is the ONLY
 *                           vacuous entry — a displayed-but-unmerged projection is
 *                           `pending-fallback`, never vacuous (Cindy gate #4).
 *  - `pending-fallback`    — a displayed projection could not take the patch
 *                           (patch absent on an additive-compat frame, or the
 *                           cache shape can't be merged) → fall back to the
 *                           existing invalidate→refetch; the join awaits its
 *                           commit (initiated ≠ committed, §4.1).
 *  - `rejected`            — a `pending-fallback` refetch rejected → PINS the floor
 *                           (transport re-drives on the next resume). Produced by
 *                           the async resolution of a `pending-fallback.settle`
 *                           surfaced through `Promise.allSettled` (see
 *                           {@link dispositionSettle}); readers return the three
 *                           synchronous states only.
 */
export type ProjectionDisposition =
  | { status: 'merged' }
  | { status: 'cold-absent-vacuous' }
  | { status: 'pending-fallback'; settle: Promise<void> }
  | { status: 'rejected'; error: unknown };

/** Map a disposition onto the per-effect promise the ingestor joins with
 *  `Promise.allSettled` to gate `markSatisfied` (§7 → `conversation-ingestor.ts`):
 *   - `merged` → resolved (synchronous settle, advances the floor);
 *   - `cold-absent-vacuous` → `null` (contributes nothing; an all-vacuous frame is
 *     `allSettled([])` = all-fulfilled = vacuously satisfied);
 *   - `pending-fallback` → its refetch promise (fulfilled on COMMIT advances; a
 *     rejection pins the floor via the join's every-fulfilled gate → the
 *     `rejected` terminal state);
 *   - `rejected` → a rejected promise (pins the floor). */
export function dispositionSettle(d: ProjectionDisposition): Promise<void> | null {
  switch (d.status) {
    case 'merged':
      return Promise.resolve();
    case 'cold-absent-vacuous':
      return null;
    case 'pending-fallback':
      return d.settle;
    case 'rejected':
      return Promise.reject(d.error);
  }
}

/** A projection reader: given the channel + this projection's absolute patch,
 *  merge it into every DISPLAYED surface and return one disposition per surface
 *  (empty ⇒ no displayed surface ⇒ the whole projection is vacuously satisfied). */
type ProjectionReader<K extends keyof MessageProjections> = (
  qc: QueryClient,
  channelId: string,
  patch: NonNullable<MessageProjections[K]>,
) => ProjectionDisposition[];

/** P1 reply_count reader. The replied-to root's authoritative reply count is
 *  displayed on up to two viewer-invariant surfaces — the open thread-root row
 *  and the mainline inline reply badge — so it merges into each independently.
 *  Membership-gated: a surface with no active reader / no loaded row contributes
 *  `cold-absent-vacuous`, never a bootstrap. */
function readReplyCount(
  qc: QueryClient,
  channelId: string,
  patch: ThreadRootReplyCountPatch,
): ProjectionDisposition[] {
  const { root_id, reply_count } = patch;
  const out: ProjectionDisposition[] = [];

  // Thread-root row (`useThreadRoot`) — a single-row cache; merge only when a
  // reader for THIS root is mounted. An empty snapshot (reader mounted but still
  // fetching) is cold-absent-vacuous: its own mount-fetch brings the count.
  if (openThreadRootReaderRoots(qc, channelId).includes(root_id)) {
    out.push(
      mergeThreadRootReplyCount(qc, channelId, root_id, reply_count)
        ? { status: 'merged' }
        : { status: 'cold-absent-vacuous' },
    );
  }

  // Mainline inline reply badge — merge only when a mainline reader is mounted
  // AND the root's badge is on a loaded page (else the badge isn't displayed).
  if (hasActiveMainlineReader(qc, channelId)) {
    out.push(
      mergeMainlineReplyCount(qc, channelId, root_id, reply_count)
        ? { status: 'merged' }
        : { status: 'cold-absent-vacuous' },
    );
  }

  return out;
}

/** P2 threads_list_entry reader (#task:1278, doc §5/§6). The replied-to root's
 *  authoritative viewer-invariant threads-list row is displayed on ONE surface —
 *  the channel Threads list. Merge only when a reader is mounted; then:
 *   - the page holds the root → overwrite its invariant fields + re-sort by the
 *     documented keyset → `merged` (the zero-refetch win);
 *   - the page is loaded but the root is off-page → P2 v1 does NOT insert (the
 *     server owns page-1 membership) → `pending-fallback` (invalidate→refetch,
 *     join awaits commit);
 *   - reader mounted but page not loaded → `cold-absent-vacuous` (mount-fetch
 *     recovers).
 *  No mounted reader → no displayed surface → empty (vacuous). */
function readThreadsListEntry(
  qc: QueryClient,
  channelId: string,
  patch: { entry: ThreadSummaryInvariant },
): ProjectionDisposition[] {
  if (!hasActiveChannelThreadsReader(qc, channelId)) return [];
  switch (mergeThreadsListEntry(qc, channelId, patch.entry)) {
    case 'merged':
      return [{ status: 'merged' }];
    case 'cold-absent':
      return [{ status: 'cold-absent-vacuous' }];
    case 'off-page':
      return [
        { status: 'pending-fallback', settle: invalidateChannelThreadsList(qc, channelId) },
      ];
  }
}

/** The projection reader registry (§7). One reader per projection key; the
 *  `satisfies` completeness constraint forces every `MessageProjections` key to
 *  register a reader, so a future projection can't be added to the wire without a
 *  consumer (P2 `threads_list_entry` landed here BY this constraint turning the
 *  desktop typecheck red until its reader existed). */
const PROJECTION_READERS = {
  thread_root_reply_count: readReplyCount,
  threads_list_entry: readThreadsListEntry,
} satisfies { [K in keyof MessageProjections]-?: ProjectionReader<K> };

/** Per-key association rule for the P1 `thread_root_reply_count` patch: valid only
 *  when it targets THIS frame's reply root — the frame IS a reply
 *  (`thread_root_id !== null`) AND `patch.root_id === msg.thread_root_id`. The wire
 *  self-reports `root_id` so the reader is self-sufficient, but that makes it a
 *  redundant, derivable claim; `msg.thread_root_id` is the client's AUTHORITATIVE
 *  association key. A root MISMATCH is a dirty sidecar — semantically "active but no
 *  patch" (Cindy #1277 blocker / doc §10 gate #6): the wrong root MUST NOT be merged
 *  and the frame's real root MUST keep its invalidate→refetch fallback, else a stale
 *  value strands the real update once the satisfaction floor advances. */
function isReplyCountPatchValid(
  patch: ThreadRootReplyCountPatch | undefined,
  msg: MessageDto,
): boolean {
  return (
    patch != null && msg.thread_root_id !== null && patch.root_id === msg.thread_root_id
  );
}

/** Per-key association rule for the P2 `threads_list_entry` patch: valid only when
 *  it targets THIS frame's reply root — the frame IS a reply AND
 *  `entry.root_message_id === msg.thread_root_id`. Same anti-corruption rule as P1
 *  (Cindy #1278 gate): a mismatch is a dirty sidecar → dropped, so the wrong root's
 *  row is never repositioned and the real root keeps its invalidate fallback. */
function isThreadsListEntryValid(
  patch: { entry: ThreadSummaryInvariant } | undefined,
  msg: MessageDto,
): boolean {
  return (
    patch != null &&
    msg.thread_root_id !== null &&
    patch.entry.root_message_id === msg.thread_root_id
  );
}

/** SINGLE-POINT projection validation — the anti-corruption boundary (Cindy /
 *  Alice #1277). The ingestor is the only site holding both the message and its
 *  sidecar, so it validates each projection against its OWN association key here and
 *  returns a projections object containing ONLY the validated patches; a
 *  mismatched/self-inconsistent patch is DROPPED (its key becomes `undefined`).
 *  BOTH the ingestor's fallback-suppression decision AND the registry dispatch
 *  consume this one result, so the two can never disagree — you cannot suppress
 *  rootA's fallback while still merging rootB's dirty patch. Per-key: a future P2
 *  `threads_list_entry` validates against its own key the same way. */
export function validateMessageProjections(
  projections: MessageProjections,
  msg: MessageDto,
): MessageProjections {
  return {
    thread_root_reply_count: isReplyCountPatchValid(
      projections.thread_root_reply_count,
      msg,
    )
      ? projections.thread_root_reply_count
      : undefined,
    threads_list_entry: isThreadsListEntryValid(
      projections.threads_list_entry,
      msg,
    )
      ? projections.threads_list_entry
      : undefined,
  };
}

/** Dispatch a frame's VALIDATED projections through their readers, returning the
 *  flattened per-surface dispositions the ingestor converts to settle promises.
 *  Input MUST already be run through {@link validateMessageProjections} — this stays
 *  generic (no message context): a present key is a validated patch, so it is
 *  dispatched unconditionally; a dropped (mismatched) key is `undefined` and never
 *  reaches a reader. */
export function ingestMessageProjections(
  qc: QueryClient,
  channelId: string,
  projections: MessageProjections,
): ProjectionDisposition[] {
  const out: ProjectionDisposition[] = [];
  // Explicit per-key dispatch (not a loop) so key↔patch types stay correlated
  // without a cast. Add one line per new projection alongside its reader.
  if (projections.thread_root_reply_count) {
    out.push(
      ...PROJECTION_READERS.thread_root_reply_count(
        qc,
        channelId,
        projections.thread_root_reply_count,
      ),
    );
  }
  if (projections.threads_list_entry) {
    out.push(
      ...PROJECTION_READERS.threads_list_entry(
        qc,
        channelId,
        projections.threads_list_entry,
      ),
    );
  }
  return out;
}
