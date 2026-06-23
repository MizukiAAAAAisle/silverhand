import type { ReactionAggregateDto } from '@silverhand/shared';

/**
 * The single source of truth for how a message's reactions LOOK, plus the pure
 * static row that any non-interactive render path consumes (#task:1173).
 *
 * Background: reactions were invisible on image-export screenshots because the
 * export renderer (`MessageScreenshotView`) is a separate render path that
 * rewrote each row by hand and never rendered reactions at all — a structural
 * drift, not a missing branch. The fix is to make the reaction-chip VISUAL
 * (fill / radius / sizing / glyph + count) live in exactly one place that both
 * surfaces consume:
 *   - the live, interactive row (`MessageReactions`) layers click-to-toggle, the
 *     "who reacted" HoverCard, and the add picker on top of these primitives;
 *   - the static export row (`ReactionChipRow` below) renders the same chip DOM
 *     with ZERO buttons / hooks / portals / picker, so html-to-image stays
 *     deterministic and the "0 button / 0 portal" screenshot contract holds.
 *
 * A future restyle of a chip therefore touches only this file and flows to both
 * surfaces — reactions can't be styled in chat yet vanish from the screenshot.
 */

/** Row wrapper class shared by the live and static reaction rows so the two
 *  never drift in spacing / wrapping / alignment. Top spacing + alignment of
 *  the message's bottom row is owned by `MessageRowContent` (task tag ·
 *  replies · reactions share one line, #task:1185); this class only governs
 *  the chips' own flex/gap. */
export function reactionRowClass(alignRight: boolean): string {
  return (
    'flex flex-wrap items-center gap-1.5 ' +
    (alignRight ? 'justify-end' : 'justify-start')
  );
}

/** The chip fill recipe. `interactive` only adds the hover-fill shift; the
 *  static export chip and the read-only live chip both pass false so neither
 *  looks clickable. Chips are utility count elements (neutral
 *  `--reaction-chip-*` fill), and the viewer's own reaction is distinguished by
 *  a stronger `--accent-soft` fill, not a color reversal. */
export function reactionChipClass(
  agg: ReactionAggregateDto,
  interactive: boolean,
): string {
  return (
    'flex h-[18px] items-center gap-1 rounded-[var(--chip-radius)] px-2 text-xs tabular-nums text-text-primary transition-colors ' +
    (agg.viewer_reacted
      ? 'bg-[var(--accent-soft)]'
      : interactive
        ? 'bg-[var(--reaction-chip-bg)] hover:bg-[var(--reaction-chip-bg-hover)]'
        : 'bg-[var(--reaction-chip-bg)]')
  );
}

/** Emoji glyph + count — the inner content shared by every chip variant. */
export function ReactionChipBody({
  agg,
}: {
  agg: ReactionAggregateDto;
}): JSX.Element {
  return (
    <>
      <span className="text-[13px] leading-none">{agg.emoji}</span>
      <span
        className={
          'font-semibold ' +
          (agg.viewer_reacted ? 'text-text-primary' : 'text-text-muted')
        }
      >
        {agg.count}
      </span>
    </>
  );
}

/** Accessible label for a single chip (also asserted by the screenshot parity
 *  test, so it stays in sync across surfaces). */
export function reactionChipCountLabel(agg: ReactionAggregateDto): string {
  return `${agg.emoji}, ${agg.count} reaction${agg.count === 1 ? '' : 's'}`;
}

/**
 * Pure, NON-interactive reaction-chip row — the visible-content exit for a
 * message's reactions in any static render path.
 *
 * Renders nothing when the message has no reactions. Contains zero buttons,
 * hooks, portals, or picker. The interactive counterpart is `MessageReactions`.
 */
export function ReactionChipRow({
  reactions,
  alignRight = false,
}: {
  reactions: readonly ReactionAggregateDto[] | null | undefined;
  alignRight?: boolean;
}): JSX.Element | null {
  if (!reactions || reactions.length === 0) return null;
  return (
    <div data-reaction-row className={reactionRowClass(alignRight)}>
      {reactions.map(agg => (
        <div
          key={agg.emoji}
          data-reaction-chip
          aria-label={
            reactionChipCountLabel(agg) +
            (agg.viewer_reacted ? ', you reacted' : '')
          }
          className={reactionChipClass(agg, false)}
        >
          <ReactionChipBody agg={agg} />
        </div>
      ))}
    </div>
  );
}
