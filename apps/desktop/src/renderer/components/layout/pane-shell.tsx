import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { type PanelRole, paneChrome } from "./pane-chrome";

/**
 * The shell for a top-level section pane (Activity, Tasks, Settings, Search,
 * Saved, Archived): the outer `<main>` surface. Owns pane identity (surface
 * paint via `paneChrome` + `data-panel` role), not the body layout below the
 * header. `overflow` is fixed to `hidden` here; the scrolling child owns its own.
 *
 * `width`: fixed-width column instead of the default fill (`flex-1`). Activity's
 * list is a pane in its own right that sits at a resizable width beside the
 * conversation; without it a pane fills the section.
 */
export function PaneShell({
  role = "detail",
  width,
  className,
  style,
  children,
}: {
  role?: PanelRole;
  width?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}): JSX.Element {
  return (
    <main
      data-panel={role}
      className={cn(
        "flex h-full min-w-0 flex-col",
        width == null ? "flex-1" : "shrink-0",
        className,
      )}
      style={{
        ...paneChrome,
        overflow: "hidden",
        ...(width == null ? null : { width }),
        ...style,
      }}
    >
      {children}
    </main>
  );
}

/**
 * The section pane's title bar: the `h-(--titlebar-height)` strip with the
 * bottom hairline. `icon` + `title` are the identity; `count` is the quiet
 * tally; `trailing` rides the right edge (push it with `ml-auto`).
 */
export function PaneHeader({
  icon,
  title,
  count,
  trailing,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  /** Quiet tally beside the title. Omitted when there is nothing to count. */
  count?: ReactNode;
  /** Rides the right edge — push it there with `ml-auto`. */
  trailing?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <header
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-border-subtle px-4",
        className,
      )}
    >
      <span className="flex shrink-0 items-center text-accent">{icon}</span>
      <span className="font-serif text-sm font-semibold text-text-primary">{title}</span>
      {count !== undefined && count !== null ? (
        <span className="text-xs tabular-nums text-text-muted">{count}</span>
      ) : null}
      {trailing}
    </header>
  );
}
