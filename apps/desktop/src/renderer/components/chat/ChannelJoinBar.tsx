import { LogIn } from 'lucide-react';

/**
 * The composer-slot affordance for a workspace user browsing a PUBLIC channel
 * they have NOT joined. It replaces the real composer: a non-member
 * reads the channel (history + threads + inline attachment previews) but cannot
 * post until they join. Joining is one explicit action; the cache converges to
 * `member` only on the server's 200 (see `useJoinChannel`), so a failed join
 * leaves the viewer a non-member and this bar in place.
 *
 * Structure is ONE action, no status prose: an outer box gives breathing room
 * on the reading surface (`bg-bg-chat` + a top `border-t` for hierarchy — it
 * extends the message area, not a distinct composer dock, so it never reads as
 * a gray function band), and a single full-width button carries the whole
 * affordance. The absent composer already communicates "you cannot post yet",
 * so no explanatory sentence is added.
 *
 * The button fills with the selection-row identity (`--bg-row-selected`,
 * falling back to `--bg-selected`) so it reads as "step into this channel" in
 * each theme's own vocabulary — brand blue in slack-dark, warm tint in
 * warm-script. forza6 paints the whole button as a poster sticker via the
 * theme-neutral `data-channel-join` hook (see forza6-components.css); other
 * themes take the flat fill unchanged.
 */
export function ChannelJoinBar({
  onJoin,
  joining,
  channelTitle,
}: {
  onJoin: () => void;
  joining: boolean;
  channelTitle?: string | null;
}): JSX.Element {
  const label = channelTitle ? `Join #${channelTitle}` : 'Join channel';
  return (
    <div className="shrink-0 border-t border-border-subtle bg-bg-chat px-3 py-3">
      <button
        type="button"
        data-channel-join
        onClick={onJoin}
        disabled={joining}
        aria-label={channelTitle ? `Join #${channelTitle}` : 'Join channel'}
        className="flex w-full items-center justify-center gap-2 rounded-[var(--control-radius)] bg-[var(--bg-row-selected,var(--bg-selected))] px-3 py-2 text-sm font-medium text-text-on-selected transition-[filter,box-shadow,transform] hover:brightness-95 disabled:pointer-events-none disabled:opacity-60"
      >
        <LogIn className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{joining ? 'Joining…' : label}</span>
      </button>
    </div>
  );
}
