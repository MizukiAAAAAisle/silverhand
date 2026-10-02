import type { CachedMessage } from "@/features/channels/pending-message";
import { authorGroupKey as authorDtoGroupKey, isSameAuthorGroup } from "./author-presentation";
import type { StreamItem } from "./group-messages";

/** How long after the previous row a message may still join its group.
 *  5 minutes — Slack's observed window (Discord uses ~7min); it absorbs one
 *  author's burst while keeping two separate visits to the channel separate.
 *  Matches `ACTIVITY_RUN_GAP_MS`, the same 5-minute judgement for activity
 *  runs, so the stream has ONE notion of "still the same breath". */
export const AUTHOR_GROUP_GAP_MS = 5 * 60 * 1000;

/** Stable author identity for grouping, or `null` when the row has no
 *  groupable author. Delegates to the {@link authorDtoGroupKey} seam over the
 *  server-authoritative `author` DTO: system rows (`author === null`) and
 *  `unresolved` authors (no recoverable id) return `null` and stay full rows;
 *  `active`/`deleted` authors key by their stable `kind:id`. */
export function authorGroupKey(m: CachedMessage): string | null {
  return authorDtoGroupKey(m.author);
}

/** Whether `current` continues the author group that `previous` belongs to —
 *  same author, close enough in time, same local day. Callers must additionally
 *  guarantee adjacency (nothing rendered between the two); that is
 *  {@link authorGroupContinuations}' job.
 *
 *  A negative delta (`current` older than `previous`) never groups: a pending
 *  row is stamped with the local wall clock while committed rows carry server
 *  time, so the two can legitimately cross. */
export function continuesAuthorGroup(current: CachedMessage, previous: CachedMessage): boolean {
  // `isSameAuthorGroup` already encodes "unresolved / system never merges".
  if (!isSameAuthorGroup(current.author, previous.author)) return false;
  const delta = current.created_at - previous.created_at;
  if (delta < 0 || delta > AUTHOR_GROUP_GAP_MS) return false;
  return isSameLocalDay(current.created_at, previous.created_at);
}

/** The ids of every message row that should render as a CONTINUATION (no
 *  avatar, no author name, timestamp moved to the hover rail). Pure function of
 *  the rendered stream — re-running it after an SSE insert yields the same
 *  answer for untouched rows, so React reconciles without churn.
 *
 *  A message id is absent from the set whenever the row leads its group, which
 *  is also the safe default: an unknown row renders its full header. */
export function authorGroupContinuations(items: readonly StreamItem[]): ReadonlySet<string> {
  const continuations = new Set<string>();
  let previous: CachedMessage | null = null;
  for (const item of items) {
    // An activity cluster is a visible block between rows — it ends the run.
    if (item.kind === "cluster") {
      previous = null;
      continue;
    }
    const message = item.message;
    // System rows (and any row without a provable author) break the run and
    // never continue one themselves.
    if (authorGroupKey(message) === null) {
      previous = null;
      continue;
    }
    if (previous !== null && continuesAuthorGroup(message, previous)) {
      continuations.add(message.id);
    }
    previous = message;
  }
  return continuations;
}

/** Same local calendar day (not "within 24h"): the group head is the only row
 *  showing a date, so a run must not cross midnight. */
function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}
