import { TaskStatusSchema, type TaskStatus } from "@silverhand/shared";
import type { PersonOption } from "./task-filters";

/**
 * The board's aggregate read faces as a surface must consume them (#task:1885,
 * Cindy MUST FIX).
 *
 * UNKNOWN IS A THIRD STATE. It is not zero and it is not an empty set. The
 * counts face always carries all five statuses (the server fills a status with no
 * rows as `0`), and an empty facet set is a real answer about a workspace whose
 * visible population really is empty — so neither value can be inspected to find
 * out whether an answer arrived at all (Alice). The missing bit lives ONLY in the
 * query state, which is why it is carried here in the type rather than smuggled
 * through a zeroed fallback: `ZERO_COUNTS` / `EMPTY_FACETS` made a cold load and
 * a failed read indistinguishable from an authoritative "nothing", so a column
 * whose body held rows could still print a `0` in its header.
 *
 * `known: true` is granted by DATA, not by a success flag, which is what gives a
 * warm cache React Query's stale-data semantics for free: a background refetch
 * that fails leaves the last good answer in place instead of dropping the surface
 * back to unknown.
 */
export type BoardAuthority<T> = { known: false; failed: boolean } | { known: true; value: T };

/** Project one query's state onto the authority contract. */
export function boardAuthority<T>(query: {
  data: T | undefined;
  isError: boolean;
}): BoardAuthority<T> {
  if (query.data !== undefined) return { known: true, value: query.data };
  return { known: false, failed: query.isError };
}

/** Narrow an authority read to one field of it. Unknown stays unknown — there is
 *  no field of an answer that never arrived. */
export function mapBoardAuthority<A, B>(
  read: BoardAuthority<A>,
  select: (value: A) => B,
): BoardAuthority<B> {
  return read.known ? { known: true, value: select(read.value) } : read;
}

// ── Counts ─────────────────────────────────────────────────────────

/** Per-status totals under the current filters — always all five statuses. */
export type BoardCounts = Readonly<Record<TaskStatus, number>>;

/**
 * "Active" = everything before a terminal status. ONE definition, consumed by
 * the global Tasks section's active-count label and kept distinct from the
 * board header's total below, so the two numbers cannot disagree about what
 * they mean (`done` is completed and `closed` is shelved — neither is work in
 * hand).
 *
 * Every reader below takes the AUTHORITY, not a `BoardCounts`, and returns `null`
 * when it is unknown: a consumer therefore cannot obtain a number without
 * deciding what to show in the absence of one.
 */
export function activeTaskCount(counts: BoardAuthority<BoardCounts>): number | null {
  if (!counts.known) return null;
  const c = counts.value;
  return c.todo + c.in_progress + c.in_review;
}

/** Every status under the current filters — the board header's own total. */
export function totalTaskCount(counts: BoardAuthority<BoardCounts>): number | null {
  if (!counts.known) return null;
  return TaskStatusSchema.options.reduce((sum, s) => sum + counts.value[s], 0);
}

/** One column header's total. Independent of that column's own body read: a
 *  loaded body with unknown counts shows its rows and no number, and a known `0`
 *  with a failed body read shows the number and the body's error. */
export function boardColumnTotal(
  counts: BoardAuthority<BoardCounts>,
  status: TaskStatus,
): number | null {
  return counts.known ? counts.value[status] : null;
}

/** Stands in for a count nobody has been told yet. A dash rather than a blank so
 *  the header keeps its shape while the number is unknown, and rather than `0` so
 *  it never reads as an answer. */
export const UNKNOWN_COUNT = "–";

export function boardCountLabel(value: number | null): string {
  return value === null ? UNKNOWN_COUNT : String(value);
}

// ── Facets ─────────────────────────────────────────────────────────

/** The filter menus' option sets. */
export interface BoardFacets {
  assignees: PersonOption[];
  creators: PersonOption[];
  hasUnassigned: boolean;
}

/**
 * What a person menu may say about its population.
 *
 * `empty` is a CLAIM ("this viewer has nobody to filter by") and is reachable
 * only from a successful read. An unknown population reports `loading` / `failed`
 * instead, so a cold failure cannot present itself as an empty workspace.
 */
export type PersonMenuState = "ready" | "empty" | "loading" | "failed";

export function personMenuState(options: BoardAuthority<PersonOption[]>): PersonMenuState {
  if (!options.known) return options.failed ? "failed" : "loading";
  return options.value.length === 0 ? "empty" : "ready";
}
