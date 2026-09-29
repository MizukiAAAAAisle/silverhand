import { useCompactLayout } from "@/navigation/layout";
import type { ReactNode } from "react";
import { SectionLayer } from "./section-layer";
import { Sidebar } from "./sidebar";
import { paneChrome } from "./pane-chrome";

export interface DirectoryLifecycle {
  mounted: boolean;
  visible: boolean;
}

/** Keep page controllers mounted; defer only their expensive presentation. */
export function DirectoryShell({
  mounted,
  visible,
  name,
  sidebar,
  children,
  splitter,
  selected = false,
}: DirectoryLifecycle & {
  name: string;
  selected?: boolean;
  sidebar: ReactNode;
  children: ReactNode;
  splitter?: ReactNode;
}): JSX.Element | null {
  const compact = useCompactLayout();
  if (!mounted) {
    return null;
  }

  return (
    <SectionLayer visible={visible}>
      {compact ? (
        selected ? (
          children
        ) : (
          <Sidebar name={name} sidebar={sidebar} fill />
        )
      ) : (
        <Sidebar name={name} width="var(--sidebar-width)" sidebar={sidebar} splitter={splitter}>
          {children}
        </Sidebar>
      )}
    </SectionLayer>
  );
}

export function DirectorySidebar({ children }: { children: ReactNode }): JSX.Element {
  return <nav className="scrollbar-hide flex-1 overflow-y-auto py-1.5">{children}</nav>;
}

export function DirectoryPlaceholder({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main
      data-panel="detail"
      className="flex h-full flex-1 items-center justify-center text-sm text-text-muted"
      style={{ ...paneChrome, overflow: "hidden" }}
    >
      {children}
    </main>
  );
}
