import { Loader2, X } from 'lucide-react';

export type SidePlaceholderStatus = 'loading' | 'unauthorized' | 'not_found';

interface SidePlaceholderProps {
  /** The conversation id that came in via `?side=<id>`. Shown verbatim
   *  (truncated) so the user can correlate the reference with whatever
   *  they clicked. */
  conversationId: string;
  /** PR-2: distinguishes the three non-resolved states surfaced by
   *  `useConversationById`. The render branches per status to give the
   *  user actionable feedback rather than the original PR-1 single
   *  "unresolved" message. */
  status: SidePlaceholderStatus;
  /** Dispatched close handler — same one the resolved secondary pane
   *  uses, so the X button behaves identically (clears `?side` and any
   *  paired `?fullscreen` from the URL). */
  onClose: () => void;
}

const STATUS_COPY: Record<
  SidePlaceholderStatus,
  { header: string; body: string; hint: string }
> = {
  loading: {
    header: '正在解析引用…',
    body: '正在加载这条会话的元信息。',
    hint: '通常一两秒内完成；如果一直停在这里，请关闭重试。',
  },
  unauthorized: {
    header: '没有访问权限',
    body: '你没有权限查看这条会话所在的工作区。',
    hint: '请联系工作区成员，或关闭这个引用。',
  },
  not_found: {
    header: '会话不存在',
    body: '这条引用指向的会话已被删除或从未存在。',
    hint: '关闭这个引用，或核对来源。',
  },
};

/**
 * Placeholder pane shown for non-resolved `?side=<id>` states. Cindy
 * review point 6 of PR-1: never silently strip the URL — the user
 * should see that the reference can't be loaded right now and have an
 * explicit Close affordance.
 *
 * PR-2: unified placeholder for the three non-resolved statuses
 * surfaced by `useConversationById` (loading / unauthorized /
 * not_found). The component is intentionally state-only — it doesn't
 * read the route or the descriptor; the parent passes the status
 * derived from the secondary descriptor.
 */
export function SideUnresolvedPlaceholder({
  conversationId,
  status,
  onClose,
}: SidePlaceholderProps): JSX.Element {
  // Truncate long ids so the placeholder doesn't overflow narrow panes.
  const shortId =
    conversationId.length > 20
      ? `${conversationId.slice(0, 8)}…${conversationId.slice(-4)}`
      : conversationId;
  const copy = STATUS_COPY[status];
  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      <header className="flex h-[var(--titlebar-height,44px)] shrink-0 items-center justify-between border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-muted">
          {copy.header}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭侧栏"
          title="关闭侧栏"
          className="ml-2 flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X className="size-4" strokeWidth={1.8} />
        </button>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-text-muted">
        {status === 'loading' ? (
          <Loader2 className="size-5 animate-spin text-text-disabled" />
        ) : null}
        <p>{copy.body}</p>
        <p className="font-mono text-xs text-text-disabled">#conv:{shortId}</p>
        <p className="text-xs text-text-disabled">{copy.hint}</p>
      </div>
    </main>
  );
}
