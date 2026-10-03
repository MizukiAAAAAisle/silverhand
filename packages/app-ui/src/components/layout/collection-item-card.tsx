/**
 * `<CollectionItemCard>` — the ONE shell for every side-panel "collection item"
 * card: Search results, Saved messages, Archived channels, Activity rows,
 * channel Thread rows, and channel Attachment rows. These are all the same
 * product concept — a card in a scrollable side-panel list — so they share one
 * frame and one hover language, and drift between them (the bug that motivated
 * this: thread/attachment had forked their own hooks + copy-pasted shells) can't
 * recur.
 *
 * Contract — the shell owns the FRAME and its hook, nothing else:
 *   • Frame identity: `--row-radius` corner, `--control-border-width` border,
 *     `border-border` + `bg-bg-floating` ground, `transition` (via
 *     `COLLECTION_CARD_CLASS`).
 *   • The `data-collection-card` hook, so each theme paints ONE hover rule
 *     (`[data-collection-card]:hover`) — poster = ink border + poster shadow +
 *     lift; slack/warm = bg veil + soft lift. Hover is the only state the shared
 *     theme layer paints; focus stays per-consumer (only the interactive
 *     consumers carry a `focus-visible` ring, on their own element), and there
 *     is no shared selected/disabled contract (no consumer has one).
 *   • Element type is the consumer's via `as` — Search/Saved(role)/Thread are
 *     interactive-as-button, Archived/Activity/Attachment are `<div>` wrappers
 *     (Attachment MUST stay a `<div>`: it holds a main-preview button + two
 *     sibling action buttons, so a `<button>` shell would nest buttons).
 *
 * The shell does NOT own inner content: layout, padding, overflow, gap, and any
 * inner element (icon square via `data-collection-card-icon`, attachment action
 * stamps via `data-attachment-row-action`) stay consumer-owned. Pass those
 * through `className` + `children`; everything else (handlers, `role`,
 * `tabIndex`, `type`, `aria-*`) spreads onto the rendered element.
 *
 * Loading skeletons mirror `COLLECTION_CARD_CLASS` directly and
 * deliberately omit the hook — a loading placeholder must stay hover-inert.
 */

import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

/** Frame-only class: corner + border + ground + transition. Exported for the
 *  loading skeleton, which needs the frame WITHOUT the hover hook. Live cards
 *  should render `<CollectionItemCard>` rather than spread this by hand. */
export const COLLECTION_CARD_CLASS =
  "rounded-[var(--row-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating transition";

type CollectionItemCardProps<T extends ElementType> = {
  /** Rendered element. Defaults to `div`; interactive consumers pass `button`
   *  (or keep `div` + `role="button"`). Attachment must stay `div`. */
  as?: T;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

export function CollectionItemCard<T extends ElementType = "div">({
  as,
  className,
  children,
  ...rest
}: CollectionItemCardProps<T>): JSX.Element {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag
      className={className ? `${COLLECTION_CARD_CLASS} ${className}` : COLLECTION_CARD_CLASS}
      {...rest}
      // The theme-paint marker is spread LAST so a consumer's passthrough props
      // can never override or drop it — the shell always owns the hook, which is
      // the whole point of routing every card through here.
      data-collection-card=""
    >
      {children}
    </Tag>
  );
}
