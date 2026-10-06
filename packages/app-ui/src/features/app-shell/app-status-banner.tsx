import { RefreshIcon, WarningIcon } from "@/icons";
import { Button } from "@/components/ui/button";
import { useBackendInfoSnapshot } from "@/features/computers/hooks/hooks";
import { useBackendUnreachableSnitch } from "./use-backend-unreachable-snitch";
import { describeProtocolSkew } from "./protocol-skew-presentation";
import { selectAppStatusBanner } from "./app-status-banner-model";

interface BannerShellProps {
  title: string;
  detail?: string | null;
  /** Optional trailing action. The protocol-skew arms have none — the
   *  remote-only build has no in-app updater and the server-behind arm
   *  clears itself on the next poll. */
  action?: { label: string; onClick: () => void } | null;
}

function BannerShell({ title, detail, action }: BannerShellProps): JSX.Element {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="pointer-events-auto fixed left-1/2 top-3 z-(--z-in-dialog) -translate-x-1/2 transform"
      // The titlebar's drag region sits right above this; the banner owns
      // its own click target so it never gets swallowed by window drag.
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <div className="flex items-center gap-3 rounded-(--floating-radius) [border:var(--floating-border)] bg-bg-floating px-3 py-2 shadow-modal">
        <WarningIcon className="size-5 text-warning" />
        <div className="min-w-0">
          <p className="text-xs font-medium leading-snug text-text-primary">{title}</p>
          {detail ? (
            <p className="text-(length:--text-meta) leading-snug text-text-muted">{detail}</p>
          ) : null}
        </div>
        {action ? (
          <Button
            type="button"
            variant="ghost"
            onClick={action.onClick}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            <RefreshIcon className="size-3" />
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function AppStatusBanner(): JSX.Element | null {
  const unreachable = useBackendUnreachableSnitch();
  const { data } = useBackendInfoSnapshot();
  const skew = describeProtocolSkew(data?.outbound_protocol_compatibility ?? null);
  const model = selectAppStatusBanner({
    unreachableVisible: unreachable.visible,
    skew,
  });
  if (!model) return null;
  if (model.kind === "backend_unreachable") {
    return (
      <BannerShell
        title="Server unreachable"
        action={{ label: "Retry", onClick: unreachable.retry }}
      />
    );
  }
  return <BannerShell title={model.view.title} detail={model.view.detail} />;
}
