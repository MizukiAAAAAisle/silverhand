/**
 * Shared loading skeleton for the CARD-LIST surfaces — Activity, Search, Saved,
 * and Archived Channels (#task:1327). Each of those panes renders a scrollable
 * column of `data-collection-card` cards; before its query resolves it used to show an
 * ad-hoc "Loading…" / "加载中…" text (or a lone pulsing icon). This replaces all
 * four with the SAME skeleton so every "a card list is loading" surface reads
 * identically, the way `MessageRowsSkeleton` already unifies the conversation
 * panes.
 *
 * The card shell mirrors the real list row via `COLLECTION_CARD_CLASS` (same
 * `--row-radius`, `--control-border-width`, `border-border` + `bg-bg-floating`
 * ground) plus the `px-4 py-3` rhythm, so the swap to live rows never jumps the
 * layout. Two shapes, toggled by `withIcon`, cover the real rows: Search/Archived
 * lead with a `size-8` icon square, Saved/Activity carry inline meta instead.
 *
 * Deliberately data-free and cheap — one shared `animate-pulse`, neutral utility
 * bars (`bg-bg-hover`); a skeleton is chrome, never a saturated status signal.
 * Drops straight into a pane's already-rendered scroller (which owns the outer
 * `px-4 py-3`), so this only lays out the `space-y-2` card stack.
 */

import { COLLECTION_CARD_CLASS } from '@/components/layout/collection-item-card';

// Per-card recipe: the meta-line width, the title width, and the body-line
// widths beneath. Hand-varied so the stack reads as a list of real cards, not a
// column of identical bars.
const CARDS: ReadonlyArray<{
  meta: string;
  title: string;
  body: readonly string[];
}> = [
  { meta: 'w-40', title: 'w-[52%]', body: ['w-[86%]', 'w-[40%]'] },
  { meta: 'w-28', title: 'w-[64%]', body: ['w-[72%]'] },
  { meta: 'w-48', title: 'w-[44%]', body: ['w-[90%]', 'w-[58%]'] },
  { meta: 'w-32', title: 'w-[58%]', body: ['w-[66%]'] },
  { meta: 'w-36', title: 'w-[48%]', body: ['w-[80%]', 'w-[34%]'] },
];

export function ListRowsSkeleton({
  rows = 5,
  withIcon = false,
}: {
  /** How many placeholder cards to render. */
  rows?: number;
  /** Lead each card with a `size-8` icon square, matching the Search /
   *  Archived rows (Saved / Activity carry inline meta instead). */
  withIcon?: boolean;
} = {}): JSX.Element {
  const cards = CARDS.slice(0, Math.max(1, Math.min(rows, CARDS.length)));
  return (
    <div
      className="animate-pulse space-y-2"
      aria-hidden
      data-list-rows-skeleton
    >
      {cards.map((card, i) => (
        <div
          key={i}
          // Frame mirrors the real card (`COLLECTION_CARD_CLASS`) so the swap to
          // live rows never jumps; NO `data-collection-card` hook — a skeleton is inert and
          // must not pick up the per-theme hover.
          className={`${COLLECTION_CARD_CLASS} flex items-start gap-3 px-4 py-3`}
        >
          {withIcon ? (
            <div className="mt-0.5 size-8 shrink-0 rounded-md bg-bg-hover" />
          ) : null}
          <div className="min-w-0 flex-1">
            {/* meta line (where / sender / date) */}
            <div className={`h-2.5 rounded bg-bg-hover ${card.meta}`} />
            {/* title line */}
            <div className={`mt-2.5 h-3.5 rounded bg-bg-hover ${card.title}`} />
            {/* body / excerpt lines */}
            <div className="mt-2 space-y-1.5">
              {card.body.map((w, j) => (
                <div key={j} className={`h-3 rounded bg-bg-hover ${w}`} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
