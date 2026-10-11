import { useEffect, useRef } from "react";
import type { TitlebarCapability } from "@silverhand/client";
import { NativeTitlebarSearch, type TitlebarSearchNav } from "@/features/search/titlebar-search";

/**
 * The wide layout's titlebar when the platform draws it natively (iOS). The
 * page keeps the state and the search results; the system bar shows the
 * sidebar toggle, the archive status and the search field above the page's
 * top safe area, which this spacer clears.
 */
export function NativeTitlebar({
  titlebar,
  sidebarShown,
  archived,
  onToggleSidebar,
  searchNav,
}: {
  titlebar: TitlebarCapability;
  /** Whether the browse sidebar shows; null hides its toggle. */
  sidebarShown: boolean | null;
  archived: boolean;
  onToggleSidebar: () => void;
  searchNav: TitlebarSearchNav;
}): JSX.Element {
  const toggleRef = useRef(onToggleSidebar);
  toggleRef.current = onToggleSidebar;

  useEffect(() => {
    void titlebar
      .sync({
        sidebar:
          sidebarShown === null
            ? null
            : { shown: sidebarShown, label: sidebarShown ? "Hide sidebar" : "Show sidebar" },
        status: archived ? "Archived" : null,
        searchPlaceholder: "Search everything",
        searchShortcut: "Search",
      })
      .catch(() => {});
  }, [titlebar, sidebarShown, archived]);

  useEffect(() => {
    const listening = titlebar.subscribe((event) => {
      if (event.kind === "toggleSidebar") {
        toggleRef.current();
      }
    });

    return () => {
      void listening.then((remove) => remove());
      void titlebar.sync(null).catch(() => {});
    };
  }, [titlebar]);

  return (
    <div className="h-[env(safe-area-inset-top,0px)] shrink-0">
      <NativeTitlebarSearch nav={searchNav} titlebar={titlebar} />
    </div>
  );
}
