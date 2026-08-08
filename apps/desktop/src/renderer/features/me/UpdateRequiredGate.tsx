/**
 * #task:1761 — full-screen gate for the desktop↔server API epoch hard gate.
 *
 * Rendered when `desktopAuthState()` classified the pair as incompatible
 * BEFORE any business DTO was read:
 *   - `direction: 'app'`    → this build is older than the server's minimum
 *     client epoch; the remedy is upgrading the app.
 *   - `direction: 'server'` → the server generation (possibly pre-epoch,
 *     classified 0) is older than this build's minimum; the remedy is
 *     upgrading the server deployment.
 *
 * Deliberately minimal: no signup/login affordances (no business state may
 * be inferred through an incompatible pair — same rule as
 * BackendUnreachableGate), just the typed explanation and a re-probe button
 * for after the other side has been upgraded.
 */
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/features/common/PrimaryAction';

export interface UpdateRequiredGateProps {
  direction: 'app' | 'server';
  serverApiEpoch: number;
  onRetry: () => void;
}

export function UpdateRequiredGate({
  direction,
  serverApiEpoch,
  onRetry,
}: UpdateRequiredGateProps): JSX.Element {
  const title =
    direction === 'app' ? 'Update Silverhand to continue' : 'Server update required';
  const description =
    direction === 'app'
      ? 'This version of the app is older than what the server supports. ' +
        'Install the latest Silverhand release, then try again.'
      : 'The server this app is connected to runs an older API generation ' +
        'than this build requires. Upgrade the server deployment, then try again.';
  return (
    <main
      data-gate="update-required"
      className="grid h-screen w-screen place-items-center bg-bg-base px-6 py-14 text-text-primary"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        // A boot gate IS a modal — it is the app's only content. Wearing the
        // same two hooks as `ui/dialog.tsx` DialogContent makes it read as one
        // (#task:1833), per theme:
        //   forza6       0 radius + 2px ink frame + hard sticker shadow
        //                (the shadow replaces the soft halo).
        //   studio-light radius unchanged (`--floating-radius` IS `--radius-md`),
        //                but the 1px frame goes away: that theme's
        //                `[data-modal-shell] { border-width: 0 }` (#task:1194,
        //                shiki "边框很奇怪") outranks both this `border` utility
        //                and `[data-popover-frame]` at (0,2,0). Intended — it is
        //                the same borderless-plus-shadow shell its real dialogs
        //                get.
        //   slack-dark   byte-identical (`--floating-border` is 1px `--border`).
        // Tailwind classes stay per the panel-radius SSOT in global.css — the
        // token rules win on source order at equal specificity.
        data-modal-shell
        data-popover-frame="info"
        className="w-full max-w-[480px] rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <header className="mb-4 flex items-center gap-2">
          {/* Bare glyph — see BackendUnreachableGate for why the warning mark
              carries no ground or frame (#task:1833). */}
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <h1 className="text-base font-semibold leading-tight">{title}</h1>
        </header>
        <p className="mb-4 text-xs leading-relaxed text-text-muted">{description}</p>
        <p className="mb-4 text-[length:var(--text-meta)] text-text-muted">
          Server API generation: {serverApiEpoch}
        </p>
        <Button
          type="button"
          size="sm"
          {...primaryAction()}
          onClick={onRetry}
        >
          <RefreshCw className="size-3.5" />
          Check again
        </Button>
      </div>
    </main>
  );
}
