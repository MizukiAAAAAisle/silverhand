import { JoinIcon } from "@/icons";
import { t } from "@/lib/i18n";

export function ChannelJoinBar({
  onJoin,
  joining,
  channelTitle,
}: {
  onJoin: () => void;
  joining: boolean;
  channelTitle?: string | null;
}): JSX.Element {
  const label = channelTitle
    ? t("messages.joinNamed", { channel: channelTitle })
    : t("messages.joinChannel");
  return (
    <div
      data-channel-join-bar
      className="shrink-0 border-t border-border-subtle bg-(--pane-bg,var(--bg-base)) px-3 py-3"
    >
      <button
        type="button"
        data-channel-join
        data-button-action="primary"
        onClick={onJoin}
        disabled={joining}
        aria-label={
          channelTitle
            ? t("messages.joinNamed", { channel: channelTitle })
            : t("messages.joinChannel")
        }
        className="focus-outline flex w-full items-center justify-center gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-transparent bg-[var(--bg-control-primary,var(--accent))] px-3 py-2 text-sm font-medium text-[color:var(--text-on-control-primary,var(--text-on-accent))] transition-[color,background-color,border-color,box-shadow,translate] duration-150 ease-[var(--ease,ease)] hover:-translate-y-px hover:bg-[var(--bg-control-primary-hover,var(--accent-hover))] disabled:pointer-events-none disabled:opacity-60"
      >
        <JoinIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{joining ? t("messages.joining") : label}</span>
      </button>
    </div>
  );
}
