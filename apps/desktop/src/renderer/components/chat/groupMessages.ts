/**
 * Activity-cluster grouping for the message stream (PR-10).
 *
 * Background — see the discussion thread that spawned PR-10:
 * the `task_*` family (create/claim/unclaim/status) are high-frequency
 * low-priority lifecycle events. PR-1..9 cleaned each one up at the
 * single-row level, but rendering each as a "mini message row" with
 * the same vertical rhythm and weight as actual chat messages still
 * shreds the reading flow when several land in a row. Slack/Discord
 * solve this by demoting such events to muted activity narration; this
 * grouping pass is the renderer-side primitive that lets us do the same.
 * (`rename` / `session_cleared` were originally clustered too but were
 * removed in #task:1145 — they're one-off notices, not bursty, so they
 * render standalone.)
 *
 * # What this module does (and does NOT do)
 *
 * Pure transform: takes a flat `MessageDto[]` and returns a sequence
 * of `StreamItem`s, where consecutive clusterable system messages are
 * collapsed into an `ActivityCluster`. The renderer consumes this and
 * paints clusters with a lighter visual treatment (no avatar, content
 * column alignment, left rail, single-row chrome demotion).
 *
 * It does NOT:
 *  - Touch the messages themselves (no mutation, no field stripping).
 *  - Read or write any React state — pure function of its inputs so
 *    SSE inserts re-run grouping and React reconciles cleanly.
 *  - Decide which clusters render expanded/collapsed — that's a future
 *    PR-11 concern (same-task event folding); this pass is purely
 *    visual layering.
 *
 * # Algorithm
 *
 *   messages
 *     → activity runs (clusterable subtype + adjacent + 5min gap)
 *     → split by unread boundary
 *     → render
 *
 * Each rule is independent:
 *  - Subtype filter: only `CLUSTERABLE_SUBTYPES` participate. Anything
 *    else (real messages, schedule_fire, context cards, etc.) breaks
 *    the run and renders standalone.
 *  - Adjacency: the run only continues across consecutive list
 *    positions; a non-clusterable message between two clusterable ones
 *    flushes the first run and starts a fresh one after.
 *  - Time gap: even consecutive clusterable messages start a new run
 *    if `created_at` jumps by more than `ACTIVITY_RUN_GAP_MS`. Without
 *    this, an idle channel (no real messages overnight) would fold a
 *    morning's audit row into yesterday afternoon's run.
 *  - Unread boundary: a cluster that straddles the unread separator
 *    gets split into two clusters at that boundary. Without this, the
 *    cluster's visual block would span both sides of the read cursor
 *    and users would mis-read "this whole strip is read" or "this
 *    whole strip is new" depending on which half their eye lands on.
 *
 * # Cluster identity (stability under SSE inserts)
 *
 * Cluster `id` is `activity-cluster:${first.id}` — the first member's
 * message id. Rationale: appending a clusterable message that joins
 * an existing cluster grows its `messages.length` and `last.id`, but
 * `first.id` is invariant. With this id, React's reconciliation keeps
 * the cluster element mounted and only re-renders the inner row list;
 * with a more compound id like `first:last:count`, every append would
 * change the key and force an unmount/remount → visible flicker every
 * time a new audit row arrives in real time.
 */
import type { MessageDto, SystemSubtype } from '@silverhand/shared';
import {
  type CachedMessage,
  isCommittedMessage,
} from '@/features/channels/pending-message';

/** Subtypes that participate in activity clusters. Locked with @Cindy
 *  in the PR-10 design discussion, narrowed by shiki in #task:1145.
 *  Note: `task_create` IS in the set even though it's a "genesis" event —
 *  the actual anchor for the task is the task DB row + the task board, not
 *  the system message; the `task_create` system row is just another
 *  lifecycle note.
 *
 *  `rename` and `session_cleared` were REMOVED (#task:1145): they are
 *  one-off, standalone lifecycle notices (not high-frequency runs like the
 *  task_* family), so the cluster's left rail read as noise on a lone
 *  rename row. They now render standalone, without the cluster chrome. The
 *  task_* family keeps the activity-strip treatment because those genuinely
 *  arrive in bursts during active work. `task_edit` (#task:1531) joins the
 *  family for the same reason — a definition change is part of the same
 *  work burst (create → edit → claim), so excluding it would split a run
 *  into cluster / standalone / cluster. */
export const CLUSTERABLE_SUBTYPES: ReadonlySet<SystemSubtype> = new Set<SystemSubtype>([
  'task_create',
  'task_claim',
  'task_unclaim',
  'task_status',
  'task_edit',
]);

/** 5-minute window between consecutive activity events to remain in
 *  the same run. Long enough to absorb a normal flurry of task
 *  mutations during active work; short enough that an idle channel's
 *  next-day audit rows form a fresh cluster instead of being glued to
 *  yesterday's. */
export const ACTIVITY_RUN_GAP_MS = 5 * 60 * 1000;

export interface ActivityCluster {
  kind: 'cluster';
  /** Stable React key: see module docstring "Cluster identity". */
  id: string;
  messages: MessageDto[];
}

export interface SingleMessage {
  kind: 'message';
  message: CachedMessage;
}

export type StreamItem = ActivityCluster | SingleMessage;

export interface GroupMessagesOptions {
  /** When set, the unread separator is shown immediately BEFORE this
   *  message in the rendered stream. Cluster runs that would straddle
   *  this boundary are split into two clusters at the boundary so the
   *  cluster's visual block doesn't span both sides of the read
   *  cursor. Pass `null` (or omit) when no separator is being shown. */
  unreadSeparatorBeforeMessageId?: string | null;
}

/** Whether `m` is a clusterable system message. Real messages (user/agent)
 *  and optimistic pending rows are never clusterable; system messages are
 *  clusterable iff their `metadata.subtype` is in `CLUSTERABLE_SUBTYPES`. A
 *  clusterable row is always a committed server row, so this is a type guard. */
export function isClusterableMessage(m: CachedMessage): m is MessageDto {
  if (!isCommittedMessage(m)) return false;
  if (m.from_kind !== 'system') return false;
  const meta = m.metadata as Record<string, unknown> | null;
  if (meta === null) return false;
  const subtype = meta['subtype'];
  if (typeof subtype !== 'string') return false;
  return CLUSTERABLE_SUBTYPES.has(subtype as SystemSubtype);
}

/** Group consecutive clusterable system messages into `ActivityCluster`s.
 *  Pure function — running it on the same input array always produces
 *  the same output. See module docstring for the four grouping rules
 *  and the cluster-id stability rationale. */
export function groupMessages(
  messages: readonly CachedMessage[],
  options: GroupMessagesOptions = {},
): StreamItem[] {
  const out: StreamItem[] = [];
  const unreadId = options.unreadSeparatorBeforeMessageId ?? null;
  let run: MessageDto[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    const first = run[0]!;
    out.push({
      kind: 'cluster',
      id: `activity-cluster:${first.id}`,
      messages: run,
    });
    run = [];
  };

  for (const m of messages) {
    if (!isClusterableMessage(m)) {
      flushRun();
      out.push({ kind: 'message', message: m });
      continue;
    }

    // Clusterable message — try to join the current run.
    if (run.length === 0) {
      run.push(m);
      continue;
    }

    const prev = run[run.length - 1]!;
    const tooFar = m.created_at - prev.created_at > ACTIVITY_RUN_GAP_MS;
    const crossesUnread = unreadId !== null && m.id === unreadId;

    if (tooFar || crossesUnread) {
      flushRun();
    }
    run.push(m);
  }
  flushRun();
  return out;
}
