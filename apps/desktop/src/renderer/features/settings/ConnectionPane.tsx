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
 *     remote; the daemon attach timestamp when it is observable; and NO
 *     pill at all until a snapshot has been observed — see the
 *     `observation` binding below),
 *   - the address form (edit + Save). Which owner a save is sent to —
 *     the daemon's outbound config (embedded) or the app's server
 *     connection profile (remote) — is decided by `planServerUrlSave`
 *     from the observed `mode`, and no save exists at all until a
 *     snapshot says which deployment this is,
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
import { Loader2, Save, Server } from 'lucide-react';
import type { DesktopProfileSaveWithTestResult } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { SettingsHeading } from './SettingsHeading';
import {
  backendInfoKey,
  hostsKey,
  hostStatusKey,
  useBackendInfoSnapshot,
} from '@/features/hosts/hooks';
import { computerCopy } from '@/features/hosts/computer-copy';
import { eventWsClient, type WsClientStatus } from '@/lib/ws-client';
import { describeProbeOutcome } from '@/features/setup/describe-probe-outcome';
import {
  describeSaveServerUrlOutcome,
  type SaveServerUrlBanner,
} from './describe-save-server-url-outcome';
import {
  planServerUrlSave,
  runServerUrlSave,
  type ServerUrlSaveCommand,
  type ServerUrlSaveResult,
} from './server-url-save-command';
import { validateServerUrlDraft } from './server-url-validation';
import {
  desktopServerConnectionStatus,
  isDesktopServerReadyAfterSave,
  type DesktopServerConnectionStatus,
  type DesktopServerObservation,
} from './connection-readiness';
import { primaryAction } from '@/features/common/PrimaryAction';

/**
 * Availability words come from the `computerCopy` single source — the
 * Unified Computer model forbids one surface saying "Connected" while
 * another says "Ready"/"Online" for the same availability fact (§7.1, no
 * source-fork), and a local literal here is exactly how that fork starts.
 * `Connecting…` stays literal: it is the Desktop→Server attach window,
 * a state the availability lexicon has no word for.
 */
const STATUS_LABEL: Record<
  Exclude<DesktopServerConnectionStatus, 'unknown'>,
  string
> = {
  connected: computerCopy.availabilityConnected,
  connecting: 'Connecting…',
  offline: computerCopy.availabilityOffline,
};

const STATUS_TONE_CLASS: Record<
  Exclude<DesktopServerConnectionStatus, 'unknown'>,
  string
> = {
  connected: 'border-success text-success',
  connecting: 'border-border-subtle text-text-secondary',
  offline: 'border-warning text-warning',
};

function ServerStatusPill({
  status,
}: {
  status: DesktopServerConnectionStatus;
}): JSX.Element | null {
  // `unknown` = no BackendInfo observed yet. Render no pill rather than a
  // status word we have not earned: every candidate ("Connecting…",
  // "Offline") is a claim about a connection nobody has looked at, and a
  // word that later walks backwards reads as a glitch (`#task:1630`
  // review).
  if (status === 'unknown') return null;
  return (
    <span
      role="status"
      aria-label={`Desktop to server: ${STATUS_LABEL[status]}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-[var(--control-radius)] border bg-bg-floating px-2 py-0.5 text-[length:var(--text-badge)] font-medium',
        STATUS_TONE_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

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

  // `#task:1630` forward fix — "no snapshot yet" stays NULL, everywhere.
  // It is a query state, and every fact below only means anything as
  // part of one snapshot; defaulting them separately (`?? 'embedded'`,
  // `?? { observable: false }`, `?? 'unclaimed'`) manufactured an
  // observation that says "this deployment cannot observe attachments"
  // (which hands the pip to the renderer WS — a LOCAL socket in
  // embedded mode) and a mode that says "the daemon owns this address"
  // (which points Save at a daemon reload on a remote install).
  const snapshot = backendInfoQuery.data ?? null;

  const observation: DesktopServerObservation | null = snapshot
    ? {
        attachment: snapshot.local_host_ws_attachment,
        localHostStatus: snapshot.local_host_status,
      }
    : null;

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
    observation,
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
  // - No snapshot: no source of truth to show yet, so the field seeds
  //   empty (and Save stays disabled via `saveCommand === null` below).
  const currentUrl =
    snapshot === null
      ? ''
      : snapshot.mode === 'remote'
        ? snapshot.url
        : snapshot.local_host_server_url ?? snapshot.url;

  // `#task:1640` — the field FOLLOWS the authority only while the user
  // has not typed in it. Re-seeding on every `currentUrl` change wiped
  // whatever was being typed, and `currentUrl` changes for reasons that
  // have nothing to do with this field: the first snapshot landing (the
  // unknown window `#task:1630` made explicit — `''` → real address),
  // and any `pollWhileConnecting` refetch that carries a new
  // `local_host_server_url` / `url`. Once edited the draft is the user's
  // until the save lands (`onSuccess` clears the flag so the field
  // re-follows the newly saved authority).
  const [draft, setDraft] = useState<string>('');
  const draftEditedRef = useRef(false);
  useEffect(() => {
    if (draftEditedRef.current) return;
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
    draftEditedRef.current = true;
    setBanner(null);
    setSavedAt(null);
  };

  const save = useMutation({
    // The variables ARE the routing decision (`planServerUrlSave`), so
    // this function cannot re-guess which owner should receive the
    // address — there is no `mode` left for it to default.
    mutationFn: async (
      command: ServerUrlSaveCommand,
    ): Promise<ServerUrlSaveResult> =>
      runServerUrlSave(command, {
        saveServerConnectionProfile: input =>
          window.silverhand.saveServerConnectionProfile(input),
        saveServerUrl: input => window.silverhand.saveServerUrl(input),
      }),
    onSuccess: saveResult => {
      const nextBanner =
        saveResult.source === 'profile'
          ? describeProfileSaveForConnection(saveResult.result)
          : describeSaveServerUrlOutcome(saveResult.result);
      setBanner(nextBanner);
      setSavedAt(nextBanner.dismissOnReady ? Date.now() : null);
      if (saveResult.result.ok) {
        // The saved address IS the authority now, so let the field follow
        // it again (`#task:1640`). A FAILED save keeps the edited flag —
        // the user's text stays put so they can fix it.
        draftEditedRef.current = false;
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
        const hostId = snapshot?.local_host_id ?? null;
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
    observation,
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
  // One source for "which owner receives this address, if any". `null`
  // means the deployment shape has not been observed yet, so there is
  // no command to send — the Save affordance and the submit handler
  // both read that same absence instead of each keeping their own copy
  // of the rule. The address field stays editable: what the user typed
  // is theirs to keep while the (sub-second, self-healing) snapshot
  // lands.
  const saveCommand = planServerUrlSave({
    mode: snapshot?.mode ?? null,
    serverUrl: draft.trim(),
  });
  const saveDisabled =
    save.isPending ||
    classification.kind !== 'ok' ||
    isUnchanged ||
    saveCommand === null;

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (saveDisabled || saveCommand === null) return;
    setBanner(null);
    setSavedAt(null);
    save.mutate(saveCommand);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-6 px-5 py-5">
      {/* Same heading object as Appearance / Account, chip included (shiki
          2026-08-06「Appearance h2 前面都给了 icon,connection / Account 也给,
          同一个风格」), title only — the description line is gone with the rest
          of them (shiki「h2 下的 description 去掉」). The routing sentence it
          carried ("Computers are managed under the Computers panel") went with
          it: the Computer Rail is a top-level destination of its own, and this
          pane's only control is the address field, which needs no gloss. */}
      <SettingsHeading icon={<Server className="size-4" />} title="Connection" />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-start gap-1">
          <h3 className="text-sm font-semibold text-text-primary">Server</h3>
          <ServerStatusPill status={connectionStatus} />
        </div>

        {banner && (
          <div
            role="status"
            className={cn(
              // Width from the theme's control cluster (forza6 = 2px), so this
              // banner stays identical to its twin in BackendUnreachableGate
              // (#task:1833).
              'rounded-[var(--control-radius)] border-[length:var(--control-border-width)] px-3 py-2 text-xs',
              banner.tone === 'error'
                ? 'border-error bg-bg-inset text-error'
                : banner.tone === 'success'
                  ? // Success borrows the theme's own success hue, not `accent`:
                    // in forza6 `--accent` is brand magenta and sits next to
                    // `--error` crimson, so an accent-bordered success banner
                    // read as a second error (#task:1833). `--success` is deep
                    // lime there. Matches `STATUS_TONE_CLASS.connected` above.
                    // Text stays neutral — error earns more loudness than a
                    // transient confirmation does.
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
            <p className="text-[length:var(--text-meta)] text-error">{classification.message}</p>
          )}
        </form>
      </div>
    </section>
  );
}
