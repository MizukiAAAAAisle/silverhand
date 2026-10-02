import type { ReactNode } from "react";
import { paneChrome } from "@/components/layout/pane-chrome";

export function AgentPageLayout({
  host,
  header,
  navigation,
  children,
}: {
  host: "agent" | "side";
  header: ReactNode;
  navigation?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <main
      data-panel={host === "side" ? "side" : "detail"}
      data-profile-host={host}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={paneChrome}
    >
      {header}
      {navigation}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </main>
  );
}
