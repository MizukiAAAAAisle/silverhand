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
 * `trailing` = thread-replies badge) are required: the export passes `null`,
 * making its deliberate omission explicit instead of implicit. The single
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
  /** Author label node (interactive popover trigger live; static span export). */
  author: ReactNode;
  /** Timestamp node (a `<time>`/`<span>` with its intrinsic type styles only;
   *  the positional margin is owned by this layout). */
  timestamp: ReactNode;
  /** Live-only below-content task tag — its own row at the message's bottom
   *  edge, ahead of `reactions` / `trailing` (#task:1185). Export passes
   *  `null`. */
  taskTag: ReactNode;
  /** Rendered markdown body. */
  body: ReactNode;
  /** Attachment list node, or `null` when the message has no attachments. */
  attachments: ReactNode;
  /** Reaction row node, or `null` when there are no reactions. Live supplies
   *  the interactive `MessageReactions`, export the static `ReactionChipRow`. */
  reactions: ReactNode;
  /** Live-only below-content adornment (the thread-replies badge). Export
   *  passes `null`. */
  trailing: ReactNode;
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
}: MessageRowContentProps): JSX.Element {
  return (
    <div className={columnClassName}>
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

      <div
        className={
          'text-sm text-text-primary ' + (alignRight ? 'text-right' : '')
        }
      >
        {body}
        {attachments}
      </div>

      {/* One shared bottom row — task tag · replies · reactions on a single
          line, no wrapping (shiki #task:1185). Each child is a bare inline
          element; this row owns the top spacing + alignment + gap, so they
          never stack. Renders only when at least one is present. Reversed for
          own-messages so the task tag hugs the reading (right) edge. */}
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
    </div>
  );
}
