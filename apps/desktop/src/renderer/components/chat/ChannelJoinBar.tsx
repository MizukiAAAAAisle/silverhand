import { LogIn } from 'lucide-react';
import { primaryAction } from '@/features/common/PrimaryAction';

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
 * The button is the app's primary CTA — the green `--bg-control-primary` fill
 * plus `primaryAction()` (shiki 2026-07-26: "Public channel 底部的那个 Join
 * channel 按钮的颜色也改成这次的绿色"). It used to fill with the selection-row
 * identity (`--bg-row-selected`), which read as "this row is selected" rather
 * than "commit": in forza6 that is acid lime, the same paint as the selected
 * sidebar row, and the composer slot's ONE action is a commit, not a selection.
 * Joining it to the CTA family also means it inherits the poster sticker (2px ink
 * frame, hard ink shadow that peels on hover) from one place instead of its own
 * copy; the `data-channel-join` hook stays only for the press-stamp, which is
 * this button's own tactile detail.
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
        {...primaryAction(
          'flex w-full items-center justify-center gap-2 rounded-[var(--control-radius)] bg-[var(--bg-control-primary)] px-3 py-2 text-sm font-medium text-[color:var(--text-on-control-primary)] hover:bg-[var(--bg-control-primary-hover)] disabled:pointer-events-none disabled:opacity-60',
        )}
      >
        <LogIn className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{joining ? 'Joining…' : label}</span>
      </button>
    </div>
  );
}
