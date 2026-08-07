import type { SVGProps } from 'react';

/**
 * The tree groups' collapse affordance — a SOLID triangle, right when collapsed
 * and down when expanded (shiki: 「折叠 icon 改成实心的三角」, 2026-08-08).
 *
 * Hand-drawn because lucide's carets are all 2px open strokes: a chevron at this
 * size reads as "there is more below", which is a scroll cue, while a filled
 * triangle is the platform's disclosure vocabulary — it reads as a hinge whose
 * direction IS the state. In the group header this glyph appears in place of the
 * section's identity icon on hover, so it has to say "operate me" in one look.
 *
 * Drawn on lucide's grid (24 viewBox, `currentColor`, `size-*` from the consumer)
 * but FILLED rather than stroked, and deliberately smaller than the 2px-stroke
 * glyphs it swaps with (11×9 of the 24 box, centroid exactly on centre): a solid
 * shape carries more visual weight per pixel than an outline, so matching their
 * bounding box would have made the hover state heavier than the resting one.
 * Bigger than this and it reads as a blob at 14px; smaller and the point mushes.
 */
export function DisclosureTriangle({
  direction,
  ...props
}: SVGProps<SVGSVGElement> & { direction: 'right' | 'down' }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      {...props}
    >
      {direction === 'down' ? (
        <path d="M6.5 9h11L12 18Z" />
      ) : (
        <path d="M9 6.5v11L18 12Z" />
      )}
    </svg>
  );
}
