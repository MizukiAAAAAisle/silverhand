/**
 * Pure, testable seam for the owner-audit transcript's backward paging
 * (#task:2036 part ②, B2). Extracted from the `useInfiniteQuery` in
 * `audit-hooks.ts` and the flatten in `AgentChatsPane.tsx` so the "可读全文"
 * (full-text) contract can be pinned without mounting a component: the cursor
 * direction, page order, dedup, and the load-more termination condition are all
 * decided here.
 */

/**
 * The `before_seq` for the NEXT older page, or `undefined` when there is none
 * (react-query treats `undefined` as "no previous page" and stops
 * `fetchPreviousPage`).
 *
 * `getPreviousPageParam` is handed the OLDEST currently-loaded page (react-query
 * prepends older pages, so it is `pages[0]`). The exclusive cursor is that
 * page's oldest message seq — the backend window is `seq < before_seq`, so the
 * boundary row is never re-fetched. An empty page (or one with nothing older)
 * terminates paging.
 */
export function transcriptPreviousBeforeSeq(oldestLoadedPage: {
  messages: readonly { seq: number }[];
  has_more_before: boolean;
}): number | undefined {
  if (!oldestLoadedPage.has_more_before) return undefined;
  const first = oldestLoadedPage.messages[0];
  return first ? first.seq : undefined;
}

/**
 * Flatten backward-paged transcript windows into one ascending stream. Pages
 * arrive oldest-first (react-query prepends older pages) and each page is itself
 * ascending, so concatenation already preserves order; we dedup by id so a
 * refetch — or an inclusive-boundary quirk — can never double a row.
 */
export function flattenTranscriptPages<T extends { id: string }>(
  pages: readonly { messages: readonly T[] }[] | undefined,
): T[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const m of page.messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}
