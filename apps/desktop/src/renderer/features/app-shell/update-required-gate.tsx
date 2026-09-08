import { RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { primaryAction } from "@/components/common/primary-action";

export interface UpdateRequiredGateProps {
  direction: "app" | "server";
  serverApiEpoch: number;
  onRetry: () => void;
}

export function UpdateRequiredGate({
  direction,
  serverApiEpoch,
  onRetry,
}: UpdateRequiredGateProps): JSX.Element {
  const title = direction === "app" ? "Update Silverhand to continue" : "Server update required";
  const description =
    direction === "app"
      ? "This version of the app is older than what the server supports. " +
        "Install the latest Silverhand release, then try again."
      : "The server this app is connected to runs an older API generation " +
        "than this build requires. Upgrade the server deployment, then try again.";
  return (
    <main
      data-gate="update-required"
      className="grid h-screen w-screen place-items-center bg-bg-base px-6 py-14 text-text-primary"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        data-modal-shell
        data-popover-frame="info"
        className="w-full max-w-[480px] rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <header className="mb-4 flex items-center gap-2">
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <h1 className="text-base font-semibold leading-tight">{title}</h1>
        </header>
        <p className="mb-4 text-xs leading-relaxed text-text-muted">{description}</p>
        <p className="mb-4 text-[length:var(--text-meta)] text-text-muted">
          Server API generation: {serverApiEpoch}
        </p>
        <Button type="button" size="sm" {...primaryAction()} onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Check again
        </Button>
      </div>
    </main>
  );
}
