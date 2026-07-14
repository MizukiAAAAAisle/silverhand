/**
 * D4.a Commit 2 — Setup Wizard.
 *
 * Pre-auth UX entry to the server connection profile system.
 *
 * Discovery (Commit 2): triggered exclusively by the App menu's
 * "Connect to backend…" item, which fires `navigate:setupWizard` over
 * IPC. The menu handler in `main/index.ts` (`openSetupWizard`) focuses
 * the window first; the renderer here only has to mount the modal.
 *
 * Flow:
 *   1. User types a URL.
 *   2. Clicks "Test & Save" — kicks off the combined probe + commit
 *      pipeline (`profile:saveWithTest` IPC). The probe runs first:
 *        - Success arm: profile is committed atomically by main, the
 *          renderer surfaces a success banner with a "Restart to
 *          connect" callout.
 *        - Failure arm: nothing is written; the renderer surfaces a
 *          typed error banner via {@link describeProbeOutcome}.
 *   3. If a profile is already persisted, the modal shows the current
 *      `server_url` + last-updated timestamp and offers a "Clear
 *      saved profile" affordance for explicit reset / disconnect.
 *
 * What this modal does NOT do (out of scope for Commit 2):
 *   - Auto-restart the app after a successful save. The remote-mode
 *     boot gate that consumes the profile lands in Commit 3; until
 *     then the user manually restarts. Auto-restart from here would
 *     yank the window away before the success banner is even read.
 *   - Daemon-config phase-2 derivation. That's Commit 5's pipeline.
 *   - Render anything when no menu trigger has fired — the modal is
 *     closed by default. There is no auto-popup heuristic.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, ServerCog, AlertTriangle, CheckCircle2, AlertCircle, RefreshCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
} from '@/components/ui/dialog';
import { describeProbeOutcome } from './describe-probe-outcome';
import { subscribeOpenSetupWizard } from './openWizardEvent';
import type {
  DesktopProbeServerInfoResult,
  DesktopProfileSaveWithTestResult,
} from '../../../preload/api';

interface CurrentProfile {
  serverUrl: string;
  updatedAt: number;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'failed_test'; test: DesktopProbeServerInfoResult & { ok: false } }
  | {
      // D4.a Commit 3 review fixup (Cindy P1-A) — probe succeeded
      // but main refused the URL because remote-mode boot is not
      // yet wired (Commit 5 lifts this). UI MUST distinguish this
      // from `failed_test` (the URL works — the build doesn't
      // support it yet) AND from `failed_write` (the bytes were
      // never written, no disk failure occurred).
      status: 'failed_commit_guard';
      reason: 'remote_backend_not_yet_supported';
      message: string;
      test: DesktopProbeServerInfoResult & { ok: true };
    }
  | { status: 'failed_write'; reason: string; detail?: string }
  | {
      status: 'succeeded';
      test: DesktopProbeServerInfoResult & { ok: true };
      profile: { server_url: string; updated_at: number };
    };

/**
 * Top-level mount point. Subscribes to the menu trigger and owns
 * dialog open state. Always mounted at the App level — see
 * `renderer/App.tsx`.
 */
export function SetupWizardModal(): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // The IPC subscription has to live here (not on the dialog
    // content) so the menu can open the modal even if the user has
    // never interacted with the renderer before.
    return window.agentHub.onNavigateSetupWizard(() => setOpen(true));
  }, []);
  // D4.a Commit 5d-fixup (Cindy P1-2): renderer-only DOM event so
  // the BackendUnreachableGate can pop the wizard without a
  // round-trip through main. Subscribed in addition to (not in
  // place of) the IPC subscription above.
  useEffect(() => {
    return subscribeOpenSetupWizard(() => setOpen(true));
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[520px]">
        <SetupWizardBody onRequestClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SetupWizardBody({
  onRequestClose,
}: {
  onRequestClose: () => void;
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });
  const [current, setCurrent] = useState<CurrentProfile | null | undefined>(
    undefined,
  );

  // Load current profile on mount so the modal can show "you're
  // already connected to X". `undefined` = still loading; `null` =
  // confirmed empty.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      window.agentHub.getServerConnectionProfile(),
      window.agentHub.getDesktopBuildConfig(),
    ])
      .then(results => {
        if (cancelled) return;
        const view =
          results[0].status === 'fulfilled' ? results[0].value : null;
        const buildConfig =
          results[1].status === 'fulfilled'
            ? results[1].value
            : {
                remote_only: false,
                allow_insecure_remote: false,
                default_server_url: '',
              };
        if (view) {
          setCurrent({
            serverUrl: view.server_url,
            updatedAt: view.updated_at,
          });
          // Pre-fill the input with the current URL so a "change a
          // typo" workflow is one keystroke instead of a re-type.
          setServerUrl(view.server_url);
        } else {
          setCurrent(null);
          if (buildConfig.default_server_url.length > 0) {
            setServerUrl(buildConfig.default_server_url);
          }
        }
      })
      .catch(() => {
        // If the IPC itself errors, fall through to the "no profile"
        // UX — the user can still try to set a new URL.
        if (!cancelled) setCurrent(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = serverUrl.trim();
  const canSubmit =
    submit.status !== 'submitting' && trimmed.length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmit({ status: 'submitting' });
    const result: DesktopProfileSaveWithTestResult =
      await window.agentHub.saveServerConnectionProfile({
        serverUrl: trimmed,
      });
    if (result.ok) {
      setSubmit({
        status: 'succeeded',
        test: result.test,
        profile: {
          server_url: result.profile.server_url,
          updated_at: result.profile.updated_at,
        },
      });
      // Refresh the "current profile" pane to reflect the just-saved
      // value.
      setCurrent({
        serverUrl: result.profile.server_url,
        updatedAt: result.profile.updated_at,
      });
      return;
    }
    if (result.phase === 'test') {
      setSubmit({ status: 'failed_test', test: result.test });
      return;
    }
    if (result.phase === 'commit_guard') {
      setSubmit({
        status: 'failed_commit_guard',
        reason: result.reason,
        message: result.message,
        test: result.test,
      });
      return;
    }
    setSubmit({
      status: 'failed_write',
      reason: result.reason,
      detail: result.detail,
    });
  };

  const onClear = async () => {
    if (submit.status === 'submitting') return;
    const result = await window.agentHub.clearServerConnectionProfile();
    if (result.ok) {
      setCurrent(null);
      setServerUrl('');
      setSubmit({ status: 'idle' });
    }
    // Failure of clear is rare (unlink_failed) — we surface nothing
    // here in Commit 2; Commit 5 may wire a typed banner if it turns
    // out to matter for the disconnect UX.
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md border border-border-subtle bg-bg-row-hover text-text-secondary">
            <ServerCog className="size-4" />
          </span>
          <h2 className="text-base font-semibold leading-tight">
            Connect to backend
          </h2>
        </div>
        <p className="text-xs leading-relaxed text-text-muted">
          Set the URL of the Silverhand backend this desktop should talk to.
          You can connect to a remote https:// backend, or to a local one on
          127.0.0.1.
        </p>
      </DialogHeader>

      {current ? (
        <div className="rounded-md border border-border-subtle bg-bg-row-hover p-3">
          <p className="text-xs font-medium text-text-secondary">
            Saved profile
          </p>
          <p className="mt-1 break-all font-mono text-xs text-text-primary">
            {current.serverUrl}
          </p>
          <p className="mt-1 text-[11px] text-text-muted">
            Updated {new Date(current.updatedAt).toLocaleString()}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="mt-2 h-7 gap-1.5 px-2 text-xs text-text-muted hover:text-status-error"
            onClick={onClear}
          >
            <Trash2 className="size-3.5" />
            Clear saved profile
          </Button>
        </div>
      ) : current === null ? (
        <p className="text-xs text-text-muted">
          No profile saved yet — enter a URL to test and save one.
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="setup-server-url">Server URL</Label>
          <Input
            id="setup-server-url"
            type="url"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="https://backend.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={submit.status === 'submitting'}
          />
          <p className="text-[11px] text-text-muted">
            Accepts https://, or http:// to a loopback address
            (127.0.0.1 / localhost / [::1]). Use https:// for any remote
            backend.
          </p>
        </div>

        <ProbeBannerView submit={submit} />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onRequestClose}
            disabled={submit.status === 'submitting'}
          >
            Close
          </Button>
          <Button
            type="submit"
            disabled={!canSubmit}
            className="gap-1.5"
          >
            {submit.status === 'submitting' ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Testing…
              </>
            ) : (
              <>
                <RefreshCcw className="size-3.5" />
                Test &amp; save
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function ProbeBannerView({ submit }: { submit: SubmitState }): JSX.Element | null {
  if (submit.status === 'idle' || submit.status === 'submitting') {
    return null;
  }
  if (submit.status === 'succeeded') {
    const banner = describeProbeOutcome(submit.test);
    return (
      <BannerShell tone={banner.tone} title={banner.title}>
        <p className="text-[11px] text-text-muted">{banner.description}</p>
        <p className="text-[11px] font-medium text-text-secondary">
          Profile saved. Restart the app to connect using this server URL.
        </p>
      </BannerShell>
    );
  }
  if (submit.status === 'failed_test') {
    const banner = describeProbeOutcome(submit.test);
    return (
      <BannerShell tone={banner.tone} title={banner.title}>
        <p className="text-[11px] text-text-muted">{banner.description}</p>
      </BannerShell>
    );
  }
  if (submit.status === 'failed_commit_guard') {
    // D4.a Commit 3 review fixup (Cindy P1-A) — typed copy for the
    // "probe succeeded but build cannot persist remote URL yet"
    // arm. We deliberately render this as `warn` (not `error`):
    // the user's URL is structurally valid AND the backend
    // responded — what's missing is the local desktop build's
    // remote-mode bootstrap path. Distinguishing tone from
    // `failed_test` (error) keeps the message honest.
    return (
      <BannerShell
        tone="warn"
        title="Cannot save remote backend URL in this build yet."
      >
        <p className="text-[11px] text-text-muted">{submit.message}</p>
      </BannerShell>
    );
  }
  // failed_write — typed copy is small enough to inline.
  return (
    <BannerShell
      tone="error"
      title="Could not write the profile."
    >
      {submit.detail ? (
        <p className="text-[11px] text-text-muted">{submit.detail}</p>
      ) : null}
    </BannerShell>
  );
}

function BannerShell({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'warn' | 'error';
  title: string;
  children?: React.ReactNode;
}): JSX.Element {
  const palette =
    tone === 'success'
      ? 'border-status-success/30 bg-status-success/10 text-status-success'
      : tone === 'warn'
        ? 'border-status-warning/30 bg-status-warning/10 text-status-warning'
        : 'border-status-error/30 bg-status-error/10 text-status-error';
  const Icon =
    tone === 'success'
      ? CheckCircle2
      : tone === 'warn'
        ? AlertTriangle
        : AlertCircle;
  return (
    <div className={cn('rounded-md border p-3', palette)}>
      <div className="flex items-start gap-2">
        <Icon className="mt-[1px] size-3.5 shrink-0" />
        <p className="text-xs font-medium">{title}</p>
      </div>
      {children ? (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-[22px] text-text-primary">
          {children}
        </div>
      ) : null}
    </div>
  );
}
