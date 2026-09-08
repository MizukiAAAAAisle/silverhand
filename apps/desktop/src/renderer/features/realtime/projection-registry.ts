import type { QueryClient } from "@tanstack/react-query";
import type {
  MessageDto,
  MessageProjections,
  ThreadRootReplyCountPatch,
  ThreadSummaryInvariant,
} from "@silverhand/shared";
import {
  hasActiveMainlineReader,
  mergeMainlineReplyCount,
  mergeThreadRootReplyCount,
  openThreadRootReaderRoots,
} from "@/features/channels/hooks";
import {
  hasActiveChannelThreadsReader,
  invalidateChannelThreadsList,
  mergeThreadsListEntry,
} from "@/features/channels/useChannelThreads";

/**
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
  | { status: "merged" }
  | { status: "cold-absent-vacuous" }
  | { status: "pending-fallback"; settle: Promise<void> }
  | { status: "rejected"; error: unknown };

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
    case "merged":
      return Promise.resolve();
    case "cold-absent-vacuous":
      return null;
    case "pending-fallback":
      return d.settle;
    case "rejected":
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
        ? { status: "merged" }
        : { status: "cold-absent-vacuous" },
    );
  }

  // Mainline inline reply badge — merge only when a mainline reader is mounted
  // AND the root's badge is on a loaded page (else the badge isn't displayed).
  if (hasActiveMainlineReader(qc, channelId)) {
    out.push(
      mergeMainlineReplyCount(qc, channelId, root_id, reply_count)
        ? { status: "merged" }
        : { status: "cold-absent-vacuous" },
    );
  }

  return out;
}

function readThreadsListEntry(
  qc: QueryClient,
  channelId: string,
  patch: { entry: ThreadSummaryInvariant },
): ProjectionDisposition[] {
  if (!hasActiveChannelThreadsReader(qc, channelId)) return [];
  switch (mergeThreadsListEntry(qc, channelId, patch.entry)) {
    case "merged":
      return [{ status: "merged" }];
    case "cold-absent":
      return [{ status: "cold-absent-vacuous" }];
    case "off-page":
      return [{ status: "pending-fallback", settle: invalidateChannelThreadsList(qc, channelId) }];
  }
}

const PROJECTION_READERS = {
  thread_root_reply_count: readReplyCount,
  threads_list_entry: readThreadsListEntry,
} satisfies { [K in keyof MessageProjections]-?: ProjectionReader<K> };

function isReplyCountPatchValid(
  patch: ThreadRootReplyCountPatch | undefined,
  msg: MessageDto,
): boolean {
  return patch != null && msg.thread_root_id !== null && patch.root_id === msg.thread_root_id;
}

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

export function validateMessageProjections(
  projections: MessageProjections,
  msg: MessageDto,
): MessageProjections {
  return {
    thread_root_reply_count: isReplyCountPatchValid(projections.thread_root_reply_count, msg)
      ? projections.thread_root_reply_count
      : undefined,
    threads_list_entry: isThreadsListEntryValid(projections.threads_list_entry, msg)
      ? projections.threads_list_entry
      : undefined,
  };
}

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
      ...PROJECTION_READERS.threads_list_entry(qc, channelId, projections.threads_list_entry),
    );
  }
  return out;
}
