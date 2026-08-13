import type { ReactNode } from 'react';

/**
 * The shared, presentational content column for a message row — the single
 * source of truth for WHICH default-visible sections a message shows and in
 * what order / spacing (#task:1173 P1).
 *
 * Both render paths go through this:
 *   - the live `MessageItem` fills each slot with its interactive node
 *     (popover author label, interactive Markdown, clickable attachments, the
 *     interactive `MessageReactions` row);
 *   - the static `MessageScreenshotView` fills each slot with its
 *     button/hook/portal-free node (static author span, `interactive={false}`
 *     Markdown, static attachment tiles, `ReactionChipRow`).
 *
 * ── Anti-drift contract (the point of this component) ──────────────────────
 * This props type IS the registry of a message row's adornments. EVERY slot is
 * a REQUIRED `ReactNode` — there are no optional slots and no defaults. To add
 * a new row adornment you add a new required slot here, and the type then fails
 * to compile until BOTH surfaces declare it explicitly: live by supplying a
 * node, export by supplying a node OR `null`. So "does this appear in the
 * screenshot?" is forced to a compile-time decision, and "added to live,
 * forgot the export" — the exact recurrence this task fixes (reactions were
 * invisible on screenshots) — becomes a build error rather than a silent gap.
 *
 * That is why even genuinely live-only adornments (`taskTag` = task tag,
 * `trailing` = thread-replies badge, `threadPreview` = inline reply preview)
 * are required: the export passes `null`, making its deliberate omission
 * explicit instead of implicit. The single
 * residual hole — inlining an adornment straight into the live chrome wrapper
 * without going through a slot — is left to review + the screenshot parity test
 * (the stricter "content-starve MessageItem" form is a named follow-up).
 *
 * Slots are named by SEMANTICS, never by surface (`reactions`, not
 * `liveReactions` / `exportReactions`): this layer owns order + layout, the
 * surfaces only supply the node.
 */
export interface MessageRowContentProps {
  /** User-right layout (current viewer's own messages flush right). Drives
   *  header order (time/author swap) and body text alignment. */
  alignRight: boolean;
  /** Outer column width class. Differs by surface BY DESIGN — live is
   *  responsive (`max-w-[85%]`), export is the fixed capture width
   *  (`max-w-[640px] flex-1`) — so it is supplied, not baked in. */
  columnClassName: string;
  /** Author label node (interactive popover trigger live; static span export).
   *  `null` on a grouped continuation row (#task:1737) — the author is stated
   *  once by the group head. */
  author: ReactNode;
  /** Timestamp node (a `<time>`/`<span>` with its intrinsic type styles only;
   *  the positional margin is owned by this layout). `null` on a grouped
   *  continuation row, whose time lives in the row's hover rail instead. */
  timestamp: ReactNode;
  /** Live-only below-content task tag — its own row at the message's bottom
   *  edge, ahead of `reactions` / `trailing` (#task:1185). Export passes
   *  `null`. */
  taskTag: ReactNode;
  /** Rendered markdown body, or `null` on an attachment-only message (empty
   *  content is sendable when an attachment is attached). */
  body: ReactNode;
  /** Attachment list node, or `null` when the message has no attachments. */
  attachments: ReactNode;
  /** Reaction row node, or `null` when there are no reactions. Live supplies
   *  the interactive `MessageReactions`, export the static `ReactionChipRow`. */
  reactions: ReactNode;
  /** Live-only below-content adornment: the thread-replies badge WHEN it stands
   *  alone. `null` once there are reply preview lines for it to head — it then
   *  travels inside `threadPreview`, which is the block the badge counts. Export
   *  passes `null`. */
  trailing: ReactNode;
  /** Live-only inline reply block — the badge as its header line plus the
   *  cluster's most recent replies, under ONE wash, BELOW the bottom adornment
   *  row (shiki 2026-07-31). Export passes `null`. Read-inert (see
   *  ThreadReplyPreview). Mutually exclusive with `trailing`. */
  threadPreview: ReactNode;
}

export function MessageRowContent({
  alignRight,
  columnClassName,
  author,
  timestamp,
  taskTag,
  body,
  attachments,
  reactions,
  trailing,
  threadPreview,
}: MessageRowContentProps): JSX.Element {
  return (
    <div className={columnClassName}>
      {/* Header renders only when it has something to say. A grouped
          continuation row (#task:1737) passes BOTH slots as null — its author
          is already stated by the group head and its timestamp moved to the
          row's hover rail — so the whole element (and its `mb-1`) drops out
          rather than leaving an empty band above the body. Same
          render-only-when-present shape as the bottom adornment row below. */}
      {author || timestamp ? (
        <header className={'mb-1 text-xs ' + (alignRight ? 'text-right' : '')}>
          {alignRight ? (
            <>
              {timestamp}
              <span className="ml-2 inline-block">{author}</span>
            </>
          ) : (
            <>
              {author}
              <span className="ml-2">{timestamp}</span>
            </>
          )}
        </header>
      ) : null}

      {/* The BLOCK moves to the right edge in `user-right` mode (the row is
          `flex-row-reverse` and this column hugs its content under
          `max-w-[85%]`); the TEXT inside it does not. `text-align: right` on
          prose gives a ragged LEFT edge — every line after the first starts at
          an unpredictable x, so a two-line message reads as if it were
          centred — and it inherits into every block the markdown renderer
          emits: list markers, table cells, and `pre` lines all flip too
          (shiki 2026-08-06「user-right side 感觉很奇怪」). Alignment is a
          property of the container here, not of the paragraph.

          Which is why the prose gets its OWN box (`w-fit ml-auto`) instead of
          inheriting the column's width: this side's column is as wide as its
          widest child (only this side hugs — the left column fills its cap,
          #task:2010), and an attachment strip or a code block is usually wider
          than the words above it. Left-aligned text in a box sized by something
          else dangles in mid-row; a shrink-to-fit box keeps a short message
          flush with the right edge and only lets prose that actually wraps
          reach the 85% cap — where a straight left edge is what we want.

          That same box is the bubble (shiki 2026-08-06「给消息文本内容加上一个
          有背景色的气泡」, #task:1838) — the fill belongs to the words, not to
          the row, so attachments / reactions / the adornment row / the reply
          preview all stay outside it. `alignRight` is already
          `user-right && isCurrentUser` and `isCurrentUser` implies
          `from_kind === 'user'`, so "own side + human" needs no second
          predicate. Colour + corner are per-theme tokens (see §Own-message
          bubble in global.css); only the padding is stated here, because
          spacing is this layout's business and the token cluster's is
          identity. The `max-w-full` on that box is load-bearing, not
          belt-and-braces: `w-fit` is `width: fit-content`, whose floor is the
          content's MIN-content width, and a code fence's `pre`
          (`white-space: pre`, `overflow-wrap: normal`) has a min-content width
          of its LONGEST LINE. Without the cap a long fence pushes the bubble
          straight past the column's `max-w-[85%]` and the row overflows the
          chat pane (#task:1852). Prose never showed this because
          `.markdown-body` sets `overflow-wrap: anywhere`, which DOES lower
          min-content; `pre` and `table` are the two blocks that opt out, and
          both already carry `max-width: 100%` + their own `overflow: auto`, so
          capping the bubble is what hands them a definite width to scroll
          inside. Left-aligned messages never overflowed — there the prose box
          is a plain block at the column's width, and that column now fills its
          cap (#task:2010) rather than hugging, so a fence there is as wide as
          the message column instead of as wide as its own longest line. */}
      <div data-message-body className="text-sm text-text-primary">
        {/* `body` is null on an attachment-only message (Composer allows
            sending one) — without that the bubble would render as an empty
            padded blob above the attachments. */}
        {body ? (
          <div
            className={
              alignRight
                ? 'ml-auto w-fit max-w-full rounded-[var(--message-bubble-radius)] bg-[var(--bg-message-bubble)] px-3 py-2'
                : undefined
            }
          >
            {body}
          </div>
        ) : null}
        {attachments}
      </div>

      {/* One shared bottom row — task tag · replies · reactions on a single
          line, no wrapping (shiki #task:1185). Each child is a bare inline
          element; this row owns the top spacing + alignment + gap, so they
          never stack. Renders only when at least one is present. Reversed for
          own-messages so the task tag hugs the reading (right) edge. The
          replies badge is absent from this row when it heads the reply block
          below — grouping it with the lines it counts outranks keeping it here
          (shiki 2026-07-31). */}
      {taskTag || trailing || reactions ? (
        <div
          className={
            'mt-1.5 flex flex-nowrap items-center gap-2 ' +
            (alignRight ? 'flex-row-reverse' : '')
          }
        >
          {taskTag}
          {trailing}
          {reactions}
        </div>
      ) : null}

      {/* The reply block — badge header + preview lines under one wash. Its own
          block below the adornment row: the lines are full-width, so they never
          share a line with anything else. */}
      {threadPreview}
    </div>
  );
}
