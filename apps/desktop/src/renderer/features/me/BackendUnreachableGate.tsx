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
 *
 * #task:991 (shiki) — the one thing a user wants here is to fix the
 * address. The earlier build sent them into the Setup Wizard (a deep
 * entry) just to retype a URL. Now the server URL is **edited in
 * place**: a pencil icon on the URL row flips it into an input +
 * Save / Cancel. Save goes through the same `saveServerUrl` IPC the
 * Settings → Connection pane uses — that path is an Electron IPC to
 * main (rewrite daemon-config + reload the daemon), NOT a backend
 * HTTP call, so it works precisely when the backend is unreachable.
 * On a successful save we re-probe via `onRetry`: if the new address
 * is reachable the gate unmounts; if not, the save banner explains.
 *
 * Cindy review boundary (P1-2 tighter constraint): the gate must
 * NOT default to "signup enabled = true/false". The renderer renders
 * just the connect/repair affordance and trusts the next
 * `getAuthState()` reload to deliver the real arm.
 */
import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { classifyServerUrl } from '@silverhand/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  describeSaveServerUrlOutcome,
  type SaveServerUrlBanner,
} from '@/features/settings/describe-save-server-url-outcome';

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(serverUrl);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<SaveServerUrlBanner | null>(null);

  const startEdit = (): void => {
    setDraft(serverUrl);
    setBanner(null);
    setEditing(true);
  };
  const cancelEdit = (): void => {
    setEditing(false);
  };

  // Same validation contract as the Settings → Connection pane: the
  // classifier is the single source of truth for what a legal server
  // origin is, so the gate can't accept an address Settings would
  // reject.
  const trimmed = draft.trim();
  const classification =
    trimmed === ''
      ? { kind: 'empty' as const }
      : (() => {
          const c = classifyServerUrl(trimmed);
          return c.ok
            ? { kind: 'ok' as const }
            : { kind: 'reject' as const, message: c.message };
        })();
  const isUnchanged = trimmed === serverUrl.trim();
  const saveDisabled = saving || classification.kind !== 'ok' || isUnchanged;

  const onSave = async (): Promise<void> => {
    if (saveDisabled) return;
    setSaving(true);
    setBanner(null);
    try {
      const result = await window.agentHub.saveServerUrl({ serverUrl: trimmed });
      setBanner(describeSaveServerUrlOutcome(result));
      if (result.ok) {
        // Address committed + daemon reloaded. Collapse the editor and
        // re-probe: a reachable new address makes the gate unmount; an
        // unreachable one keeps us here with the banner explaining why.
        setEditing(false);
        onRetry();
      }
    } catch (err) {
      setBanner({
        tone: 'error',
        title: 'Could not save the address.',
        description: err instanceof Error ? err.message : 'Unknown error.',
      });
    } finally {
      setSaving(false);
    }
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

        {editing ? (
          <form
            className="mb-4 flex flex-col gap-2"
            onSubmit={e => {
              e.preventDefault();
              void onSave();
            }}
          >
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                type="url"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                placeholder="http://127.0.0.1:8765"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                disabled={saving}
                className="min-w-0 flex-1 font-mono text-xs"
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              <Button
                type="submit"
                size="icon"
                variant="outline"
                disabled={saveDisabled}
                title={
                  classification.kind === 'reject'
                    ? classification.message
                    : isUnchanged
                      ? 'Already set to this value.'
                      : classification.kind === 'empty'
                        ? 'Enter an address to save.'
                        : 'Save address'
                }
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={cancelEdit}
                disabled={saving}
                title="Cancel"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            {classification.kind === 'reject' && (
              <p className="text-[11px] text-error">{classification.message}</p>
            )}
          </form>
        ) : (
          <div className="mb-4 flex items-center gap-2">
            <p className="min-w-0 flex-1 break-all rounded-sm border border-border-subtle bg-bg-row-hover px-2 py-1.5 font-mono text-xs">
              {serverUrl}
            </p>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={startEdit}
              title="Edit server address"
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
        )}

        {banner && (
          <div
            role="status"
            className={cn(
              'mb-4 rounded-md border px-3 py-2 text-xs',
              banner.tone === 'error'
                ? 'border-error bg-bg-row-hover text-error'
                : banner.tone === 'success'
                  ? 'border-accent bg-bg-row-hover text-text-primary'
                  : 'border-border-subtle bg-bg-row-hover text-text-secondary',
            )}
          >
            <div className="font-medium">{banner.title}</div>
            {banner.description && (
              <div className="mt-1 text-text-muted">{banner.description}</div>
            )}
          </div>
        )}

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
        <Button type="button" onClick={onRetry} className="w-full justify-center">
          <RefreshCw className="size-3.5" />
          Retry connection
        </Button>
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
