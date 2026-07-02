/**
 * Lightweight placeholder shown in the conversation slot while the heavy
 * ChannelView (composer, MemberStrip, avatar batch-fetch, Virtuoso init +
 * measure, and a pile of mount effects) is still deferred (#task:1170).
 *
 * WHY it exists: clicking a NavRail entry to enter chat updates the urgent
 * `appSection` immediately (rail highlight + the two cheap sidebars paint at
 * once), but the conversation pane's mount is gated on the deferred
 * `deferredSection` so its ~hundreds-of-ms commit-phase work stays off the
 * click critical path. This skeleton fills the slot during that gap so the
 * shell never shows an empty hole — and, crucially, never the previous
 * section's stale content (the skeleton is gated by destination, not
 * predecessor; see App.tsx). It is purely perceptual: the real mount work
 * still runs a beat later behind the already-painted shell.
 *
 * Deliberately data-free and cheap (no queries, no real rows, no avatar fetch,
 * one shared `animate-pulse`) — it must render in well under a frame. The shape
 * mirrors the real ChannelView 1:1 so the swap to the live view never jumps the
 * layout: same `<main>` shell (card radius/shadow + `bg-bg-chat`), an `h-12`
 * header with a member-strip cluster, message rows using ChannelView's exact
 * `flex items-start gap-3 px-2 py-1.5` rhythm with `size-8` square avatars, and
 * a composer that reproduces the `border-t` footer + bordered shell. All bars
 * are neutral utility tokens (`bg-bg-hover`) — a skeleton is chrome, never a
 * saturated status signal.
 */

// Per-row recipe: author-label width + the body-line widths beneath it. Hand-
// varied so the block reads as a conversation, not a stack of identical bars.
const ROWS: ReadonlyArray<{ author: string; lines: readonly string[] }> = [
  { author: 'w-20', lines: ['w-[60%]', 'w-[38%]'] },
  { author: 'w-28', lines: ['w-[74%]'] },
  { author: 'w-16', lines: ['w-[68%]', 'w-[52%]', 'w-[30%]'] },
  { author: 'w-24', lines: ['w-[46%]'] },
  { author: 'w-20', lines: ['w-[64%]', 'w-[34%]'] },
];

/**
 * The message-area pulse block on its own — one shared `animate-pulse` over a
 * few rows that reuse ChannelView's row geometry exactly (`flex items-start
 * gap-3 px-2 py-1.5`, `size-8` square avatar with `mt-0.5`, content capped at
 * `max-w-[85%]`). Extracted so every "a conversation's messages are loading"
 * state renders the SAME skeleton instead of an ad-hoc spinner / "加载中" text:
 * the full-pane `ConversationViewSkeleton` composes it under a header+composer,
 * while in-pane loaders (ChannelView message list, ThreadPanel root/cluster)
 * drop it straight into their already-rendered chrome.
 *
 * `className` controls how it fills its container — default `min-h-0 flex-1`
 * suits a flex-col parent; pass `absolute inset-0` for a `relative` box, etc.
 */
export function MessageRowsSkeleton({
  className = 'min-h-0 flex-1',
}: {
  className?: string;
} = {}): JSX.Element {
  return (
    <div
      className={`animate-pulse space-y-1 overflow-hidden px-4 py-3 ${className}`}
      aria-hidden
      data-conversation-rows-skeleton
    >
      {ROWS.map((row, i) => (
        <div key={i} className="flex items-start gap-3 px-2 py-1.5">
          <div className="mt-0.5 size-8 shrink-0 rounded-none bg-bg-hover" />
          <div className="min-w-0 max-w-[85%] flex-1">
            {/* Author + time line — ChannelView uses `mb-1 text-xs` here. */}
            <div className={`mb-2 h-2.5 rounded bg-bg-hover ${row.author}`} />
            <div className="space-y-1.5">
              {row.lines.map((w, j) => (
                <div key={j} className={`h-3.5 rounded bg-bg-hover ${w}`} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConversationViewSkeleton(): JSX.Element {
  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
      aria-hidden
      data-conversation-skeleton
    >
      {/* Header — matches ChannelView's `h-12` titlebar so the message area
        * below starts at the same Y as the real view. Title block on the left,
        * a member-strip cluster (square `size-6` chips, mirroring MemberStrip)
        * pushed right. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <div className="size-4 shrink-0 rounded-none bg-bg-hover" />
        <div className="h-3.5 w-36 rounded bg-bg-hover" />
        <div className="ml-auto flex items-center gap-[3px]">
          {[0, 1, 2].map(i => (
            <div key={i} className="size-6 shrink-0 rounded-none bg-bg-hover" />
          ))}
        </div>
      </header>

      {/* Message area — the shared pulse-rows block (MessageRowsSkeleton),
        * also reused by the in-pane loading states in ChannelView / ThreadPanel
        * so every "messages loading" surface reads identically. */}
      <MessageRowsSkeleton />

      {/* Composer — reproduces the `<form>` footer (`border-t … px-3 py-3`)
        * wrapping the bordered shell (`rounded-md border`), with the
        * `min-h-[60px]` input body and a footer button row (`size-7`). */}
      <div className="shrink-0 border-t border-border-subtle bg-bg-primary px-3 py-3">
        <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-floating">
          <div className="min-h-[60px] px-3 py-2">
            <div className="h-3.5 w-32 rounded bg-bg-hover" />
          </div>
          <div className="flex items-center justify-between px-2 py-1.5">
            <div className="size-7 rounded-md bg-bg-hover" />
            <div className="h-7 w-16 rounded-md bg-bg-hover" />
          </div>
        </div>
      </div>
    </main>
  );
}
