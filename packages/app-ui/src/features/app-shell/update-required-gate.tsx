import { OpenExternalIcon, RefreshIcon, WarningIcon } from "@/icons";
import { Button } from "@/components/ui/button";
import { AppUpdateInline } from "@/features/app-update/app-update-inline";
import { useAppUpdateState } from "@/features/app-update/app-update-store";
import { getPlatform } from "@/platform";

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
  const appUpdate = useAppUpdateState();
  const inline = direction === "app" && appUpdate !== null;
  const storeUrl = direction === "app" && !inline ? getPlatform().storeUrl : undefined;
  const title = direction === "app" ? "Update Silverhand to continue" : "Server update required";
  const description = inline
    ? "This version of the app is older than what the server supports."
    : direction === "app"
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
        className="w-full max-w-120 rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <header className="mb-4 flex items-center gap-2">
          <WarningIcon className="size-5 shrink-0 text-warning" />
          <h1 className="text-base font-semibold leading-tight">{title}</h1>
        </header>
        <p className="mb-4 text-xs leading-relaxed text-text-muted">{description}</p>
        <p className="mb-4 text-(length:--text-meta) text-text-muted">
          Server API generation: {serverApiEpoch}
        </p>
        {inline ? (
          <AppUpdateInline state={appUpdate} onRecheck={onRetry} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {storeUrl ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void getPlatform().files.openExternal(storeUrl)}
              >
                <OpenExternalIcon className="size-3.5" />
                Update in App Store
              </Button>
            ) : null}
            <Button
              type="button"
              variant={storeUrl ? "neutral" : "primary"}
              size="sm"
              onClick={onRetry}
            >
              <RefreshIcon className="size-3.5" />
              Check again
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
