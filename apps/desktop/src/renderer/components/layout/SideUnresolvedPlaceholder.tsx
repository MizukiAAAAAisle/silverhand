import { X } from 'lucide-react';

interface SideUnresolvedPlaceholderProps {
  /** The conversation id that came in via `?side=<id>` but wasn't found
   *  in the current workspace's channels lookup. Shown verbatim
   *  (truncated) so the user can correlate the broken reference with
   *  whatever they clicked. */
  conversationId: string;
  /** Dispatched close handler — same one the resolved secondary pane
   *  uses, so the X button behaves identically (clears `?side` and any
   *  paired `?fullscreen` from the URL). */
  onClose: () => void;
}

/**
 * Placeholder pane shown when `?side=<id>` points at a conversation
 * that isn't in the current workspace's channels lookup. Cindy review
 * point 6 of PR-1: do NOT silently strip the URL — the user should see
 * that the reference is broken and dismiss it explicitly.
 *
 * In PR-1 this is the only "unresolved" outcome (cross-workspace `?side`
 * is unsupported until PR-2 lands `useConversationById`/`/api/.../ref`).
 * PR-2 will replace this with a real cross-workspace fetch + a richer
 * "no permission" / "deleted" placeholder that distinguishes the cases.
 */
export function SideUnresolvedPlaceholder({
  conversationId,
  onClose,
}: SideUnresolvedPlaceholderProps): JSX.Element {
  // Truncate long ids so the placeholder doesn't overflow narrow panes.
  const shortId =
    conversationId.length > 20
      ? `${conversationId.slice(0, 8)}…${conversationId.slice(-4)}`
      : conversationId;
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
          引用无法访问
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
          className="ml-2 flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X className="size-4" strokeWidth={1.8} />
        </button>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-text-muted">
        <p>引用的会话不在当前工作区里。</p>
        <p className="font-mono text-xs text-text-disabled">#~{shortId}</p>
        <p className="text-xs text-text-disabled">
          PR-2 会接入跨工作区解析；当前点击关闭按钮即可。
        </p>
      </div>
    </main>
  );
}
