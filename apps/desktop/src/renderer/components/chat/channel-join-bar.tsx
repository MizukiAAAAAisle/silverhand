import { LogIn } from "lucide-react";
import { primaryAction } from "@/components/common/primary-action";

export function ChannelJoinBar({
  onJoin,
  joining,
  channelTitle,
}: {
  onJoin: () => void;
  joining: boolean;
  channelTitle?: string | null;
}): JSX.Element {
  const label = channelTitle ? `Join #${channelTitle}` : "Join channel";
  return (
    <div className="shrink-0 border-t border-border-subtle bg-bg-base px-3 py-3">
      <button
        type="button"
        data-channel-join
        onClick={onJoin}
        disabled={joining}
        aria-label={channelTitle ? `Join #${channelTitle}` : "Join channel"}
        {...primaryAction(
          "flex w-full items-center justify-center gap-2 rounded-[var(--control-radius)] bg-[var(--bg-control-primary)] px-3 py-2 text-sm font-medium text-[color:var(--text-on-control-primary)] hover:bg-[var(--bg-control-primary-hover)] disabled:pointer-events-none disabled:opacity-60",
        )}
      >
        <LogIn className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{joining ? "Joining…" : label}</span>
      </button>
    </div>
  );
}
