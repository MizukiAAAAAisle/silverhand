/**
 * Connection settings pane.
 *
 * Owns exactly one product idea: **Desktop → Server** — where this
 * app connects and whether the connection is up. Everything about
 * individual Computers (this-computer status, refresh credentials,
 * other devices inventory, revoke) lives on the **Computer Rail**
 * (`features/hosts/HostDetailView`), not here.
 *
 * The pane renders:
 *   - a persistent Desktop→Server status pip (`desktopServerConnectionStatus`)
 *     sourced from whichever authority actually exists here (renderer
 *     event WS when `local_host_ws_attachment` is unobservable, i.e.
 *     remote; the daemon attach timestamp when it is observable),
 *   - the address form (edit + Save), embedded and remote modes both
 *     supported by branching inside the save mutation,
 *   - a save-result banner that ONLY dismisses on an observed
 *     Desktop→Server reachability proof — never on a local IPC bump
 *     (`isDesktopServerReadyAfterSave`), so a save-then-unreachable
 *     never quietly reads as success.
 *
 * IMPORTANT — token-handling invariant is preserved: the renderer NEVER sees
 * `host_token` (main reads it from disk itself). In embedded mode this pane
 * edits daemon-config directly; in remote mode it edits the persisted server
 * profile so the app backend handle, event WS, and daemon outbound config all
 * converge on the same origin.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import type {
  DesktopProfileSaveWithTestResult,
  DesktopSaveServerUrlResult,
  LocalHostWsAttachment,
} from '../../../preload/api';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  backendInfoKey,
  hostsKey,
  hostStatusKey,
  useBackendInfoSnapshot,
} from '@/features/hosts/hooks';
import { eventWsClient, type WsClientStatus } from '@/lib/ws-client';
import { describeProbeOutcome } from '@/features/setup/describe-probe-outcome';
import {
  describeSaveServerUrlOutcome,
  type SaveServerUrlBanner,
} from './describe-save-server-url-outcome';
import { saveServerConnectionProfileWithSettingsRetry } from './save-server-url-retry';
import { validateServerUrlDraft } from './server-url-validation';
import {
  desktopServerConnectionStatus,
  isDesktopServerReadyAfterSave,
  type DesktopServerConnectionStatus,
  type DesktopServerMode,
} from './connection-readiness';
import { primaryAction } from '@/features/common/PrimaryAction';

const STATUS_LABEL: Record<DesktopServerConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
};

const STATUS_TONE_CLASS: Record<DesktopServerConnectionStatus, string> = {
  connected: 'border-success text-success',
  connecting: 'border-border-subtle text-text-secondary',
  offline: 'border-warning text-warning',
};

function ServerStatusPill({
  status,
}: {
  status: DesktopServerConnectionStatus;
}): JSX.Element {
  return (
    <span
      role="status"
      aria-label={`Desktop to server: ${STATUS_LABEL[status]}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-[var(--control-radius)] border bg-bg-floating px-2 py-0.5 text-[10px] font-medium',
        STATUS_TONE_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

type ServerUrlSaveResult =
  | { source: 'daemon_reload'; result: DesktopSaveServerUrlResult }
  | { source: 'profile'; result: DesktopProfileSaveWithTestResult };

function describeProfileSaveForConnection(
  result: DesktopProfileSaveWithTestResult,
): SaveServerUrlBanner {
  if (result.ok) {
    return {
      tone: 'info',
      title: 'Saved. Reconnecting…',
      description: `Using ${result.profile.server_url}.`,
      dismissOnReady: true,
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

export function ConnectionPane(): JSX.Element {
  const qc = useQueryClient();
  // Opt into `pollWhileConnecting` so the attachment / `local_host_status`
  // actually flip in cache during the embedded connecting window. The
  // readiness derivation below is correct, but a static cache would let
  // it settle on the pre-attach snapshot forever — banner stuck on
  // "Reconnecting…", pip stuck on Connecting/Offline. The hook already
  // stops polling on any terminal / attached state — and never starts in
  // remote mode, where this pane reads `wsStatus` instead (`#task:1628`)
  // — so this is cheap.
  const backendInfoQuery = useBackendInfoSnapshot({
    pollWhileConnecting: true,
  });

  const mode: DesktopServerMode =
    backendInfoQuery.data?.mode === 'remote' ? 'remote' : 'embedded';
  const attachment: LocalHostWsAttachment =
    backendInfoQuery.data?.local_host_ws_attachment ?? { observable: false };
  const localHostStatus =
    backendInfoQuery.data?.local_host_status ?? 'unclaimed';

  // Renderer event WS status — authoritative Desktop→Server signal in
  // remote mode (in embedded the WS is against embedded main, so the
  // pip falls back to the daemon attachment via the derivation).
  const [wsStatus, setWsStatus] = useState<WsClientStatus>(() =>
    eventWsClient.getStatus(),
  );
  const wsConnectedAtRef = useRef<number | null>(
    eventWsClient.getStatus() === 'connected' ? Date.now() : null,
  );
  useEffect(() => {
    return eventWsClient.onStatus(next => {
      setWsStatus(next);
      if (next === 'connected') {
        wsConnectedAtRef.current = Date.now();
      }
    });
  }, []);

  const connectionStatus = desktopServerConnectionStatus({
    attachment,
    localHostStatus,
    wsStatus,
  });

  // ---- Server address form -------------------------------------------------
  // Source-of-truth pin:
  // - Embedded mode edits the daemon outbound URL, so seed from
  //   `local_host_server_url`.
  // - Remote mode edits the app's active server profile, so seed from
  //   `url`. A previous legacy Settings save may have already changed
  //   daemon-config without changing the profile; showing daemon-config there
  //   would make the form look unchanged while the app is still on the old
  //   backend.
  const savedUrl = backendInfoQuery.data?.local_host_server_url ?? null;
  const fallbackUrl = backendInfoQuery.data?.url ?? '';
  const currentUrl =
    mode === 'remote' ? fallbackUrl : savedUrl ?? fallbackUrl;

  const [draft, setDraft] = useState<string>('');
  useEffect(() => {
    setDraft(currentUrl);
  }, [currentUrl]);

  const [banner, setBanner] = useState<SaveServerUrlBanner | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
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
  const updateDraft = (value: string): void => {
    setDraft(value);
    setBanner(null);
    setSavedAt(null);
  };

  const save = useMutation({
    mutationFn: async (serverUrl: string): Promise<ServerUrlSaveResult> => {
      if (mode === 'remote') {
        return {
          source: 'profile',
          result: await saveServerConnectionProfileWithSettingsRetry({
            serverUrl,
            save: input => window.silverhand.saveServerConnectionProfile(input),
          }),
        };
      }
      return {
        source: 'daemon_reload',
        result: await window.silverhand.saveServerUrl({ serverUrl }),
      };
    },
    onSuccess: saveResult => {
      const nextBanner =
        saveResult.source === 'profile'
          ? describeProfileSaveForConnection(saveResult.result)
          : describeSaveServerUrlOutcome(saveResult.result);
      setBanner(nextBanner);
      setSavedAt(nextBanner.dismissOnReady ? Date.now() : null);
      if (saveResult.result.ok) {
        if (saveResult.source === 'profile') {
          // Remote-mode Settings edits must retarget the renderer transport too.
          // The profile pipeline updates main's active backend handle; forcing a
          // reconnect makes event WS re-read BackendInfo and dial the new origin
          // instead of leaving the old server socket open indefinitely.
          eventWsClient.disconnect();
          eventWsClient.connect();
        }
        void qc.invalidateQueries({ queryKey: backendInfoKey });
        void qc.invalidateQueries({ queryKey: hostsKey });
        const hostId = backendInfoQuery.data?.local_host_id ?? null;
        if (hostId !== null) {
          void qc.invalidateQueries({ queryKey: hostStatusKey(hostId) });
        }
      }
    },
    onError: err => {
      setSavedAt(null);
      setBanner({
        tone: 'error',
        title: 'Could not save.',
        description: err instanceof Error ? err.message : 'Unknown error.',
      });
    },
  });

  // Dismiss the "Saved. Reconnecting…" banner only on an authoritative
  // Desktop→Server reachability proof observed AFTER save started —
  // renderer WS `connected` (attachment unobservable / remote) or daemon
  // `attached_at` moving forward past `savedAt` (observable / embedded).
  // See `connection-readiness.ts`.
  // Explicitly NOT `backendInfoQuery.dataUpdatedAt`: the `backend:info`
  // IPC always resolves regardless of remote reachability, so trusting
  // it dismisses the banner on a save-then-unreachable.
  const ready = isDesktopServerReadyAfterSave({
    attachment,
    localHostStatus,
    wsStatus,
    wsConnectedAt: wsConnectedAtRef.current,
    savedAt,
  });
  useEffect(() => {
    if (banner?.dismissOnReady && ready) {
      setBanner(null);
      setSavedAt(null);
    }
  }, [banner, ready]);

  const classification = useMemo(() => {
    return validateServerUrlDraft(draft, { allowInsecureRemote });
  }, [allowInsecureRemote, draft]);

  const isUnchanged = draft.trim() === currentUrl.trim();
  const saveDisabled =
    save.isPending || classification.kind !== 'ok' || isUnchanged;

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (saveDisabled) return;
    setBanner(null);
    setSavedAt(null);
    save.mutate(draft.trim());
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-6 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-semibold text-text-primary">
          Connection
        </h2>
        <p className="max-w-prose text-xs text-text-muted">
          The server this app connects to. Computers are managed under the
          Computers panel.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-start gap-1">
          <h3 className="text-sm font-semibold text-text-primary">Server</h3>
          <ServerStatusPill status={connectionStatus} />
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
              onChange={e => updateDraft(e.target.value)}
              disabled={save.isPending}
              className="max-w-md font-mono text-xs"
            />
            <Button
              type="submit"
              {...primaryAction('shrink-0')}
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
    </section>
  );
}
