import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ThreadIcon } from '@/components/icons/conversation-icons';
import {
  SidePanelHeader,
  SidePanelHeaderTitle,
} from '@/components/layout/SidePanelHeader';
import { CollectionItemCard } from '@/components/layout/collection-item-card';
import type { StreamUnreadDto } from '@silverhand/shared';
import { AuthorAvatarView, AuthorName } from '@/components/chat/author-avatar-view';
import {
  authorGroupKey,
  authorStateLabel,
  presentAuthor,
} from '@/components/chat/author-presentation';
import { useAuthorAvatarObjectUrls } from '@/components/chat/author-avatar-hooks';
import { useRelativeTime } from '@/components/chat/useRelativeTime';
import { useConversationUnread } from '@/features/channels/hooks';
import {
  useChannelThreads,
  type ChannelThreadsFilter,
  type ThreadSummary,
} from '@/features/channels/useChannelThreads';

interface ChannelThreadsPanelProps {
  channelId: string;
  /** Parent channel title, shown in the header. */
  parentTitle?: string | null;
  onClose: () => void;
  /** Open one thread: App wires this to `nav.openThread(rootMessageId)`,
   *  which replaces this list with the `ThreadPanel` for that thread. */
  onOpenThread: (rootMessageId: string) => void;
}

type Author = ThreadSummary['root_author'];

// Unread-first so a dot-driven open reads left-to-right as "the reason you're
// here, then everything". Labels stay one word — the panel title already says
// "Threads".
const THREAD_TABS: { key: ChannelThreadsFilter; label: string }[] = [
  { key: 'followed-unread', label: 'Unread' },
  { key: 'all', label: 'All' },
];

/**
 * Right-pane index of every reply-cluster in one channel (#task:1073, P2).
 * Threads are otherwise discoverable only by the inline reply badge on each
 * message row — invisible in a busy channel. This list surfaces them all,
 * newest activity first, one click to open the existing `ThreadPanel`.
 *
 * A thread is NOT a conversation (it shares the parent channel's context), so
 * — like the reply-cluster pane — this panel renders outside the
 * conversation-bound `secondaryDescriptor` system and reads its own
 * channel-scoped aggregate via `useChannelThreads`.
 */
export function ChannelThreadsPanel({
  channelId,
  parentTitle,
  onClose,
  onOpenThread,
}: ChannelThreadsPanelProps): JSX.Element {
  // Two independent datasets (#task:1773), NOT one list re-sorted: `all` is the
  // full follow-agnostic channel index; `unread` is the server's `followed ∩
  // unread` subset. Mount BOTH so the exact All key always has a reader — that
  // keeps `hasActiveChannelThreadsReader` true so the central ingestor's
  // in-place merge / invalidate keeps firing — and so switching tabs is instant
  // (both stay warm).
  const all = useChannelThreads(channelId);
  const unread = useChannelThreads(channelId, 'followed-unread');
  // The per-stream unread read-model, shared by two consumers here: (1) the
  // `followed_thread_unread` boolean (same predicate the header dot reads — one
  // source, independent reads → eventual convergence; used ONLY for the initial
  // tab, never to synthesize rows) and (2) the sparse per-root unread counts the
  // rows render. Reading from `useConversationUnread` (#task:1226) keeps a single
  // source of truth — no second unread fact on `ThreadSummary`.
  const conversationUnread = useConversationUnread(channelId).data;
  const followedThreadUnread = conversationUnread?.followed_thread_unread ?? false;
  // Sparse: only roots with unread > 0 appear (absent ⇒ 0).
  const unreadByRoot = conversationUnread?.threads;

  // Open on Unread when the header dot lit this panel, so a dot-driven open
  // always lands on a non-empty target (fixes the off-page dead-end); otherwise
  // start on All. This is a ONE-TIME initial view choice read from the warm
  // cached boolean — NOT an ongoing derivation of the list from the boolean.
  const [tab, setTab] = useState<ChannelThreadsFilter>(() =>
    followedThreadUnread ? 'followed-unread' : 'all',
  );

  const active = tab === 'followed-unread' ? unread : all;
  const { threads, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    active;

  // Infinite scroll for the active dataset. The sentinel sits at the tail of the
  // scroll container; when it nears view we pull the next keyset page. Root is the
  // panel's own scroll div (NOT the viewport) so an ancestor's overflow clip is
  // respected — a viewport-rooted observer would mis-fire on a row scrolled out of
  // the container. `fetchNextPage` self-guards on hasNextPage/isFetchingNextPage,
  // so a stale closure can't double-fetch; a ref keeps the latest without
  // re-subscribing the observer every render. Re-subscribes when the tab flips
  // (the active dataset changes) or a page lands (list grows → sentinel may still
  // be in view → chain the next page).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const fetchNextPageRef = useRef(fetchNextPage);
  fetchNextPageRef.current = fetchNextPage;
  useEffect(() => {
    if (!hasNextPage) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) fetchNextPageRef.current();
      },
      { root, rootMargin: '120px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasNextPage, tab, threads.length]);

  // Byline + replier avatar bytes come STRICTLY from each thread summary's own
  // author DTOs (#task:1792 B2) — root author + stacked repliers — never a live
  // directory join, so a summary whose author is outside the loaded directory
  // (or deleted) still renders its own avatar. This surface renders only DTO
  // authors (no @-mention pills, no sender facets), so the directory is not
  // consulted at all here.
  const authors = useMemo(
    () => threads.flatMap(t => [t.root_author, ...t.repliers]),
    [threads],
  );
  const { agentAvatarUrls, humanAvatarUrls } = useAuthorAvatarObjectUrls(authors);

  // Author identity flows through the ONE shared seam (#task:1792): the
  // server-authoritative {@link MessageAuthorDto} → `presentAuthor`, so a
  // deleted root author keeps its snapshot name + neutral avatar and an
  // unresolved one degrades to "Unknown …" here exactly as in the stream. A
  // system thread root (`root_author === null`) is not an actor — it reads as
  // "System" with a neutral person square.
  const renderAuthorName = (author: Author): JSX.Element =>
    author === null ? (
      <span className="font-semibold">System</span>
    ) : (
      // The name carries its deleted state through the ONE shared primitive
      // (#task:1792 B3) — this compact surface can't drift from the stream / saved
      // rows on how a deleted author reads.
      <AuthorName
        presentation={presentAuthor(author)}
        className="font-semibold"
      />
    );

  const renderAvatar = (author: Author, size: number): JSX.Element => {
    const p = author ? presentAuthor(author) : null;
    return (
      <AuthorAvatarView
        avatar={p?.avatar ?? { variant: 'neutral-user' }}
        size={size}
        // Avatar-only face: the deleted state has no room for the visual marker,
        // so it rides the `title`/`alt` via the shared `authorStateLabel`
        // (#task:1792 B3) — a deleted replier here reads "(deleted account)" on
        // hover exactly as the byline shows the marker, never a bare name.
        label={p ? authorStateLabel(p) : 'System'}
        agentAvatarUrls={agentAvatarUrls}
        humanAvatarUrls={humanAvatarUrls}
      />
    );
  };

  return (
    <aside
      data-pane="threads-list"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-chat,transparent)]"
    >
      <SidePanelHeader onClose={onClose}>
        <SidePanelHeaderTitle
          icon={<ThreadIcon className="size-3.5 shrink-0 text-text-muted" />}
          title="Threads"
          subtitle={parentTitle ? `#${parentTitle}` : undefined}
        />
      </SidePanelHeader>

      {/* Unread / All segmented filter. Selected chip uses the theme selection
          token, never a semantic hue — it must not steal the rows' unread-dot
          volume budget (mirrors ActivityView's filter chips). Counts are each
          dataset's own loaded length; a momentary 0 during a filtered load is a
          normal loading state, not a contradiction of the header dot (the two
          are independent reads that converge). */}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        {THREAD_TABS.map(t => {
          const on = t.key === tab;
          const count = t.key === 'followed-unread' ? unread.threads.length : all.threads.length;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={on}
              className={
                'inline-flex items-center gap-1.5 border-[length:var(--control-border-width)] rounded-[var(--chip-radius)] px-2.5 py-1 text-xs font-medium transition-colors ' +
                (on
                  ? 'border-[color:var(--border-control-hover)] bg-[var(--bg-row-selected)] text-text-primary'
                  : 'border-border bg-bg-floating text-text-muted hover:border-[color:var(--border-control-hover)] hover:text-text-primary')
              }
            >
              {t.label}
              <span className={on ? 'opacity-100' : 'opacity-60'}>{count}</span>
            </button>
          );
        })}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-text-muted">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm text-text-primary">Couldn’t load threads</p>
            <p className="text-xs text-text-muted">
              The thread index isn’t available yet. Try again shortly.
            </p>
          </div>
        ) : threads.length === 0 ? (
          tab === 'followed-unread' ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <ThreadIcon className="size-6 text-text-muted/50" />
              <p className="text-sm text-text-primary">All caught up</p>
              <p className="text-xs text-text-muted">
                Threads you follow have no unread replies.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <ThreadIcon className="size-6 text-text-muted/50" />
              <p className="text-sm text-text-primary">No threads yet</p>
              <p className="text-xs text-text-muted">
                Reply to a message to start a thread — it’ll show up here.
              </p>
            </div>
          )
        ) : (
          <ul className="flex flex-col gap-1.5">
            {threads.map(t => (
              <ThreadRow
                key={t.root_message_id}
                summary={t}
                unread={unreadByRoot?.[t.root_message_id]}
                renderAuthorName={renderAuthorName}
                renderAvatar={renderAvatar}
                onOpen={() => onOpenThread(t.root_message_id)}
              />
            ))}
            {/* Keyset-pagination tail: the sentinel drives fetchNextPage via the
                IntersectionObserver above; the spinner shows only while a next
                page is in flight, so a fully-loaded list carries no chrome. */}
            {hasNextPage ? <li ref={sentinelRef} aria-hidden className="h-px" /> : null}
            {isFetchingNextPage ? (
              <li className="flex items-center justify-center py-3 text-text-muted">
                <Loader2 className="size-4 animate-spin" />
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </aside>
  );
}

interface ThreadRowProps {
  summary: ThreadSummary;
  /** Per-viewer unread for this root, from `useConversationUnread` (#task:1226).
   *  The single source of "N new" — NOT `summary.unread_count`. Absent ⇒ 0. */
  unread?: StreamUnreadDto;
  renderAuthorName: (author: Author) => JSX.Element;
  renderAvatar: (author: Author, size: number) => JSX.Element;
  onOpen: () => void;
}

function ThreadRow({
  summary,
  unread,
  renderAuthorName,
  renderAvatar,
  onOpen,
}: ThreadRowProps): JSX.Element {
  // Last-reply time lives in the activity band (reply recency, not root
  // metadata). The root's own creation time isn't surfaced — in a thread list
  // "latest activity" is the time that matters.
  const lastReplyTime = useRelativeTime(summary.last_reply_at);
  const replyLabel = `${summary.reply_count} ${
    summary.reply_count === 1 ? 'reply' : 'replies'
  }`;
  const overflow = summary.replier_total - summary.repliers.length;
  const unreadCount = unread?.unread_count ?? 0;
  const hasUnread = unreadCount > 0;

  return (
    <li>
      <CollectionItemCard
        as="button"
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      >
        {/* Band 1 — root message: sender avatar + a natural "Name: content"
            flow. shiki wants the avatar kept; the standalone byline row read as
            disjoint, so the display name folds into the preview as a bold
            prefix and the content carries the visual mass. */}
        <span className="flex items-start gap-2 px-2.5 py-2">
          <span className="mt-px flex shrink-0">
            {renderAvatar(summary.root_author, 20)}
          </span>
          <span className="line-clamp-2 break-words text-sm text-text-primary">
            {renderAuthorName(summary.root_author)}
            <span className="font-semibold">{': '}</span>
            {summary.root_preview}
          </span>
        </span>

        {/* Band 2 — reply activity. Full-width footer, hairline-separated so it
            reads as its own band rather than a column tucked under the avatar.
            Dropped entirely when there are no replies (row degrades to a single
            band; height stays content-stable). */}
        {summary.reply_count > 0 ? (
          <span className="flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5">
            {summary.repliers.length > 0 ? (
              <span className="flex items-center gap-[3px]">
                {summary.repliers.map((r, i) => (
                  // `unresolved` repliers have no id (never aggregate), so fall
                  // back to a positional key — never collapse two lost actors
                  // onto one React key.
                  <span
                    key={authorGroupKey(r) ?? `unresolved:${i}`}
                    className="flex shrink-0"
                  >
                    {renderAvatar(r, 18)}
                  </span>
                ))}
                {overflow > 0 ? (
                  <span data-avatar-ground className="flex size-[18px] shrink-0 items-center justify-center rounded-none text-[length:var(--text-badge)] font-medium text-text-muted">
                    +{overflow}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="text-xs font-medium text-text-secondary">
              {replyLabel}
            </span>
            {/* Unread hint rides right after the reply count (not right-aligned):
                followed → filled count sticker, unfollowed → soft dot. forza6
                squares both via data-thread-unread. */}
            {hasUnread ? (
              summary.viewer_following ? (
                <span
                  data-thread-unread="sticker"
                  className="shrink-0 min-w-[16px] rounded-full bg-accent px-1 text-center text-[length:var(--text-badge)] font-semibold leading-[16px] text-text-on-accent"
                  title={`${unreadCount} new`}
                  aria-label={`${unreadCount} new`}
                >
                  {unreadCount > 99 ? '99+' : unreadCount} new
                </span>
              ) : (
                <span
                  data-thread-unread="dot"
                  className="size-1.5 shrink-0 rounded-full bg-accent"
                  title={`${unreadCount} unread`}
                  aria-label={`${unreadCount} unread`}
                />
              )
            ) : null}
            <span className="text-xs leading-4 text-text-muted" aria-hidden>
              ·
            </span>
            <time
              dateTime={new Date(summary.last_reply_at).toISOString()}
              title={lastReplyTime.absolute}
              className="shrink-0 text-xs text-text-muted"
            >
              {lastReplyTime.relative}
            </time>
          </span>
        ) : null}
      </CollectionItemCard>
    </li>
  );
}
