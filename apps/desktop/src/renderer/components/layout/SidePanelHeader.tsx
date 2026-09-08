import { X } from "lucide-react";

/**
 * The fixed-height header row shared by every right-pane side panel — the agent
 * profile panel, the thread panel, the threads list, and the attachments list.
 *
 * Locks the header-height contract to the channel header's `h-12` (48px)
 * *structurally*: height, the bottom hairline, the horizontal padding, and the
 * close affordance live here once, so a panel's content can't grow the outer
 * box and drift off the channel's 48px.
 *
 * Only the header is shared, not the frame: each panel keeps its own outer
 * element because those genuinely differ (the thread panel is a
 * `<aside ref … data-pane>` with a positioned find-bar overlay; the agent panel
 * is a card `<section>` with `--card-radius` / `--card-shadow`). Forcing one
 * frame component would degrade into a soup of element / ref / bg / card props;
 * the drift-prone thing is the header row, so that is what we hoist.
 */
export function SidePanelHeader({
  children,
  actions,
  onClose,
}: {
  /** Leading/main header content — usually an icon + `<SidePanelHeaderTitle>`,
   *  or a custom identity block (avatar + name/description). It carries the
   *  row's free width (`flex-1`), so the trailing controls pin right. */
  children: React.ReactNode;
  /** Extra trailing controls rendered before the close button (search, follow,
   *  view-in-channel…). When present they + the close button sit in the
   *  `data-channel-actions` layout cluster, matching the channel header; each
   *  control carries its own forza6 `data-sticker` hook. */
  actions?: React.ReactNode;
  onClose?: () => void;
}): JSX.Element {
  const closeButton = onClose ? <SidePanelCloseButton onClose={onClose} /> : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
      {children}
      {actions ? (
        // `data-channel-actions` lays the trailing controls out only; each
        // button declares its own forza6 sticker axes.
        <div data-channel-actions className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
          {closeButton}
        </div>
      ) : onClose ? (
        // Close-only panels keep the button standalone (no `data-channel-actions`
        // wrapper); `ml-auto` pins it right when there is no `flex-1` content.
        <SidePanelCloseButton onClose={onClose} className="ml-auto" />
      ) : null}
    </header>
  );
}

function SidePanelCloseButton({
  onClose,
  className = "",
}: {
  onClose: () => void;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Close"
      title="Close"
      onClick={onClose}
      data-sticker-close
      data-sticker
      data-sticker-size="md"
      data-sticker-tone="neutral"
      className={
        "flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-outline " +
        className
      }
    >
      <X className="size-3.5" />
    </button>
  );
}

/**
 * The icon + title / subtitle idiom shared by the thread, threads-list, and
 * attachments panels. The title truncates; the subtitle is optional. Pass this
 * as `SidePanelHeader`'s children.
 */
export function SidePanelHeaderTitle({
  icon,
  title,
  subtitle,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
}): JSX.Element {
  return (
    <>
      {icon}
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium text-text-primary">{title}</div>
        {subtitle ? <div className="truncate text-xs text-text-muted">{subtitle}</div> : null}
      </div>
    </>
  );
}
