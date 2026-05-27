/**
 * D4.a Commit 5d-fixup (Cindy P1-2) — full-screen gate when the
 * configured backend is unreachable.
 *
 * Surfaces when:
 *   - The user committed a remote profile (or `dev_local_remote`)
 *     in a previous launch
 *   - On the next launch, `desktopAuthState()` (main) tried to
 *     `fetchServerInfo()` and the underlying fetch threw (DNS /
 *     TLS / refused / not running)
 *   - Main returned the typed `backend_unreachable` arm (no
 *     `signup_enabled` — unknown when the server is unreachable)
 *
 * The gate intentionally does NOT show signup/login fields — the
 * server's policy is unknown so any field choice would be a guess.
 * Users get three actions:
 *   1. **Retry** — re-issue `getAuthState()`. Useful when the user
 *      knows the server has just come back up or after fixing a
 *      VPN.
 *   2. **Open Setup Wizard** — opens the existing
 *      `SetupWizardModal` so the user can re-enter / replace the
 *      server URL. (The wizard owns "clear server profile" via its
 *      Embedded path or by re-entering `http://localhost:<port>`.)
 *   3. **Continue with embedded** — surface a copy line pointing
 *      at the `SILVERHAND_FORCE_EMBEDDED=1` recovery escape so a
 *      stuck user can boot embedded without UI.
 *
 * Cindy review boundary (P1-2 tighter constraint): the gate must
 * NOT default to "signup enabled = true/false". The renderer renders
 * just the connect/repair affordance and trusts the next
 * `getAuthState()` reload to deliver the real arm.
 */
import { AlertTriangle, RefreshCw, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dispatchOpenSetupWizard } from '@/features/setup/openWizardEvent';

export interface BackendUnreachableGateProps {
  /** The active backend's origin (e.g. `https://backend.example.test`)
   *  — what the user CAN'T reach. */
  serverUrl: string;
  /** The captured fetch error message — surfaced under a small
   *  monospace block so the user (or someone reading their
   *  screenshot) can spot DNS vs TLS vs refused. */
  message: string;
  /** Re-run `getAuthState()` via React Query refetch. */
  onRetry: () => void;
}

export function BackendUnreachableGate({
  serverUrl,
  message,
  onRetry,
}: BackendUnreachableGateProps): JSX.Element {
  const openSetupWizard = (): void => {
    // Reuses the same renderer event the App menu's "Connect to
    // backend…" item dispatches via the SetupWizardModal listener.
    dispatchOpenSetupWizard();
  };
  return (
    <main
      className="grid h-screen w-screen place-items-center bg-bg-base px-6 py-14 text-text-primary"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="w-full max-w-[480px] rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <header className="mb-4 flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md border border-border-subtle bg-bg-row-hover text-status-warning">
            <AlertTriangle className="size-4" />
          </span>
          <h1 className="text-base font-semibold leading-tight">
            Can&apos;t reach this Silverhand backend
          </h1>
        </header>
        <p className="mb-3 text-xs leading-relaxed text-text-muted">
          Silverhand has a saved server profile pointing at:
        </p>
        <p className="mb-4 break-all rounded-sm border border-border-subtle bg-bg-row-hover px-2 py-1.5 font-mono text-xs">
          {serverUrl}
        </p>
        <p className="mb-2 text-xs leading-relaxed text-text-muted">
          The connection failed before signup or login could be
          attempted. The server may be down, the network may be
          unreachable, or TLS may be misconfigured.
        </p>
        {message ? (
          <pre className="mb-4 overflow-x-auto rounded-sm border border-border-subtle bg-bg-row-hover px-2 py-1.5 font-mono text-[11px] leading-snug text-text-muted">
            {message}
          </pre>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={onRetry}
            className="w-full justify-center"
          >
            <RefreshCw className="size-3.5" />
            Retry connection
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={openSetupWizard}
            className="w-full justify-center"
          >
            <Settings className="size-3.5" />
            Open Setup Wizard&hellip;
          </Button>
        </div>
        <p className="mt-4 text-[11px] leading-snug text-text-muted">
          To boot with the embedded backend instead, relaunch
          Silverhand with{' '}
          <code className="rounded-sm border border-border-subtle bg-bg-row-hover px-1 font-mono">
            SILVERHAND_FORCE_EMBEDDED=1
          </code>
          . This skips the saved remote profile for that launch
          only; the profile is preserved.
        </p>
      </div>
    </main>
  );
}
