import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { paneChrome } from "./pane-chrome";

/**
 * The shell for a top-level section pane (Activity, Tasks, Settings, Search,
 * Saved, Archived): the outer `<main>` surface. Owns pane identity (surface
 * paint + `bg-bg-base`), not the body layout below the header. `overflow` is
 * fixed to `hidden` here; the scrolling child owns its own.
 */
export function PaneShell({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}): JSX.Element {
  return (
    <main
      className={cn("flex h-full min-w-0 flex-1 flex-col bg-bg-base", className)}
      style={{ ...paneChrome, overflow: "hidden", ...style }}
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
