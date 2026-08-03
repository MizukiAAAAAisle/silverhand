/**
 * Consecutive-same-author message grouping (#task:1737).
 *
 * A person (or agent) firing three messages in a row currently renders three
 * full rows — avatar + name + timestamp repeated each time. That reads as
 * "three separate events" and shreds the vertical rhythm, when it is really
 * "one author said a few things". Slack / Discord / iMessage all collapse such
 * a run: the FIRST row keeps the full header, the rest drop avatar + name and
 * keep only their body, aligned to the same text baseline.
 *
 * This module owns the DECISION ("is this row a continuation of the one above
 * it?") as a pure predicate; the painting lives in `MessageItem`. Keeping the
 * two apart is the point — the rule is behaviour (four independent break
 * conditions worth reasoning about on their own), not a class string.
 *
 * # Why it works off `StreamItem[]` and not the raw message array
 *
 * "The row above" means the row above IN THE RENDERED STREAM, so the input has
 * to be what actually gets rendered — the post-`groupMessages` sequence, where
 * runs of task lifecycle events have already collapsed into activity clusters.
 * A cluster between two of my messages is a visible block, so it must break the
 * group; walking the raw array would miss it. Both surfaces (channel list and
 * `ThreadPanel`) already render `groupMessages` output, so a single pass over
 * that sequence is what makes ONE implementation serve both.
 *
 * This is deliberately a separate module from `groupMessages` rather than an
 * extra field on its output: activity clustering (which system rows fold into a
 * strip) and author grouping (which real rows drop their header) are orthogonal
 * concerns that happen to read the same sequence.
 *
 * # Break conditions (all four must hold to continue a group)
 *
 *  - Same author. Identity is the server-authoritative `author` DTO's stable
 *    key (`kind:id`, via {@link isSameAuthorGroup}), so a human and an agent
 *    that share a display name never merge. A now-deleted actor's rows all
 *    resolve to the same `deleted` snapshot id and so still group under one
 *    byline, while an `unresolved` author (no recoverable id) NEVER groups —
 *    two lost actors are not provably one.
 *  - Within `AUTHOR_GROUP_GAP_MS` of the PREVIOUS row (chained, as in Slack —
 *    each row is measured against the one directly above it, so a steady
 *    trickle legitimately stays one group).
 *  - Same local calendar day. A group that straddles midnight would show its
 *    head's date while the continuation's own date is invisible.
 *  - Nothing in between: a system row, an activity cluster, or another author
 *    resets the run.
 *
 * Note for whoever wires the unread separator inline: `groupMessages` already
 * splits clusters at `unreadSeparatorBeforeMessageId`, and the row right after
 * that separator must likewise start a fresh group (a continuation directly
 * under a divider would look orphaned). No caller renders that separator today,
 * so this pass does not branch on it.
 *
 * # Why the screenshot export does NOT group
 *
 * `MessageScreenshotView` deliberately keeps every row's author + timestamp.
 * An export is a standalone quotable artifact: its reader has no surrounding
 * stream, and the selection can skip messages, so "this row continues the one
 * above" would be an outright false claim on a non-contiguous excerpt. Stating
 * the author every time is the correct redundancy there, not noise. This does
 * not weaken `MessageRowContent`'s anti-drift contract — the export supplies
 * real nodes for both slots, which is an explicit choice, not a forgotten one.
 */
import type { CachedMessage } from '@/features/channels/pending-message';
import {
  authorGroupKey as authorDtoGroupKey,
  isSameAuthorGroup,
} from './author-presentation';
import type { StreamItem } from './groupMessages';

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
export function continuesAuthorGroup(
  current: CachedMessage,
  previous: CachedMessage,
): boolean {
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
export function authorGroupContinuations(
  items: readonly StreamItem[],
): ReadonlySet<string> {
  const continuations = new Set<string>();
  let previous: CachedMessage | null = null;
  for (const item of items) {
    // An activity cluster is a visible block between rows — it ends the run.
    if (item.kind === 'cluster') {
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
