import type { ReactNode } from 'react';
import type { ThreadReplyPreviewRow, ThreadReplier } from '@silverhand/shared';
import { Paperclip } from 'lucide-react';

/**
 * The wire row is the SHARED contract (`@silverhand/shared`), not a renderer
 * restatement of it (Alice, #task:1746): a second local declaration of the same
 * shape type-checks fine while silently drifting the day the DTO changes. The
 * field-level contracts — `seq` is an ordering key and never a version key,
 * `preview` is a normalized Markdown SOURCE excerpt (so it is rendered as
 * ordinary text, never re-parsed as Markdown), `first_attachment_label` is the
 * canonical `Image #N` / `File #N` from the shared `resolveAttachmentLabels`
 * SSOT rather than a filename — are documented on that schema. What this file
 * owns is how those facts are DISPLAYED.
 */

/** Product contract (shiki): at most the 3 most recent replies. Enforced here
 *  as a tail slice so an over-long payload (or an optimistic append that has
 *  not been trimmed yet) still renders the NEWEST three rather than dropping
 *  the newest. */
const MAX_PREVIEW_LINES = 3;

/**
 * "The 3 most recent" as a deterministic function of `seq` rather than of
 * payload order — so an out-of-order WS append or a replayed frame cannot
 * promote a stale reply into the window or render one twice (Cindy,
 * #task:1746). Sort ascending, render the tail three.
 *
 * Exported because the CALLER needs the resolved line count before it renders:
 * an empty result means the reply badge stands alone in the bottom adornment
 * row, a non-empty one means the badge becomes this block's header line inside
 * the shared wash. Deriving that twice (once to decide, once to render) would
 * let the two answers drift.
 *
 * The `message_id` collapse is IDEMPOTENT CONVERGENCE, not version arbitration:
 * a given `message_id` always carries the same `seq` and the same persisted row,
 * so a duplicate is the same line arriving twice and either copy is equally
 * correct. A duplicate id bearing a DIFFERENT `seq` is malformed input, not a
 * newer edit — this block does not, and must not, rank it. Bounded input, so
 * this is a few comparisons per root.
 */
export function visibleThreadReplyRows(
  previews: ThreadReplyPreviewRow[] | undefined,
): ThreadReplyPreviewRow[] {
  if (!previews) return [];
  const byId = new Map<string, ThreadReplyPreviewRow>();
  for (const row of previews) {
    if (!byId.has(row.message_id)) byId.set(row.message_id, row);
  }
  return [...byId.values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_PREVIEW_LINES);
}

interface ThreadReplyPreviewProps {
  /** The lines to render, already resolved by `visibleThreadReplyRows` — the
   *  caller derives them to decide whether this block exists at all, so it
   *  passes the result rather than the raw payload. Non-empty by contract. */
  rows: ThreadReplyPreviewRow[];
  /** The reply badge, rendered as this block's HEADER LINE inside the same wash
   *  (shiki 2026-07-31: "chip 那一行跟下面的回复 rows 不要分开,整体一个背景色").
   *  It stays the caller's node — the badge owns the thread-unread modifier and
   *  the jump-to-first-unread click, neither of which this presentational block
   *  should learn. It arrives WITHOUT its own fill / corner / inset: those come
   *  from the wrapper here, because two stacked translucent fills of the same
   *  token compose darker and would draw exactly the seam this change removes. */
  badge: ReactNode;
  /** Own-message layout (flush right) — mirrors the line composition. */
  alignRight: boolean;
  /** Same human-readable action label the reply badge uses. */
  title: string;
  /** Opens the thread. Identical action to the reply badge. */
  onOpen: () => void;
  /** Author identity is resolved by the owner of the agent/human maps
   *  (MessageItem's `renderReplierAvatar`, the same call the reply chip's
   *  stacked avatars make), so this block stays purely presentational and every
   *  surface keeps ONE avatar path — including its miss behaviour. */
  renderAuthorAvatar: (
    author: ThreadReplier,
    size: number,
    key: string,
  ) => ReactNode;
  /** The author's display name, resolved by the SAME owner as the avatar so
   *  identity is one lookup, not two (`MessageItem`: `display_name` → `name` →
   *  the shared fallback, no `@` for either actor kind). A line states WHO said
   *  it, not only whose face it was (shiki 2026-07-31) — an avatar alone is
   *  recognizable in a 3-line block but not readable, and the faces already
   *  degrade to a generic avatar on a lookup miss. */
  resolveAuthorName: (author: ThreadReplier) => string;
}

/**
 * A root message's reply-cluster as ONE object under the root row: the reply
 * badge as its header line, then the most recent replies one line each, all
 * inside a single recessed wash (shiki 2026-07-31).
 *
 * ── Why the badge lives INSIDE this block ──────────────────────────────────
 * The badge counts the very lines below it, so a second surface tone between
 * them read as two unrelated adornments stacked by accident. One wash, one
 * hover, one object: hovering anywhere — badge included — lifts the whole block,
 * because the whole block performs the same action. The cost is that the badge
 * leaves the shared `taskTag · replies · reactions` line (#task:1185) whenever
 * there are lines to head; with no lines it stays on that line untouched.
 *
 * ── Read state: this block is READ-INERT ───────────────────────────────────
 * Rendering it advances NO cursor. That is not a local choice —
 * `docs/thread-unread-v1.md` §6 already states that a root message appearing in
 * the mainline viewport does not count as opening the thread, and invariant 2
 * forbids a thread cursor from falling back to the mainline one. Per-thread
 * unread stays server-scored (`GET /api/conversations/:id/unread`) and the
 * thread cursor only advances when the user actually opens the thread, up to
 * that open's `stream_head_seq`. So there is deliberately no `observe()` call,
 * no visibility gate and no per-line read state here.
 *
 * Consequently unread is expressed exactly ONCE, by the badge header
 * (`N replies · 2 new` in the unread ink). These lines are uniformly quiet:
 * they answer "what is being discussed", not "where do I resume" — and they
 * could not answer the latter anyway, since the tail three are not the unread
 * boundary when a cluster has more unread than that (the badge's click, which
 * jumps to first-unread, owns resuming).
 *
 * Rendering is unconditional (not gated on unread): gating it would collapse
 * the root row's height the moment the thread is read, and would quietly turn
 * content visibility into a second expression of read state.
 */
export function ThreadReplyPreview({
  rows,
  badge,
  alignRight,
  title,
  onOpen,
  renderAuthorAvatar,
  resolveAuthorName,
}: ThreadReplyPreviewProps): JSX.Element {
  return (
    // Not a button: it holds the badge button, and nesting buttons is invalid.
    // The wash, the corner and the hover live here so both children read as one
    // surface; the click targets stay the badge (tabbable) and the lines below.
    <div
      data-thread-reply-group
      className={
        'mt-1.5 flex w-full flex-col gap-1 rounded-[var(--chip-radius)] px-2 py-1.5 transition-colors ' +
        // A recessed WASH separates the replies from the message body above
        // (shiki 2026-07-31) — one layer only: the fill REPLACED the hairline
        // rule that used to do this job rather than stacking on top of it, and
        // there is no border / shadow / accent here. `--thread-preview-bg` /
        // `-hover` are the block's own pair (forza6 sets them lighter than the
        // chip: this wash covers a full-width multi-line area, where chip
        // strength reads as a second card; the other two themes point them
        // BACK at the chip fill, which is what keeps badge and lines reading as
        // one shape there). All three themes declare the pair — `forza6.css`
        // owns `:root`, so an omitted token inherits forza6's value instead of
        // reaching the fallback below.
        'bg-[var(--thread-preview-bg,var(--chip-bg))] hover:bg-[var(--thread-preview-bg-hover,var(--chip-bg-hover))] ' +
        (alignRight ? 'items-end' : 'items-start')
      }
    >
      {badge}
      <button
        type="button"
        // A REDUNDANT affordance: the badge above is the primary, tabbable
        // target for this exact action, so the lines stay out of the tab order
        // instead of adding a second stop to the same destination. They are
        // still a real button because a preview line looks clickable — leaving
        // it inert would make an obvious click target a dead zone. The lines are
        // truncated plain text with no nested control, so a real `<button>` is
        // correct here (no bare-click / text-selection guard needed).
        tabIndex={-1}
        onClick={onOpen}
        title={title}
        aria-label={title}
        data-thread-reply-preview
        className={
          // Same 0.25rem rhythm as the wrapper's badge→lines gap (shiki
          // 2026-07-31), so every vertical gap inside the block is equal — the
          // block reads as one list, not a header plus a tighter sub-list.
          //
          // The reply text is the FAINTEST ink on the row (shiki 2026-07-31):
          // it is an excerpt of something that lives elsewhere, so it must not
          // compete with the message body it hangs under. `--text-muted` is the
          // last ink token in the system, so the block gets its own narrower
          // token — a literal neutral faded toward each theme's ground, chosen
          // to stay at WCAG AA for normal text (this is 12px prose a reader
          // actually reads, not decoration). Every theme DECLARES it —
          // `forza6.css` owns `:root`, so the `var(…, var(--text-muted))`
          // fallback here only covers a theme that does not exist yet.
          'flex w-full flex-col gap-1 text-xs leading-tight text-[var(--thread-preview-text,var(--text-muted))] transition-colors hover:text-text-secondary focus-visible:outline-none ' +
          (alignRight ? 'items-end text-right' : 'items-start text-left')
        }
      >
      {rows.map(row => (
        <span
          key={row.message_id}
          className={
            'flex w-full min-w-0 items-center gap-1.5 ' +
            (alignRight ? 'flex-row-reverse' : '')
          }
        >
          {renderAuthorAvatar(row.author, 14, row.message_id)}
          {/* WHO said it: the mainline's own name rule, with no `@` for either
              actor kind (shiki 2026-07-31) — the avatar directly to its left
              already identifies the actor, and an `@` would read as a mention.
              Slightly stronger ink than the reply text and no colon
              separator — the weight step already reads as "name, then what they
              said", and a separator would add punctuation to every line for
              nothing. It never grows past 40% and never shrinks to an ellipsis
              stub: a truncated name identifies nobody, so the reply text keeps
              shrink priority and the name simply caps. */}
          <span className="max-w-[40%] shrink-0 truncate font-medium text-text-secondary">
            {resolveAuthorName(row.author)}
          </span>
          {/* Shrinks and truncates but never GROWS: a short reply must not
              stretch its line and push the attachment label out to the far
              edge, where the label reads as unrelated to the text it belongs
              to. The label follows the text immediately. */}
          {row.preview ? (
            <span className="min-w-0 shrink truncate">{row.preview}</span>
          ) : null}
          {row.attachment_count > 0 ? (
            // Label only, capped so it cannot squeeze the reply text to nothing
            // (canonical labels are short, but the cap also holds if a theme
            // widens the type scale).
            <span className="flex min-w-0 max-w-[40%] items-center gap-1">
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate">
                {row.first_attachment_label ?? 'Attachment'}
              </span>
              {row.attachment_count > 1 ? (
                <span className="shrink-0">+{row.attachment_count - 1}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      ))}
      </button>
    </div>
  );
}
