/**
 * Connection settings pane.
 *
 * Product-layer merge of the former "Server" (ServerUrlPane) and
 * "Local host" (HostsPane) sub-pages into one surface. shiki feedback:
 * the old copy read like a technical doc (daemon-config.json /
 * host_token / daemon / attach) and "local host" duplicated a concept
 * the user already thinks of as "the server". So the user-facing model
 * is now just two ideas:
 *
 *   - **Server** — where this app keeps your workspaces and messages.
 *   - **This computer** — whether this machine is connected and able to
 *     run your agents.
 *
 * Everything implementation-shaped (host record id, last-seen, token
 * refresh, other owned host records) is tucked behind a collapsed
 * **Details** disclosure so the primary surface stays product copy.
 *
 * IMPORTANT — this is a presentation-layer change only. The underlying
 * model is untouched: `server_url` still lives in daemon-config.json,
 * host records are still the backend's source of truth, and the same
 * `window.agentHub.*` IPCs back every action here. No D3/D4 protocol
 * boundary is crossed. Token-handling invariant is preserved: the
 * renderer NEVER sees `host_token` (main reads it from disk itself).
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { classifyServerUrl } from '@silverhand/shared';
import type { HostDto } from '@silverhand/shared';
import type {
  DesktopHostMutationResult,
  DesktopSaveServerUrlResult,
} from '../../../preload/api';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  backendInfoKey,
  hostsKey,
  useBackendInfoSnapshot,
  useHostStatusQuery,
  useHostsQuery,
} from '@/features/hosts/hooks';
import {
  describeConnectionState,
  type ConnectionStateView,
  type ConnectionTone,
  type LocalHostStatus,
} from '@/features/hosts/connection-state';
import {
  describeSaveServerUrlOutcome,
  type SaveServerUrlBanner,
} from './describe-save-server-url-outcome';

function formatTimestamp(value: number | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString();
}

/**
 * Tone → token mapping for the connection pill. Every value resolves
 * to existing theme tokens defined in BOTH `warm-script.css` AND
 * `forza6.css` — no new tokens, no per-theme branches, no hardcoded
 * colors. Border picks up the tone; bg stays neutral `bg-bg-floating`.
 */
const TONE_CLASS: Record<ConnectionTone, string> = {
  hidden: '',
  accent: 'border-accent text-accent',
  success: 'border-success text-success',
  muted: 'border-border-subtle text-text-muted',
  warning: 'border-warning text-warning',
  error: 'border-error text-error',
};

function ConnectionPill({ view }: { view: ConnectionStateView }): JSX.Element | null {
  if (!view.visible) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-[var(--control-radius)] border bg-bg-floating px-2 py-0.5 text-[10px] font-medium',
        TONE_CLASS[view.tone],
      )}
      role="status"
      aria-label={view.detail ? `${view.label} ${view.detail}` : view.label}
    >
      <span>{view.label}</span>
      {view.detail && <span className="text-text-muted">· {view.detail}</span>}
    </span>
  );
}

/**
 * One-line product summary for the "This computer" block. Mirrors the
 * connection-state arms but speaks in user terms ("run your agents")
 * rather than daemon/attachment language.
 */
function describeThisMac(
  status: LocalHostStatus,
  attachedAt: number | null,
  remoteAttached: boolean,
): string {
  switch (status) {
    case 'unclaimed':
      return 'Sign in from this computer to start running your agents.';
    case 'claimed':
      return attachedAt === null && !remoteAttached
        ? 'Connecting this computer to the server…'
        : 'This computer is connected and ready to run your agents.';
    case 'revoked':
      return 'This computer was removed. Sign in again to reconnect it.';
    case 'error':
      return 'This computer is offline. It will reconnect when the server is reachable again.';
    case 'failed':
      return 'This computer stopped running agents. Relaunch the app to reconnect.';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function describeMutationFailure(
  result: Extract<DesktopHostMutationResult, { ok: false }>,
): string {
  switch (result.code) {
    case 'unauthorized':
      return 'Not signed in.';
    case 'not_current_host':
      return 'Only this computer’s own connection can be refreshed.';
    case 'host_not_found':
      return 'This device record was not found.';
    case 'host_revoked':
      return 'This device has already been removed.';
    case 'kind_not_supported':
      return 'This device cannot be changed from here.';
    case 'invalid_response':
      return 'The server returned an unexpected response.';
    case 'network_error':
      return result.message ?? 'Could not reach the server.';
    default:
      return 'Something went wrong.';
  }
}

export function ConnectionPane(): JSX.Element {
  const qc = useQueryClient();
  const hostsQuery = useHostsQuery();
  // This pane renders the live connection pill, so it opts into the
  // narrow `claimed + attached_at===null` polling. In embedded mode this
  // auto-stops once `attached_at` lands (the attachment is observable
  // in-process). In remote mode `attached_at` never lands (#task:1010),
  // so this keeps ticking at 1.5s while the pane is open — but it's a
  // cheap local backend-info IPC, NOT a daemon round-trip, and the
  // pill's Connecting→Ready flip in remote comes from the separate
  // host-status probe below, which DOES stop once `available`.
  const backendInfoQuery = useBackendInfoSnapshot({ pollWhileConnecting: true });

  // ---- Server address form -------------------------------------------------
  // Source-of-truth pin (carried over from ServerUrlPane): seed from
  // `local_host_server_url` (the daemon-config view), falling back to
  // the embedded `url` only pre-claim.
  const savedUrl = backendInfoQuery.data?.local_host_server_url ?? null;
  const fallbackUrl = backendInfoQuery.data?.url ?? '';
  const currentUrl = savedUrl ?? fallbackUrl;

  const [draft, setDraft] = useState<string>('');
  useEffect(() => {
    setDraft(currentUrl);
  }, [currentUrl]);

  const [banner, setBanner] = useState<SaveServerUrlBanner | null>(null);

  const save = useMutation({
    mutationFn: async (serverUrl: string): Promise<DesktopSaveServerUrlResult> =>
      window.agentHub.saveServerUrl({ serverUrl }),
    onSuccess: result => {
      setBanner(describeSaveServerUrlOutcome(result));
      if (result.ok) {
        void qc.invalidateQueries({ queryKey: backendInfoKey });
        void qc.invalidateQueries({ queryKey: hostsKey });
      }
    },
    onError: err => {
      setBanner({
        tone: 'error',
        title: 'Could not save.',
        description: err instanceof Error ? err.message : 'Unknown error.',
      });
    },
  });

  const classification = useMemo(() => {
    const trimmed = draft.trim();
    if (trimmed === '') return { kind: 'empty' as const };
    const c = classifyServerUrl(trimmed);
    return c.ok
      ? { kind: 'ok' as const, url: c.url }
      : { kind: 'reject' as const, reason: c.reason, message: c.message };
  }, [draft]);

  const isUnchanged = draft.trim() === currentUrl.trim();
  const saveDisabled =
    save.isPending || classification.kind !== 'ok' || isUnchanged;

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (saveDisabled) return;
    setBanner(null);
    save.mutate(draft.trim());
  };

  // ---- This computer / host records ----------------------------------------
  const currentLocalHostId = backendInfoQuery.data?.local_host_id ?? null;
  const localHostStatus: LocalHostStatus =
    backendInfoQuery.data?.local_host_status ?? 'unclaimed';
  const localHostAttachedAt =
    backendInfoQuery.data?.local_host_ws_attached_at ?? null;

  // #task:1010 — remote-mode readiness source. In a remote-server
  // deployment `local_host_ws_attached_at` is structurally null (the
  // attachment registry lives in the remote backend, not in this
  // process), so the embedded "attached_at" proof never lands and the
  // pill would be stuck on "Connecting…" forever even though the daemon
  // is genuinely attached (agents communicate fine). We consult the
  // remote backend's host-status over HTTP — `availability === 'available'`
  // is the same authority every other remote-mode fact flows through —
  // but ONLY in the ambiguous window (`claimed` + no local attach
  // timestamp). In embedded mode `attachedAt` lands fast, so this probe
  // is disabled almost immediately and never adds traffic.
  const needsRemoteAttachProbe =
    localHostStatus === 'claimed' && localHostAttachedAt === null;
  const localHostStatusQuery = useHostStatusQuery(currentLocalHostId, {
    enabled: needsRemoteAttachProbe && currentLocalHostId !== null,
    pollUntilAvailable: true,
  });
  const remoteAttached =
    localHostStatusQuery.data?.availability === 'available';

  const localConnectionView = useMemo(
    () =>
      describeConnectionState(localHostStatus, localHostAttachedAt, Date.now(), {
        remoteAttached,
      }),
    [localHostStatus, localHostAttachedAt, remoteAttached],
  );

  const hosts: ReadonlyArray<HostDto> = useMemo(
    () => hostsQuery.data?.hosts ?? [],
    [hostsQuery.data],
  );
  const currentHost = useMemo(
    () => hosts.find(h => h.id === currentLocalHostId) ?? null,
    [hosts, currentLocalHostId],
  );
  const otherHosts = useMemo(
    () => hosts.filter(h => h.id !== currentLocalHostId),
    [hosts, currentLocalHostId],
  );

  const [pendingRotateId, setPendingRotateId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    kind: 'info' | 'error';
    text: string;
  } | null>(null);

  const refreshHostQueries = (): void => {
    void qc.invalidateQueries({ queryKey: hostsKey });
    void qc.invalidateQueries({ queryKey: backendInfoKey });
  };

  const rotate = useMutation({
    mutationFn: async (hostId: string) => {
      setPendingRotateId(hostId);
      try {
        return await window.agentHub.rotateHostToken({ hostId });
      } finally {
        setPendingRotateId(null);
      }
    },
    onSuccess: result => {
      setStatusMessage(
        result.ok
          ? { kind: 'info', text: 'This computer’s connection credentials were refreshed.' }
          : { kind: 'error', text: describeMutationFailure(result) },
      );
      refreshHostQueries();
    },
    onError: err => {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Could not refresh credentials.',
      });
    },
  });

  const remove = useMutation({
    mutationFn: async (hostId: string) => {
      setPendingRemoveId(hostId);
      try {
        return await window.agentHub.revokeHost({ hostId });
      } finally {
        setPendingRemoveId(null);
      }
    },
    onSuccess: result => {
      setConfirmRemoveId(null);
      setStatusMessage(
        result.ok
          ? {
              kind: 'info',
              text:
                result.local_host_status === 'revoked'
                  ? 'This computer was removed. Sign in again to reconnect it.'
                  : 'Device removed.',
            }
          : { kind: 'error', text: describeMutationFailure(result) },
      );
      refreshHostQueries();
    },
    onError: err => {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Could not remove the device.',
      });
    },
  });

  const currentIsRemovable =
    currentHost !== null &&
    currentHost.revoked_at === null &&
    localHostStatus !== 'unclaimed' &&
    localHostStatus !== 'revoked';

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-6 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-semibold text-text-primary">
          Connection
        </h2>
        <p className="max-w-prose text-xs text-text-muted">
          Where this app connects, and what this computer runs.
        </p>
      </header>

      {/* ---- Server ---------------------------------------------------- */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-text-primary">Server</h3>
          <p className="max-w-prose text-xs text-text-muted">
            Choose the server this app connects to.
          </p>
        </div>

        {banner && (
          <div
            role="status"
            className={cn(
              'rounded-md border px-3 py-2 text-xs',
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

        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <Label htmlFor="settings-server-url">Address</Label>
          <div className="flex items-center gap-2">
            <Input
              id="settings-server-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              placeholder="http://127.0.0.1:8765"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={save.isPending}
              className="max-w-md font-mono text-xs"
            />
            <Button
              type="submit"
              variant="outline"
              className="shrink-0"
              disabled={saveDisabled}
              title={
                classification.kind === 'reject'
                  ? classification.message
                  : isUnchanged
                    ? 'Already set to this value.'
                    : classification.kind === 'empty'
                      ? 'Enter an address to save.'
                      : undefined
              }
            >
              {save.isPending ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 size-3.5" />
              )}
              Save
            </Button>
          </div>
          {classification.kind === 'reject' && (
            <p className="text-[11px] text-error">{classification.message}</p>
          )}
        </form>
      </div>

      {/* ---- This computer -------------------------------------------- */}
      <div className="flex flex-col gap-3 border-t border-border-subtle pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-semibold text-text-primary">This computer</h3>
            <p className="max-w-prose text-xs text-text-muted">
              {describeThisMac(localHostStatus, localHostAttachedAt, remoteAttached)}
            </p>
          </div>
          <ConnectionPill view={localConnectionView} />
        </div>

        {statusMessage && (
          <div
            role="status"
            className={cn(
              'rounded-md border px-3 py-2 text-xs',
              statusMessage.kind === 'error'
                ? 'border-error bg-bg-row-hover text-error'
                : 'border-border-subtle bg-bg-row-hover text-text-secondary',
            )}
          >
            {statusMessage.text}
          </div>
        )}

        {/* Device metadata flattened inline (no Details fold) — a
            settings surface should be glanceable, and the status line
            alone left this block feeling empty (shiki + Cindy). No
            daemon/token language is reintroduced; these are plain
            facts + a secondary action. */}
        {currentHost ? (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-text-secondary">
              <dt className="text-text-muted">Device ID</dt>
              <dd className="font-mono text-[11px]">{currentHost.id}</dd>
              <dt className="text-text-muted">Added</dt>
              <dd>{formatTimestamp(currentHost.created_at)}</dd>
              <dt className="text-text-muted">Last seen</dt>
              <dd>{formatTimestamp(currentHost.last_seen_at)}</dd>
            </dl>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  currentHost.revoked_at !== null ||
                  pendingRotateId === currentHost.id
                }
                onClick={() => rotate.mutate(currentHost.id)}
              >
                {pendingRotateId === currentHost.id ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 size-3.5" />
                )}
                Refresh credentials
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-text-muted">
            No device record yet. Sign in from this computer to create one.
          </p>
        )}

        {otherHosts.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
            <p className="text-[11px] font-medium text-text-secondary">
              Other devices
            </p>
            <ul className="flex flex-col gap-2">
              {otherHosts.map(host => {
                const isRevoked = host.revoked_at !== null;
                const removeBusy = pendingRemoveId === host.id;
                return (
                  <li
                    key={host.id}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-md border border-border-subtle bg-bg-floating px-3 py-2 text-xs',
                      isRevoked && 'opacity-60',
                    )}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-text-primary">
                        {host.name}
                      </span>
                      <span className="font-mono text-[10px] text-text-muted">
                        {host.id}
                      </span>
                    </div>
                    <span className="text-[11px] text-text-muted">
                      {isRevoked
                        ? `Removed · ${formatTimestamp(host.revoked_at)}`
                        : `Last seen ${formatTimestamp(host.last_seen_at)}`}
                    </span>
                    {!isRevoked && (
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={removeBusy}
                          onClick={() => setConfirmRemoveId(host.id)}
                        >
                          {removeBusy ? (
                            <Loader2 className="mr-1 size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1 size-3.5" />
                          )}
                          Remove
                        </Button>
                      </div>
                    )}
                    {confirmRemoveId === host.id && (
                      <div className="rounded-md border border-error bg-bg-row-hover px-3 py-2 text-[11px] text-text-secondary">
                        <p>
                          Remove <span className="font-medium">{host.name}</span>?
                          It will stop running agents until it is reconnected.{' '}
                          <span className="text-text-primary">
                            Workspaces and messages are kept.
                          </span>
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmRemoveId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            onClick={() => remove.mutate(host.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Danger zone pinned to the bottom of the block (shiki + Cindy):
            destructive action stays out of the primary status row. */}
        {currentIsRemovable && (
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
            {confirmRemoveId === currentLocalHostId ? (
              <div className="rounded-md border border-error bg-bg-row-hover px-3 py-2 text-[11px] text-text-secondary">
                <p>
                  This computer will stop running agents until you sign in again
                  and reconnect it.{' '}
                  <span className="text-text-primary">
                    Your workspaces and messages are kept.
                  </span>
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmRemoveId(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={pendingRemoveId === currentLocalHostId}
                    onClick={() => remove.mutate(currentLocalHostId!)}
                  >
                    {pendingRemoveId === currentLocalHostId && (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    )}
                    Remove this computer
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmRemoveId(currentLocalHostId)}
                >
                  <Trash2 className="mr-1 size-3.5 text-error" />
                  <span className="text-error">Remove this computer</span>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
