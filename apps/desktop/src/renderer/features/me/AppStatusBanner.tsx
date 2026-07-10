/**
 * `#task:1462` — the single app-status banner slot.
 *
 * Both the backend-unreachable signal (`useBackendUnreachableSnitch`) and
 * the outbound-protocol skew signal (`describeProtocolSkew`) want the same
 * top-center floating slot. They are different axes and can briefly
 * co-exist, so they must NOT be two components fighting over one `fixed`
 * coordinate (the earlier split did exactly that). This component owns the
 * slot; `selectAppStatusBanner` decides which message wins
 * (`backend_unreachable > protocol_skew`).
 *
 * Boundary (inherited from the former `BackendUnreachableBanner`, Cindy
 * `MqA4uoNcRByKcf9E`): mount in `RegisteredAppShell`, NOT App root —
 * boot-time unreachability is `BackendUnreachableGate`'s full-screen job;
 * this is the non-blocking mid-session arm. The user keeps full access to
 * history / navigation / settings; the banner only informs.
 *
 * Presentation-only: reachability state lives in the snitch; the skew copy
 * matrix lives in `describeProtocolSkew`; the compat field is polled by the
 * App-level `useBackendInfoSnapshot({ pollProtocolCompatibility: true })`
 * observer and read here from the shared cache.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBackendInfoSnapshot } from '@/features/hosts/hooks';
import { useBackendUnreachableSnitch } from './useBackendUnreachableSnitch';
import { describeProtocolSkew } from './protocol-skew-presentation';
import { selectAppStatusBanner } from './app-status-banner-model';

interface BannerShellProps {
  title: string;
  detail?: string | null;
  /** Optional trailing action. The protocol-skew arms have none — the
   *  remote-only build has no in-app updater and the server-behind arm
   *  clears itself on the next poll. */
  action?: { label: string; onClick: () => void } | null;
}

function BannerShell({
  title,
  detail,
  action,
}: BannerShellProps): JSX.Element {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="pointer-events-auto fixed left-1/2 top-3 z-[60] -translate-x-1/2 transform"
      // The titlebar's drag region sits right above this; the banner owns
      // its own click target so it never gets swallowed by window drag.
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3 rounded-md border border-status-warning/30 bg-bg-floating px-3 py-2 shadow-modal">
        <span className="grid size-6 place-items-center rounded-md text-status-warning">
          <AlertTriangle className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium leading-snug text-text-primary">
            {title}
          </p>
          {detail ? (
            <p className="text-[11px] leading-snug text-text-muted">{detail}</p>
          ) : null}
        </div>
        {action ? (
          <Button
            type="button"
            variant="ghost"
            onClick={action.onClick}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            <RefreshCw className="size-3" />
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
  const skew = describeProtocolSkew(
    data?.outbound_protocol_compatibility ?? null,
  );
  const model = selectAppStatusBanner({
    unreachableVisible: unreachable.visible,
    skew,
  });
  if (!model) return null;
  if (model.kind === 'backend_unreachable') {
    return (
      <BannerShell
        title="Can't reach server"
        action={{ label: 'Retry', onClick: unreachable.retry }}
      />
    );
  }
  return <BannerShell title={model.view.title} detail={model.view.detail} />;
}
