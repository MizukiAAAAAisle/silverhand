import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import {
  nativeActionBar,
  useNativeBar,
  useNativeBarPlatform,
  type NativeBarAction,
} from "./native-page-bar";
import { MobileNavigationSlot, useHeaderSectionVisible } from "./mobile-header-slot";
import { useTitlebarActionsClaim } from "./titlebar-actions";
import { usePageLive } from "@/navigation/page-stack";
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
 *
 * On compact iOS the native bar draws it: a Tab's root page shows the title
 * large, a pushed page centred, and `nativeActions` stand in for `trailing`.
 * Beside a vertical tab bar the wide layout's titlebar carries them instead.
 */
export function PaneHeader({
  icon,
  title,
  count,
  trailing,
  nativeActions = [],
  backdrop = false,
  className,
}: {
  icon: ReactNode;
  title: string;
  /** Quiet tally beside the title. Omitted when there is nothing to count. */
  count?: ReactNode;
  /** Rides the right edge — push it there with `ml-auto`. */
  trailing?: ReactNode;
  /** `trailing` as native bar buttons. */
  nativeActions?: readonly (NativeBarAction | null)[];
  /** The pane paints a backdrop the native bar lets show through. */
  backdrop?: boolean;
  className?: string;
}): JSX.Element | null {
  const [bar, handlers] = nativeActionBar(
    {
      title,
      titleAction: null,
      backdrop: backdrop || undefined,
      largeTitle: true,
      tabs: null,
      addTabs: null,
    },
    nativeActions,
  );
  const native = useNativeBar(bar, handlers);
  // Where the wide layout's titlebar carries the header's buttons, it takes
  // the ones `trailing` shows; the page hides `trailing` (vertical-bar.css).
  const visible = useHeaderSectionVisible();
  const live = usePageLive();
  const compactNative = useNativeBarPlatform();
  useTitlebarActionsClaim(visible && live && !compactNative && trailing ? nativeActions : null);

  if (native.active) {
    return native.clearance;
  }

  return (
    <header
      data-pane-header
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-border-subtle px-4",
        className,
      )}
    >
      <MobileNavigationSlot />
      <span data-pane-header-icon className="flex shrink-0 items-center text-accent">
        {icon}
      </span>
      <span data-pane-header-title className="font-serif text-sm font-semibold text-text-primary">
        {title}
      </span>
      {count !== undefined && count !== null ? (
        <span data-pane-header-count className="text-xs tabular-nums text-text-muted">
          {count}
        </span>
      ) : null}
      {trailing ? (
        // `contents` keeps desktop flex layout (children push right with
        // `ml-auto`); compact gives the slot its own grid cell.
        <span data-pane-header-trailing className="contents">
          {trailing}
        </span>
      ) : null}
    </header>
  );
}

/**
 * Wraps a pane's header and the controls under it. Compact floats it over the
 * pane's scroller, which must be the next sibling, so content scrolls beneath
 * the glass. Its height is published as `--pane-chrome-height` because
 * expanding filters changes it. Desktop lays it out as `contents`.
 *
 * `clearance="scroller"` leaves the sibling unpadded: the scroller itself
 * reserves the height at the top of its content, so it can scroll under.
 */
export function FloatingPaneChrome({
  clearance = "sibling",
  children,
}: {
  clearance?: "sibling" | "scroller";
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const pane = node?.parentElement;
    if (!node || !pane) {
      return;
    }

    // Publish once now, before sibling scrollers measure on mount.
    const publish = () => pane.style.setProperty("--pane-chrome-height", `${node.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--pane-chrome-height");
    };
  }, []);

  return (
    <div ref={ref} data-pane-chrome={clearance} className="contents">
      {children}
    </div>
  );
}
