import { createContext, useContext, type ReactNode } from "react";
import type { ResizableWidth } from "@/hooks/use-resizable-width";
import type { SidebarPane } from "@/hooks/use-sidebar-pane";
import type { AppSection } from "./nav-rail";
import {
  SIDEBAR_ANIMATE_LAYOUT,
  SIDEBAR_PERFORMANCE_VARIANT,
} from "./sidebar-performance-experiment";
import { VerticalSplitter } from "./vertical-splitter";

/** Sections whose left column is a browse sidebar the titlebar toggle and ⌘\ hide. */
export function hasCollapsibleSidebar(section: AppSection): boolean {
  return (
    section === "chat" || section === "members" || section === "computers" || section === "settings"
  );
}

/** One visibility and one width for every section's browse sidebar. */
export interface SidebarLayout {
  pane: SidebarPane;
  width: ResizableWidth;
}

const SidebarLayoutContext = createContext<SidebarLayout | null>(null);

export const SidebarLayoutProvider = SidebarLayoutContext.Provider;

function useSidebarLayout(): SidebarLayout {
  const layout = useContext(SidebarLayoutContext);
  if (!layout) {
    throw new Error("SidebarSlot requires a SidebarLayoutProvider");
  }
  return layout;
}

/**
 * The left browse column of a section, sliding with the one shared sidebar
 * visibility and resized by its own splitter against the shared width.
 * `fill` is the compact list page, where the sidebar is the whole page and
 * never hides or resizes.
 */
export function SidebarSlot({
  fill = false,
  children,
}: {
  fill?: boolean;
  children: ReactNode;
}): JSX.Element {
  const { pane, width } = useSidebarLayout();
  const shown = fill || pane.visible;

  return (
    <>
      <div
        className={fill ? "mobile-chat-list" : "sidebar-slot"}
        data-animating={SIDEBAR_ANIMATE_LAYOUT && pane.transitioning ? "true" : undefined}
        data-performance-variant={SIDEBAR_PERFORMANCE_VARIANT}
        style={{
          flexBasis: fill ? "100%" : shown ? "var(--sidebar-width)" : "0px",
          // When hidden, eat the right-side flex gap so the sheet's
          // `gap: var(--pane-gap)` doesn't render twice around the 0-width slot.
          marginRight: shown ? "0px" : "calc(-1 * var(--pane-gap))",
        }}
        // A hidden subtree must not take focus or pointer events mid-slide.
        {...(shown ? {} : { inert: "" })}
        aria-hidden={shown ? undefined : true}
      >
        <div
          className="sidebar-surface"
          data-state={fill ? "open" : pane.surfaceState}
          style={{ width: fill ? "100%" : "var(--sidebar-width)" }}
        >
          {children}
        </div>
      </div>
      {/* The splitter outlives the hide transition: unmounting it at frame zero
       * snaps the layout 4px while the slot is still collapsing. */}
      {!fill && (pane.visible || pane.transitioning) ? (
        <VerticalSplitter onPointerDown={width.startResize} active={width.isDragging} />
      ) : null}
    </>
  );
}
