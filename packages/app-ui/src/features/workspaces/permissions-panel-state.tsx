import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Empty state of a permissions panel: a bare icon and one line, no frame. */
export function PanelEmpty({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <span className="text-text-muted/50">{icon}</span>
      <p className="text-sm text-text-muted">{children}</p>
    </div>
  );
}

/** Load failure of a permissions panel, with a retry. */
export function PanelError({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-error">
      Failed to load members.
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
