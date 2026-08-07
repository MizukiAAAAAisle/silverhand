import type { SVGProps } from 'react';

/**
 * The DM glyph — two overlapping OVAL chat bubbles, hand-drawn because lucide
 * has no oval pair.
 *
 * Why not a lucide glyph: the bubble family there is square-cornered, and the
 * single square bubble is already spoken for — it is `ThreadIcon`
 * (`conversation-icons.ts`). Putting the compound square bubble on the DM group
 * made the two concepts rhyme at 14px, so the header read as a thread index
 * (shiki, 2026-08-08). Rounding the bubbles is what separates them: DM = ovals,
 * thread = square.
 *
 * Drawn on lucide's grid (24 viewBox, 2px round stroke, `currentColor`) so it
 * sits at the same optical weight as `Star` and the serif `W` beside it in the
 * sidebar's group-header family. The back bubble is a partial arc — it stops
 * where the front bubble's outline crosses it, which is what makes the pair read
 * as stacked rather than as a figure-8. Sized by the consumer's class
 * (`size-3.5`), exactly like a lucide component.
 *
 * PROPORTION (shiki: 「icon 太扁了」, 2026-08-08): the first pass used two wide
 * lozenges (6×4 and 7×5) offset almost horizontally, so the mark was a low wide
 * mass next to a `Star` that fills its box top to bottom. Both bubbles are now
 * near-circular (4.2×3.5 and 6.3×5.3) and stacked on a steeper diagonal, which
 * puts the silhouette at ~17×17 in the 24 box. Their sizes are deliberately
 * UNEQUAL: two same-size ovals read as one figure-8 at 14px no matter how the
 * arc is cut — a small bubble behind a large one is what says "two people".
 */
export function DirectMessageIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12.17 10.62A4.2 3.5 0 1 1 14.1 11.58" />
      <path d="M7.04 20.28A6.3 5.3 0 1 0 3.84 16.7L2.6 21.2Z" />
    </svg>
  );
}
