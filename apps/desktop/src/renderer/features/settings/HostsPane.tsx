/**
 * Stage B.4 — "Local host" settings pane.
 *
 * What this surface does and does not do:
 *
 *  - GET `/api/hosts` is owner-filtered server-side; only the
 *    viewer's own hosts come through. We render every owned host the
 *    user has, but the "Rotate token" button is enabled only for the
 *    desktop's CURRENT local host (i.e. `host.id === backendInfo.local_host_id`).
 *    Rotating any other host would silently re-bind this desktop's
 *    daemon to a different identity, so main also enforces the same
 *    guard.
 *  - Revoke is allowed for any owned host. If the revoked host is
 *    the current local one, main also clears `daemon-config.json`
 *    and the renderer surfaces a "log in again to provision a new
 *    host" prompt.
 *  - Renderer NEVER sees `host_token`. Both rotate and revoke go
 *    through dedicated `window.agentHub.*` IPCs whose return shape
 *    omits the token.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, ShieldOff } from 'lucide-react';
import {
  HostListResponseSchema,
  type HostDto,
  type HostListResponse,
} from '@silverhand/shared';
import type { DesktopHostMutationResult } from '../../../preload/api';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const hostsKey = ['hosts'] as const;
const backendInfoKey = ['backend-info'] as const;

interface BackendInfoSnapshot {
  local_host_id: string | null;
  local_host_status: 'unclaimed' | 'claimed' | 'revoked' | 'error';
}

async function fetchHosts(): Promise<HostListResponse> {
  const raw = await api<unknown>('/api/hosts');
  return HostListResponseSchema.parse(raw);
}

async function fetchBackendInfo(): Promise<BackendInfoSnapshot> {
  const info = await window.agentHub.getBackendInfo();
  if (!info) {
    return { local_host_id: null, local_host_status: 'error' };
  }
  return {
    local_host_id: info.local_host_id,
    local_host_status: info.local_host_status,
  };
}

function formatTimestamp(value: number | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString();
}

function describeMutationFailure(result: Extract<DesktopHostMutationResult, { ok: false }>): string {
  switch (result.code) {
    case 'unauthorized':
      return 'Not signed in.';
    case 'not_current_host':
      return 'Only the host this desktop is currently bound to can be rotated.';
    case 'host_not_found':
      return 'Host not found.';
    case 'host_revoked':
      return 'Host has already been revoked.';
    case 'kind_not_supported':
      return 'This host kind cannot be rotated from the desktop UI.';
    case 'invalid_response':
      return 'Server returned an unexpected response.';
    case 'network_error':
      return result.message ?? 'Network error talking to the backend.';
    default:
      return 'Unknown error.';
  }
}

export function HostsPane(): JSX.Element {
  const qc = useQueryClient();
  const hostsQuery = useQuery({
    queryKey: hostsKey,
    queryFn: fetchHosts,
  });
  const backendInfoQuery = useQuery({
    queryKey: backendInfoKey,
    queryFn: fetchBackendInfo,
  });

  const [pendingRotateId, setPendingRotateId] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    kind: 'info' | 'error';
    text: string;
  } | null>(null);

  const refreshAll = (): void => {
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
      if (result.ok) {
        setStatusMessage({
          kind: 'info',
          text:
            'Token rotated. The previous token expires within 60 seconds; the local daemon now uses the new one.',
        });
      } else {
        setStatusMessage({ kind: 'error', text: describeMutationFailure(result) });
      }
      refreshAll();
    },
    onError: err => {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Rotate failed.',
      });
    },
  });

  const revoke = useMutation({
    mutationFn: async (hostId: string) => {
      setPendingRevokeId(hostId);
      try {
        return await window.agentHub.revokeHost({ hostId });
      } finally {
        setPendingRevokeId(null);
      }
    },
    onSuccess: result => {
      setConfirmRevokeId(null);
      if (result.ok) {
        setStatusMessage({
          kind: 'info',
          text:
            result.local_host_status === 'revoked'
              ? 'Host revoked. Sign in again to provision a new local host record.'
              : 'Host revoked.',
        });
      } else {
        setStatusMessage({ kind: 'error', text: describeMutationFailure(result) });
      }
      refreshAll();
    },
    onError: err => {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Revoke failed.',
      });
    },
  });

  const currentLocalHostId = backendInfoQuery.data?.local_host_id ?? null;
  const hosts: ReadonlyArray<HostDto> = useMemo(
    () => hostsQuery.data?.hosts ?? [],
    [hostsQuery.data],
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-5 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-semibold text-text-primary">
          Local host
        </h2>
        <p className="max-w-prose text-xs text-text-muted">
          Each desktop install is bound to one host record on the server.
          Tokens authorize the local daemon to deliver messages on behalf of
          your account; rotate or revoke them here. Revoked records are kept
          for audit history and never re-issued.
        </p>
      </header>

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

      {hostsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="size-3.5 animate-spin" />
          <span>Loading hosts…</span>
        </div>
      ) : hosts.length === 0 ? (
        <div className="rounded-md border border-border-subtle bg-bg-row-hover px-3 py-2 text-xs text-text-muted">
          No host records yet. Sign in from this desktop to provision one.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {hosts.map(host => {
            const isCurrent = host.id === currentLocalHostId;
            const isRevoked = host.revoked_at !== null;
            const rotateBusy = pendingRotateId === host.id;
            const revokeBusy = pendingRevokeId === host.id;
            const rotateDisabled =
              !isCurrent || isRevoked || rotateBusy || revokeBusy;
            const revokeDisabled = isRevoked || rotateBusy || revokeBusy;
            return (
              <li
                key={host.id}
                className={cn(
                  'flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-floating px-3 py-2.5 text-xs',
                  isRevoked && 'opacity-60',
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-text-primary">{host.name}</span>
                  <span className="font-mono text-[10px] text-text-muted">
                    {host.id}
                  </span>
                </div>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-text-secondary">
                  <dt className="text-text-muted">Kind</dt>
                  <dd>{host.kind}</dd>
                  <dt className="text-text-muted">Status</dt>
                  <dd>
                    {isRevoked ? (
                      <span className="text-text-muted">
                        Revoked · {formatTimestamp(host.revoked_at)}
                      </span>
                    ) : isCurrent ? (
                      <span className="text-text-primary">Active · this desktop</span>
                    ) : (
                      <span>Active</span>
                    )}
                  </dd>
                  <dt className="text-text-muted">Created</dt>
                  <dd>{formatTimestamp(host.created_at)}</dd>
                  <dt className="text-text-muted">Last seen</dt>
                  <dd>{formatTimestamp(host.last_seen_at)}</dd>
                </dl>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={rotateDisabled}
                    title={
                      !isCurrent
                        ? 'Only the host this desktop is currently bound to can be rotated.'
                        : isRevoked
                          ? 'Revoked hosts cannot be rotated.'
                          : undefined
                    }
                    onClick={() => rotate.mutate(host.id)}
                  >
                    {rotateBusy ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 size-3.5" />
                    )}
                    Rotate token
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={revokeDisabled}
                    onClick={() => setConfirmRevokeId(host.id)}
                  >
                    {revokeBusy ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <ShieldOff className="mr-1 size-3.5" />
                    )}
                    Revoke
                  </Button>
                </div>
                {confirmRevokeId === host.id && (
                  <div className="rounded-md border border-error bg-bg-row-hover px-3 py-2 text-[11px] text-text-secondary">
                    <p>
                      Revoking <span className="font-medium">{host.name}</span>{' '}
                      immediately invalidates its tokens and stops the local
                      daemon from delivering messages.{' '}
                      <span className="text-text-primary">
                        Existing agents and conversations are kept
                      </span>{' '}
                      — but agents bound to this host will fail to start until
                      a future re-bind, because the runtime placement check
                      now treats the host as inactive.
                      {isCurrent && (
                        <>
                          {' '}
                          You will need to sign in again on this desktop to
                          provision a new host record.
                        </>
                      )}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmRevokeId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        onClick={() => revoke.mutate(host.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
