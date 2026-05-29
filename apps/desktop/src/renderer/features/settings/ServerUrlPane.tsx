/**
 * D3.c Commit 4 — "Server" settings pane.
 *
 * Surface scope (V1 loopback only):
 *   - Read-only display of the host's identity (`local_host_id` from
 *     `BackendInfo`) so the user has context for what's being
 *     repointed.
 *   - Editable text input for the backend `server_url`. Live
 *     classify feedback as the user types (using the same
 *     `classifyServerUrl` the main process re-runs as defense in
 *     depth — see the `outbound-reload.ts` orchestrator and Cindy
 *     `#task:634` review note 1).
 *   - Save button disabled when (a) input is empty, (b) input
 *     equals the current `BackendInfo.url`, or (c) classifyServerUrl
 *     rejects the input. Disabled-state tooltip explains why.
 *   - Post-save banner: tone + headline + (optional) description.
 *     Source of all copy keys is `describeSaveServerUrlOutcome` so
 *     this component never has to reason about the discriminator
 *     itself.
 *
 * Token-handling invariant: this surface NEVER touches
 * `host_token`. The renderer only supplies `serverUrl` to the
 * `window.agentHub.saveServerUrl` IPC; main reads the token from
 * `daemon-config.json` itself when it rewrites the file.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Server as ServerIcon } from 'lucide-react';
import { classifyServerUrl } from '@silverhand/shared';
import type { DesktopSaveServerUrlResult } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  backendInfoKey,
  hostsKey,
  useBackendInfoSnapshot,
} from '@/features/hosts/hooks';
import {
  describeSaveServerUrlOutcome,
  type SaveServerUrlBanner,
} from './describe-save-server-url-outcome';

export function ServerUrlPane(): JSX.Element {
  const qc = useQueryClient();
  const backendInfoQuery = useBackendInfoSnapshot();
  // **Source of truth pin (Cindy `#task:634` review P1)**: the
  // Settings save path writes `daemon-config.json.server_url`, NOT
  // the embedded backend's listen URL. We MUST seed from
  // `local_host_server_url` (the daemon-config view) so that after
  // a successful save the post-invalidation refetch returns the new
  // value and the form re-seeds correctly. Falling back to `url`
  // only when `local_host_server_url` is null (pre-claim) gives the
  // user a sensible hint without misleading them about what's
  // actually saved.
  const savedUrl = backendInfoQuery.data?.local_host_server_url ?? null;
  const fallbackUrl = backendInfoQuery.data?.url ?? '';
  const currentUrl = savedUrl ?? fallbackUrl;
  const localHostId = backendInfoQuery.data?.local_host_id ?? null;

  // Local form state seeded from the snapshot. Re-seeds whenever
  // the snapshot refetches, so an out-of-band rotate / re-login
  // that changes the URL is reflected here without the user
  // having to navigate away and back.
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
        // Both reloaded and unchanged warrant a refresh — reloaded
        // because the attachment changed, unchanged because the
        // form draft now matches the underlying snapshot exactly.
        void qc.invalidateQueries({ queryKey: backendInfoKey });
        void qc.invalidateQueries({ queryKey: hostsKey });
      }
    },
    onError: err => {
      setBanner({
        tone: 'error',
        title: 'Save failed.',
        description: err instanceof Error ? err.message : 'Unknown error.',
      });
    },
  });

  // Live classify feedback. We don't gate input on the result —
  // the user can keep typing — we just disable Save and show a
  // hint when the current draft would fail.
  const classification = useMemo(() => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      return { kind: 'empty' as const };
    }
    const c = classifyServerUrl(trimmed);
    return c.ok
      ? { kind: 'ok' as const, url: c.url }
      : { kind: 'reject' as const, reason: c.reason, message: c.message };
  }, [draft]);

  const isUnchanged = draft.trim() === currentUrl.trim();
  const saveDisabled =
    save.isPending ||
    classification.kind !== 'ok' ||
    isUnchanged;

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (saveDisabled) return;
    setBanner(null);
    save.mutate(draft.trim());
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-5 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-base font-semibold text-text-primary">
          Server
        </h2>
        <p className="max-w-prose text-xs text-text-muted">
          Where this desktop talks to its backend. V1 supports only
          loopback URLs (127.0.0.1, localhost, [::1]) — remote backend
          support is coming in V1.1. Saving rewrites{' '}
          <code className="rounded-sm bg-bg-row-hover px-1 py-0.5 text-[10px]">
            daemon-config.json
          </code>{' '}
          and signals the daemon to reconnect to the new address.
        </p>
      </header>

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

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="settings-server-url">Backend URL</Label>
          <div className="flex items-center gap-2">
            <ServerIcon className="size-3.5 text-text-muted" />
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
              className="font-mono text-xs"
            />
          </div>
          {classification.kind === 'reject' && (
            <p className="text-[11px] text-error">{classification.message}</p>
          )}
          {classification.kind === 'ok' && isUnchanged && (
            <p className="text-[11px] text-text-muted">
              No change — this is already the current server URL.
            </p>
          )}
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs text-text-secondary">
          <dt className="text-text-muted">Current host</dt>
          <dd className="font-mono text-[11px]">
            {localHostId ?? <span className="text-text-muted">— not signed in —</span>}
          </dd>
        </dl>

        <div className="flex items-center gap-2 pt-1">
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={saveDisabled}
            title={
              classification.kind === 'reject'
                ? classification.message
                : isUnchanged
                  ? 'Already set to this value.'
                  : classification.kind === 'empty'
                    ? 'Enter a URL to save.'
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
      </form>
    </section>
  );
}
