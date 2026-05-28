/**
 * D4.a Commit 6 (4) — in-session "Can't reach server" banner.
 *
 * Boundary lock (Cindy `MqA4uoNcRByKcf9E`):
 *   - Mounted in `RegisteredAppShell` (NOT App root).
 *     - Boot-time unreachable is the `BackendUnreachableGate`'s job
 *       (full-screen, blocks the renderer).
 *     - This banner is the mid-session arm: the user is already
 *       past the boot gate, then a query/mutation throws
 *       `ApiError.kind === 'backend_unreachable'`.
 *   - Copy is "Can't reach server" + Retry button. **Not**
 *     "Reconnecting…" — the renderer doesn't auto-poll; the user
 *     owns the retry decision.
 *   - Retry calls `queryClient.invalidateQueries()`. The next
 *     round of queries is the liveness probe.
 *
 * Presentation only — the state machine lives in
 * `useBackendUnreachableSnitch`. This component is a thin shell
 * around the hook so the snitch's invariants can be tested
 * without React DOM.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBackendUnreachableSnitch } from './useBackendUnreachableSnitch';

export function BackendUnreachableBanner(): JSX.Element | null {
  const { visible, retry } = useBackendUnreachableSnitch();
  if (!visible) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      className="pointer-events-auto fixed left-1/2 top-3 z-[60] -translate-x-1/2 transform"
      // The titlebar's drag region is right above this; the banner
      // owns its own click target so the user can hit Retry without
      // accidentally dragging the window.
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3 rounded-md border border-status-warning/30 bg-bg-floating px-3 py-2 shadow-modal">
        <span className="grid size-6 place-items-center rounded-md text-status-warning">
          <AlertTriangle className="size-4" />
        </span>
        <p className="text-xs font-medium leading-snug text-text-primary">
          Can&apos;t reach server
        </p>
        <Button
          type="button"
          variant="ghost"
          onClick={retry}
          className="h-7 gap-1.5 px-2 text-xs"
        >
          <RefreshCw className="size-3" />
          Retry
        </Button>
      </div>
    </div>
  );
}
