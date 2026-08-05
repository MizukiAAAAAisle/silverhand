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
 * #task:991 / #task:1075 (shiki) — the one thing a user wants here
 * is to fix the address. The server URL is **edited in place**: a
 * pencil icon on the URL row flips it into an input + Save / Cancel.
 * Save uses the profile pipeline (`profile:saveWithTest`), not the
 * Settings reload IPC: at this boot gate the user may not have a
 * claimed local host yet, so a daemon reload precondition would create
 * the impossible loop "fix URL → sign in first → can't sign in because
 * URL is broken". On a successful profile save main retargets the
 * active remote handle, then we re-probe via `onRetry`.
 *
 * Cindy review boundary (P1-2 tighter constraint): the gate must
 * NOT default to "signup enabled = true/false". The renderer renders
 * just the connect/repair affordance and trusts the next
 * `getAuthState()` reload to deliver the real arm.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/features/common/PrimaryAction';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import type { SaveServerUrlBanner } from '@/features/settings/describe-save-server-url-outcome';
import { validateServerUrlDraft } from '@/features/settings/server-url-validation';
import { describeProbeOutcome } from '@/features/setup/describe-probe-outcome';
import type { DesktopProfileSaveWithTestResult } from '../../../preload/api';

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
  const [allowInsecureRemote, setAllowInsecureRemote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.silverhand.getDesktopBuildConfig()
      .then(config => {
        if (!cancelled) setAllowInsecureRemote(config.allow_insecure_remote);
      })
      .catch(() => {
        if (!cancelled) setAllowInsecureRemote(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const classification = validateServerUrlDraft(draft, {
    allowInsecureRemote,
  });
  const isUnchanged = trimmed === serverUrl.trim();
  const saveDisabled = saving || classification.kind !== 'ok' || isUnchanged;

  const onSave = async (): Promise<void> => {
    if (saveDisabled) return;
    setSaving(true);
    setBanner(null);
    try {
      const result = await window.silverhand.saveServerConnectionProfile({
        serverUrl: trimmed,
      });
      setBanner(describeProfileSaveForGate(result));
      if (result.ok) {
        // Address committed + active remote handle retargeted. Collapse the editor and
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
      data-gate="backend-unreachable"
      className="grid h-screen w-screen place-items-center bg-bg-base px-6 py-14 text-text-primary"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        // Same dialog identity as the other boot gates — see UpdateRequiredGate
        // for the per-theme rationale (#task:1833). Not forza6-only: studio-light
        // also drops the 1px frame by its own `[data-modal-shell]` rule.
        data-modal-shell
        data-popover-frame="info"
        className="w-full max-w-[480px] rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <header className="mb-4 flex items-center gap-2">
          {/* No frame around the glyph: `text-warning` already carries the
              semantic, so a ground + border on top of it is a third layer on
              one 20px mark (shiki #task:1833 「warning icon 不要给背景色」).
              Same bare-glyph shape as AppStatusBanner. */}
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <h1 className="text-base font-semibold leading-tight">
            Can&apos;t reach this server
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
            <p className="min-w-0 flex-1 break-all rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border-subtle bg-bg-inset px-2 py-1.5 font-mono text-xs">
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
              // Border width comes from the theme's control cluster, not
              // Tailwind's 1px `border` — forza6 states are 2px (shiki
              // #task:1833 「下方的状态用 2px」). Warm themes declare 1px, so
              // they are unchanged.
              'mb-4 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] px-3 py-2 text-xs',
              banner.tone === 'error'
                ? 'border-error bg-bg-inset text-error'
                : banner.tone === 'success'
                  ? // Theme's own success hue, not `accent` — see the twin
                    // banner in ConnectionPane (#task:1833).
                    'border-success bg-bg-inset text-text-primary'
                  : 'border-border-subtle bg-bg-inset text-text-secondary',
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
          unreachable.
        </p>
        {message ? (
          <pre className="mb-4 overflow-x-auto rounded-[var(--control-radius)] border border-border-subtle bg-bg-inset px-2 py-1.5 font-mono text-[11px] leading-snug text-text-muted">
            {message}
          </pre>
        ) : null}
        <Button
          type="button"
          onClick={onRetry}
          {...primaryAction('w-full justify-center')}
        >
          <RefreshCw className="size-3.5" />
          Retry connection
        </Button>
      </div>
    </main>
  );
}

function describeProfileSaveForGate(
  result: DesktopProfileSaveWithTestResult,
): SaveServerUrlBanner {
  if (result.ok) {
    return {
      tone: 'success',
      title: 'Saved. Retrying connection…',
      description: `Using ${result.profile.server_url}.`,
    };
  }
  if (result.phase === 'test') {
    const banner = describeProbeOutcome(result.test);
    return {
      tone: banner.tone === 'success' ? 'success' : 'error',
      title: banner.title,
      description: banner.description,
    };
  }
  if (result.phase === 'commit_guard') {
    return {
      tone: 'error',
      title: 'Cannot save this server URL in this build.',
      description: result.message,
    };
  }
  return {
    tone: 'error',
    title: 'Could not write the profile.',
    description: result.detail ?? 'Check that Silverhand can write to its app data folder.',
  };
}
