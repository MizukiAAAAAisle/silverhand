/**
 * `#task:808` slice 4 / `#task:809` polish — host detail / right pane.
 *
 * Identity-led layout that reuses the renderer's existing profile-card
 * vocabulary so this surface feels like part of the app instead of an
 * admin dashboard.
 *
 *   Header        — identity strip: tinted icon square as the
 *                   "avatar" (sized to balance the right-column stack
 *                   weight) plus a 3-row identity column:
 *                     1. InlineRename'able display label,
 *                     2. lightweight status (colored dot + uppercase
 *                        text) + Refresh button,
 *                     3. meta line (`host.name` only). Every computer
 *                        wears the same Monitor glyph — kind never swaps
 *                        the identity icon.
 *                   The state row sits in the middle so the visual
 *                   order reads "name → live state → identifiers"
 *                   (shiki dogfood `hLEODapuI_dHuCPz`).
 *   System        — `HostSection` with a `<dl>` of OS / Daemon
 *                   version / PID / Uptime, one row per field, inline
 *                   label + value. OS label is intentionally terse
 *                   ("OS" not "Operating system") and the value is
 *                   condensed via `formatOsShort` (drops Linux paren
 *                   suffixes + LTS marker) — shiki dogfood feedback.
 *                   Only rendered when `availability === 'available'`.
 *   Agents on     — `HostSection` titled "Agents on this machine"
 *   this machine    with the count rendered inline after the title.
 *                   Body: one-per-row list of agent identity cards.
 *                   Each card uses plain theme tokens
 *                   (`--border-subtle` at rest, `--text-primary` on
 *                   hover) — NOT the forza6 sticker hook
 *                   (`data-panel-card='row'`) because that hook's
 *                   2px black frame + lime hover is right for nav
 *                   rows but too loud for information cards in the
 *                   detail pane (shiki dogfood `CEq57Kisu3w2d-Pl`).
 *
 * `HostSection` is a local primitive — solid `bg-bg-floating` white
 * tile with `border-radius: var(--floating-radius)` (forza6 = 0,
 * warm = `var(--radius-md)`) so the corners follow the theme's
 * floating-panel geometry. We deliberately do NOT reuse the shared
 * `ProfileSection` (which uses `bg-bg-floating/50`); shiki asked for
 * a heavier white treatment here and we don't want that ripple to
 * other profile surfaces.
 *
 * Forward-compat: NO `host.kind === 'local'` branching for server-backed
 * host status. shiki: "功能应是 hosts 主语的通用功能, 不是 local only" —
 * every server-backed screen here renders against generic `HostDto` +
 * `HostStatusResponse`.
 *
 * Exception: proxy config is daemon-host local truth. That form is only
 * editable when this Desktop can reach the physical daemon for `host.id`;
 * the server must not carry proxy bytes.
 *
 * Freshness contract: the detail pane itself stays manual-refresh-only
 * (`staleTime: Infinity`). Out-of-band attach/detach changes are reconciled
 * by the app-shell host connection sync, which invalidates this query from
 * viewer-scoped WS events / `snapshot_required`; no per-view poll loop needed.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  Loader2,
  Monitor,
  RefreshCw,
  Save,
  ShieldOff,
  Trash2,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type JSX, type ReactNode } from "react";
import type {
  AgentOnHostDto,
  HostAdmissionFailure,
  HostAgentResource,
  HostDto,
  HostStatusResponse,
  RuntimeKind,
} from "@silverhand/shared";
import { RuntimeKindSchema, RUNTIME_ORDER_LIST, runtimeLabel } from "@silverhand/shared";
import { AgentAvatar } from "@/components/agent-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from "@/features/session/hooks";
import { useNav } from "@/router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { paneChrome } from "@/components/layout/pane-chrome";
import {
  hostStatusKey,
  useAgentOnlineByHost,
  useBackendInfoSnapshot,
  useHostProxyConfigQuery,
  useHostResourcesQuery,
  useHostStatusQuery,
  useDeleteComputerMutation,
  useDisconnectHostMutation,
  useRevokeComputerMutation,
  useRotateConnectTokenMutation,
  useRotateHostTokenMutation,
  useSaveHostProxyConfigMutation,
  useUpdateHostMutation,
  isHostProxyOfflineError,
  type HostProxyConfig,
} from "../hooks/hooks";
import {
  resolveDeleteComputerPhase,
  resolveDeleteFailure,
  type DeleteComputerFailure,
} from "../model/delete-computer-phase";
import { computerActions } from "../model/computer-actions";
import { destructiveAction, destructiveCancel } from "@/components/common/destructive-action";
import { primaryAction } from "@/components/common/primary-action";
import { neutralAction } from "@/components/common/control-ink-border";
import { HOST_ACTION_BUTTON_DANGER } from "../model/host-action-button";
import {
  describeAdmissionFailure,
  describeHostStatus,
  formatUptime,
  type HostStatusTone,
} from "../model/host-status-presentation";
import { InlineRename } from "./inline-rename";
import { ConnectionCommandCard } from "./connection-command-card";
import { HostDiagnosticsAction } from "./host-diagnostics-action";
import { computerCopy } from "../model/computer-copy";
import { formatOsShort } from "../model/format-os";

/**
 * Lightweight status indicator — colored dot + uppercase text. shiki
 * dogfood `CEq57Kisu3w2d-Pl`: the prior filled HUD chip
 * (`bg-success text-text-on-success`) read as "heavy" next to a small
 * Refresh icon button — drop the solid tile, keep only the tone-colored
 * dot + muted caps so the state row stays a quiet secondary strip.
 *
 * The dot still carries the tone (success/warning/error/muted/accent)
 * — that's the at-a-glance signal — and the text stays uppercase
 * tracking-wider so it visually rhymes with the section card titles.
 */
const TONE_DOT_CLASS: Record<HostStatusTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  muted: "bg-text-muted/60",
};

const TONE_BANNER_CLASS: Record<HostStatusTone, string> = {
  accent: "border-accent text-accent",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  error: "border-error text-error",
  muted: "border-border-subtle text-text-secondary",
};

/** The proxy form lists every known runtime kind (availability-agnostic:
 *  proxying is a host-network concern, not a "can we spawn it" concern),
 *  in the shared catalog's canonical display order — so a new runtime can't
 *  silently drop out of the form and the label matches every other surface. */
const PROXY_RUNTIMES: readonly RuntimeKind[] = RUNTIME_ORDER_LIST;

export interface HostDetailViewProps {
  host: HostDto;
}

export function HostDetailView({ host }: HostDetailViewProps): JSX.Element {
  const qc = useQueryClient();
  const viewer = useViewerUser();
  const statusQuery = useHostStatusQuery(host.id);
  const renameMutation = useUpdateHostMutation(host.id);

  const refresh = () => qc.invalidateQueries({ queryKey: hostStatusKey(host.id) });

  const statusView = useMemo(
    () => (statusQuery.data ? describeHostStatus(statusQuery.data) : null),
    [statusQuery.data],
  );

  const trimmedLabel = host.display_label?.trim() ?? "";
  const showStableName = trimmedLabel.length > 0 && trimmedLabel !== host.name;
  const viewerState = viewer.data;
  const viewerId =
    viewerState &&
    !isRegistrationRequired(viewerState) &&
    !isBackendUnreachable(viewerState) &&
    !isUpdateRequired(viewerState)
      ? viewerState.id
      : null;
  const canEditHostLocalConfig = viewerId !== null && host.creator_user_id === viewerId;
  const backendInfo = useBackendInfoSnapshot();
  const currentLocalHostId = backendInfo.data?.local_host_id ?? null;
  // The mutex among Connection / Delete / Refresh / Revoke is derived
  // by one pure predicate (`computerActions`). See its docstring for
  // the ownership + lifecycle + provisioning-source rules and the
  // four-matrix test that locks them.
  const actions = computerActions({
    host,
    viewerId,
    currentLocalHostId,
  });

  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-bg-base"
      style={paneChrome}
    >
      <HostHero
        host={host}
        showStableName={showStableName}
        statusLabel={statusView?.label ?? null}
        statusTone={statusView?.tone ?? null}
        statusLoading={statusQuery.isLoading && !statusQuery.data}
        refreshing={statusQuery.isFetching}
        onRefresh={() => void refresh()}
        onRename={async (next) => {
          await renameMutation.mutateAsync({ display_label: next });
        }}
        appManaged={host.provisioning_source === "app_install"}
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col px-6">
        {statusQuery.isLoading ? (
          <div className="py-6">
            <SectionSkeleton label="Loading host status…" />
          </div>
        ) : statusQuery.isError ? (
          <div className="py-6">
            <Banner tone="error">
              Could not load this computer&rsquo;s status.
              {statusQuery.error instanceof Error ? ` (${statusQuery.error.message})` : ""}
            </Banner>
          </div>
        ) : statusQuery.data ? (
          <>
            {statusQuery.data.availability === "disconnected" &&
            statusQuery.data.admission_failure ? (
              <AdmissionFailureNotice
                failure={statusQuery.data.admission_failure}
                appManaged={host.provisioning_source === "app_install"}
              />
            ) : null}
            {statusQuery.data.availability === "available" ? (
              <SystemSection snapshot={statusQuery.data.snapshot} />
            ) : (
              <OfflineSection status={statusQuery.data} />
            )}
            {actions.connection ? (
              <ConnectionSection host={host} availability={statusQuery.data.availability} />
            ) : null}
            {actions.refresh ? <RefreshCredentialsSection host={host} /> : null}
            {canEditHostLocalConfig ? (
              <ProxySection hostId={host.id} availability={statusQuery.data.availability} />
            ) : null}
            <RegisteredAgentsSection hostId={host.id} agents={statusQuery.data.agents} />
          </>
        ) : null}
        {/* Footer action group (#task:1619, shiki 2026-07-26). `Copy
            diagnostics` and the one terminal verb this computer allows are ONE
            group: full-width buttons, a single divider above the group, none
            between them. They used to be two sibling `<section>`s, so the
            divider + double `py-6` read as two unrelated pages of settings.
            Diagnostics still lives outside the status-conditional branches
            above — offline / unreachable / status-load-failed is exactly when a
            user reaches for it — and `revoke` / `delete` are mutually exclusive
            per `computerActions`, so this group is never more than two rows. */}
        <section className="flex flex-col gap-2 border-t border-border-subtle py-6 first:border-t-0">
          <HostDiagnosticsAction host={host} />
          {actions.revoke ? <RevokeComputerSection host={host} /> : null}
          {actions.delete ? <DeleteComputerSection host={host} /> : null}
        </section>
      </div>
    </main>
  );
}

/* ─── Connection (user-managed connect / disconnect) ────────────── */

/**
 * #task:1348 — the target-page Connection section for a user-managed
 * computer. Deliberately minimal (shiki): the user only needs to know how
 * to connect and how to disconnect — no rules prose. Two buttons:
 *
 *   - **Generate connection command** (rotate the credential) — mints a
 *     fresh reveal-once command; the backend invalidates the previous token
 *     and force-drops any machine currently using it. The connect /
 *     re-pair / lost-command / move-machine path.
 *   - **Disconnect** — credential-preserving: drops the live WS without
 *     touching the token, so the same command reconnects. Shown ONLY while
 *     the computer is actually connected (`availability === 'available'`);
 *     nothing to drop otherwise. It is "disconnect for now", not a
 *     permanent off-switch — if the machine itself restarts it reconnects
 *     with its still-valid credential. Permanently removing a computer is
 *     Delete, a computer-level action that lives OUTSIDE this section
 *     (#task:1354).
 *
 * The rotate cleartext is reveal-once: the `connect_token` lands in local
 * state (`minted`) and the shared `ConnectionCommandCard` assembles the command
 * locally (#task:1428) from it + this desktop's connected server URL. Both are
 * discarded on unmount — never cached, never logged.
 */
function ConnectionSection({
  host,
  availability,
}: {
  host: HostDto;
  availability: HostStatusResponse["availability"];
}): JSX.Element {
  const rotate = useRotateConnectTokenMutation(host.id);
  const disconnect = useDisconnectHostMutation(host.id);
  // #task:1428 — the command is assembled locally from this desktop's own
  // connected server URL, never the server-echoed `server_url`.
  const backendInfo = useBackendInfoSnapshot();
  const [minted, setMinted] = useState<{
    daemonNpmSpec: string;
    connectToken: string;
  } | null>(null);
  const [rotateError, setRotateError] = useState(false);
  const [disconnectError, setDisconnectError] = useState(false);

  const handleGenerate = async (): Promise<void> => {
    setRotateError(false);
    try {
      const res = await rotate.mutateAsync();
      setMinted({
        daemonNpmSpec: res.daemon_npm_spec,
        connectToken: res.connect_token,
      });
    } catch {
      setRotateError(true);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    setDisconnectError(false);
    try {
      await disconnect.mutateAsync();
      // On success availability flips to `disconnected` → the button hides.
    } catch {
      setDisconnectError(true);
    }
  };

  return (
    <HostSection title={computerCopy.connectionSectionTitle}>
      <div className="flex flex-col gap-3">
        {minted ? (
          <ConnectionCommandCard
            daemonNpmSpec={minted.daemonNpmSpec}
            connectToken={minted.connectToken}
            connectedServerUrl={backendInfo.data?.url ?? ""}
          />
        ) : null}

        <div className="flex flex-col items-start gap-2">
          <Button
            size="sm"
            onClick={() => void handleGenerate()}
            disabled={rotate.isPending}
            {...primaryAction("gap-2")}
          >
            {rotate.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {computerCopy.generateCommand}
          </Button>

          {availability === "available" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleDisconnect()}
              disabled={disconnect.isPending}
              {...neutralAction("gap-2")}
            >
              {disconnect.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              {computerCopy.disconnectCurrent}
            </Button>
          ) : null}
        </div>

        {rotateError ? <p className="text-xs text-error">{computerCopy.rotateFailed}</p> : null}
        {disconnectError ? (
          <p className="text-xs text-error">{computerCopy.disconnectFailed}</p>
        ) : null}
      </div>
    </HostSection>
  );
}

/* ─── Refresh credentials (app-managed, current-machine only) ──── */

/**
 * The app-managed counterpart to `ConnectionSection`. Rotates the
 * backend-issued host token in local daemon-config via a main-process
 * IPC (`window.silverhand.rotateHostToken`) — token bytes NEVER enter
 * the renderer. Deliberately NOT merged with `ConnectionSection`: the
 * two target different daemon layers (local config vs. server-issued
 * connect-token) and their copy is different.
 *
 * Gated (by `computerActions`) to `host.id === currentLocalHostId`
 * because the mutation writes to THIS desktop's daemon config; trying
 * to rotate another machine's app-managed token from here would
 * silently miss the daemon that actually reads it.
 */
function RefreshCredentialsSection({ host }: { host: HostDto }): JSX.Element {
  const rotate = useRotateHostTokenMutation(host.id);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = async (): Promise<void> => {
    setError(null);
    setSaved(false);
    try {
      await rotate.mutateAsync();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : computerCopy.refreshCredentialsFailed);
    }
  };

  return (
    <HostSection title={computerCopy.refreshCredentialsTitle}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">{computerCopy.refreshCredentialsBody}</p>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={rotate.isPending}
            {...primaryAction("gap-2")}
          >
            {rotate.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {rotate.isPending
              ? computerCopy.refreshingCredentials
              : computerCopy.refreshCredentials}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="size-3.5" />
              {computerCopy.refreshCredentialsSuccess}
            </span>
          ) : null}
        </div>
        {error ? <p className="text-xs text-error">{error}</p> : null}
      </div>
    </HostSection>
  );
}

/* ─── Revoke (app-managed, soft) ────────────────────────────────── */

/**
 * The app-managed soft-revoke surface. Distinct from
 * `DeleteComputerSection` (user-managed terminal delete): revoke sets
 * `revoked_at`, invalidates the credential, and force-drops the live
 * WS while preserving agents and workspaces (doc §5.3). Different
 * component, different mutation, different confirm copy — the two
 * never share a backend verb.
 *
 * Visually the trigger is the SAME red poster sticker as Delete (shiki
 * 2026-07-26: "Revoke Computer 按钮也改成这个样式"). Ranking the two verbs
 * by chrome was the earlier read and it was wrong: both are terminal for
 * this computer's connection, they are mutually exclusive (a computer
 * offers one or the other, never both), so a user never sees them side by
 * side to compare. The difference that matters — reversible vs permanent,
 * what survives — is carried by the verb and by the confirm copy, not by a
 * quieter frame.
 *
 * Revoking the current local computer does NOT log the user out.
 * User sessions are user-level and outlive Computer lifecycle; the
 * detail view flips to the revoked-terminal read-only shape (via the
 * invalidated queries) and the user can add another computer or keep
 * using other daemon-connected computers.
 */
function RevokeComputerSection({ host }: { host: HostDto }): JSX.Element {
  const revoke = useRevokeComputerMutation(host.id);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const openConfirm = (): void => {
    setFailed(false);
    setOpen(true);
  };

  const handleRevoke = async (): Promise<void> => {
    setFailed(false);
    try {
      await revoke.mutateAsync();
      setOpen(false);
    } catch {
      setFailed(true);
    }
  };

  const label = host.display_label?.trim() || host.name;

  return (
    <>
      <Button
        variant="outline"
        onClick={openConfirm}
        {...destructiveAction(`gap-2 ${HOST_ACTION_BUTTON_DANGER}`)}
      >
        <ShieldOff className="size-3.5" />
        {computerCopy.revokeComputer}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailed(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{computerCopy.revokeConfirmTitle}</DialogTitle>
            <DialogDescription asChild>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
                {computerCopy.revokeConfirmFacts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </DialogDescription>
          </DialogHeader>
          {failed ? <p className="text-xs text-error">{computerCopy.revokeFailed}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={revoke.isPending}
              {...destructiveCancel()}
            >
              {computerCopy.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleRevoke()}
              disabled={revoke.isPending}
              {...destructiveAction("gap-2")}
              aria-label={`${computerCopy.revokeComputer}: ${label}`}
            >
              {revoke.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldOff className="size-3.5" />
              )}
              {revoke.isPending ? computerCopy.revoking : computerCopy.revokeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ─── Delete (computer-level removal) ───────────────────────────── */

/**
 * #task:1354 / #task:1380 — the single computer-level removal verb. Deliberately
 * lives OUTSIDE the Connection section (shiki: "delete 不应该在 connection 中,在别
 * 的地方") as a quiet danger action at the page footer, not a loud red box —
 * the error tone + the confirm dialog carry the warning, so the trigger stays
 * an outline button (the saturated fill is reserved for the actual commit
 * inside the dialog).
 *
 * TWO STEPS, not a discovery loop (shiki 2026-07-25): opening the dialog reads
 * `GET /hosts/:id/resources` — the ordinary "what is rooted on this computer"
 * query — shows the impact, and takes ONE confirm that sends
 * `cascade_dependents: true`. The structural branch is decided by
 * `resolveDeleteComputerPhase` (pure, unit-tested) off that read, BEFORE anything
 * destructive is offered; this component only renders what it returns:
 *   - **loading** — the standard confirm screen with Delete disabled. The impact
 *     must be on screen before the button can be pressed.
 *   - **confirm** — the impact is known: keeps the standard delete copy and adds
 *     the agent block below it (shiki's 2026-07-07 gate), then takes one
 *     confirm. An EMPTY impact is a legitimate read (an empty computer), so it
 *     renders the same screen with no block — and still sends the same flag,
 *     because consent is over the computer, not over the rows that happened to be
 *     listed (Cindy: gating the flag on "preview was non-empty" would smuggle a
 *     1-bit staleness check back into the protocol).
 *   - **unavailable** — the read failed. Fail closed: no Delete at all, retry or
 *     cancel. "Couldn't check" must never render as "nothing on it".
 * The impact names agents only (#task:1809): shared workspaces are not rooted on
 * a computer and survive it, so there is no unowned-workspace screen to reach.
 * Execution failures add to the current screen rather than replacing it, except
 * `pending` (an agent is still materializing — a transient wait-and-retry that
 * the preview deliberately does not predict).
 */
function DeleteComputerSection({ host }: { host: HostDto }): JSX.Element {
  const del = useDeleteComputerMutation(host.id);
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<DeleteComputerFailure | null>(null);
  // Fresh read per open (see `useHostResourcesQuery`): the confirm must show
  // current ownership, not a list cached from a previous visit — which is why
  // `isFetching` is part of the gate, not just `isPending`.
  const resources = useHostResourcesQuery(host.id, { enabled: open });
  const phase = resolveDeleteComputerPhase({
    isPending: resources.isPending,
    isFetching: resources.isFetching,
    isError: resources.isError,
    data: resources.data,
  });

  const openConfirm = (): void => {
    setFailure(null);
    setOpen(true);
  };

  const handleDelete = async (): Promise<void> => {
    setFailure(null);
    try {
      await del.mutateAsync({ cascadeDependents: true });
      // Success: the deleted row drops out of the host list, which clears the
      // selection app-side. Close the dialog; this view will unmount/remount.
      setOpen(false);
    } catch (err) {
      setFailure(resolveDeleteFailure(err));
    }
  };

  const label = host.display_label?.trim() || host.name;

  return (
    <>
      <Button
        variant="outline"
        onClick={openConfirm}
        {...destructiveAction(`gap-2 ${HOST_ACTION_BUTTON_DANGER}`)}
      >
        <Trash2 className="size-3.5" />
        {computerCopy.deleteComputer}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Reset transient state whenever the dialog fully closes so a
          // re-open always starts from a fresh read + clean confirm.
          setOpen(next);
          if (!next) setFailure(null);
        }}
      >
        <DialogContent className="max-w-md">
          {failure === "pending" ? (
            <>
              <DialogHeader>
                <DialogTitle>{computerCopy.deletePendingTitle}</DialogTitle>
                <DialogDescription>{computerCopy.deletePendingBody}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={del.isPending}
                  {...neutralAction()}
                >
                  {computerCopy.cancel}
                </Button>
                <Button
                  onClick={() => void handleDelete()}
                  disabled={del.isPending}
                  {...primaryAction("gap-2")}
                >
                  {del.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {computerCopy.deleteRetry}
                </Button>
              </DialogFooter>
            </>
          ) : phase.kind === "unavailable" ? (
            <>
              <DialogHeader>
                <DialogTitle>{computerCopy.deleteConfirmTitle}</DialogTitle>
                <DialogDescription>{computerCopy.deleteImpactUnavailable}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} {...neutralAction()}>
                  {computerCopy.cancel}
                </Button>
                <Button
                  onClick={() => void resources.refetch()}
                  disabled={resources.isFetching}
                  {...primaryAction("gap-2")}
                >
                  {resources.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {computerCopy.deleteRetry}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{computerCopy.deleteConfirmTitle}</DialogTitle>
                {/* shiki interaction gate (2026-07-07): the impact does NOT
                    replace the standard delete copy — it keeps it and adds the
                    blocks below, so the user reads the same base consequence
                    plus exactly what else goes. */}
                <DialogDescription>{computerCopy.deleteConfirmBody}</DialogDescription>
              </DialogHeader>
              {phase.kind === "confirm" && phase.agents.length > 0 ? (
                <CascadeImpact agents={phase.agents} />
              ) : null}
              {failure === "generic" ? (
                <p className="text-xs text-error">{computerCopy.deleteFailed}</p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={del.isPending}
                  {...destructiveCancel()}
                >
                  {computerCopy.cancel}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void handleDelete()}
                  // Armed only once the impact is on screen: the `loading` phase
                  // renders this same confirm, so this guard is what stops a
                  // confirm of an impact the user has not seen.
                  disabled={phase.kind !== "confirm" || del.isPending}
                  {...destructiveAction("gap-2")}
                  aria-label={`${computerCopy.deleteComputer}: ${label}`}
                >
                  {del.isPending || phase.kind === "loading" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  {del.isPending ? computerCopy.deleting : computerCopy.deleteConfirm}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * #task:1380 — cascade impact block. shiki interaction gate (2026-07-07):
 * shown UNDER the standard delete confirm (never replacing it) as a pale-amber
 * callout that names the consequence ("Agents will be removed") and lists the
 * exact agents that go with the computer.
 *
 * The `--warning-surface` fill is a per-theme soft caution tint (a clean pale
 * goose-yellow on the light themes, a translucent amber veil on slack-dark) —
 * distinct from `--warning-soft`, which is the brown-gold `--warning` at low
 * alpha and muddies into a dirty tan when used as a large fill (shiki
 * 2026-07-07). Radius follows `--control-radius` (forza6 = 0 poster corners,
 * warm = rounded), matching the other in-dialog blocks.
 *
 * The list comes from `/resources` — DB ownership, so it stays populated and
 * accurate even when the computer is offline, which is the primary case for this
 * flow (never source it from the daemon host-status view, which is empty offline
 * — Alice #task:1380).
 * Each row reuses `AgentAvatar` (runtime tint) so the identities read in the
 * same visual vocab as "Agents on this machine" above.
 */
function CascadeImpact({ agents }: { agents: HostAgentResource[] }): JSX.Element {
  return (
    <div className="rounded-(--control-radius) bg-(--warning-surface) px-3 py-2.5">
      <p className="text-(length:--text-meta) font-semibold uppercase tracking-wider text-warning">
        {computerCopy.deleteCascadeImpactTitle}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5" aria-label="Agents to be removed">
        {agents.map((agent) => {
          const knownRuntime = RuntimeKindSchema.safeParse(agent.runtime);
          return (
            <li key={agent.id} className="flex items-center gap-2">
              {knownRuntime.success ? (
                <AgentAvatar
                  runtime={knownRuntime.data as RuntimeKind}
                  size={AVATAR_PX.sm}
                  alt={agent.display_name}
                />
              ) : (
                <span
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-none bg-bg-elevated text-text-muted"
                  aria-hidden
                >
                  <Cpu className="size-3" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                {agent.display_name}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ─── Proxy (daemon-host local) ─────────────────────────────────── */
function ProxySection({
  hostId,
  availability,
}: {
  hostId: string;
  availability: HostStatusResponse["availability"];
}): JSX.Element {
  // Proxy config is host-local truth: the backend can only read/write it by
  // dispatching to a *live* daemon, so the section is editable strictly on
  // the availability axis (NOT the old kind/`isLocalSelf` axis — a remote
  // user-managed computer edits its own proxy just fine while online). When
  // offline, read and write are both unavailable, so we collapse to a single
  // short hint rather than showing a stale/locked form.
  const online = availability === "available";
  const query = useHostProxyConfigQuery(hostId, { enabled: online });
  const saveMutation = useSaveHostProxyConfigMutation(hostId);
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyRuntimes, setProxyRuntimes] = useState<Set<RuntimeKind>>(() => new Set());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed local form state from the daemon-served config. Re-runs
  // whenever the cached config refetches — keeps the form coherent if
  // another window writes the file (a rare path; renderer is the only
  // writer today, but the snapshot is shared so we still react to it).
  useEffect(() => {
    if (!query.data) return;
    setProxyUrl(query.data.proxy_url ?? "");
    setProxyRuntimes(new Set(query.data.proxy_runtimes));
    setError(null);
    setSaved(false);
  }, [query.data]);

  if (!online) {
    return (
      <HostSection title={computerCopy.proxyTitle}>
        <p className="text-sm text-text-muted">{computerCopy.proxyOfflineHint}</p>
      </HostSection>
    );
  }

  const toggleRuntime = (kind: RuntimeKind, checked: boolean): void => {
    setSaved(false);
    setError(null);
    setProxyRuntimes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const proxyEnabled = proxyUrl.trim().length > 0;
  const allChecked = PROXY_RUNTIMES.every((kind) => proxyRuntimes.has(kind));

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    // Stable canonical order driven by `PROXY_RUNTIMES` so the
    // persisted file doesn't churn just because the user clicked
    // checkboxes in a different sequence.
    const orderedRuntimes = PROXY_RUNTIMES.filter((kind) => proxyRuntimes.has(kind));
    const config: HostProxyConfig = {
      proxy_url: proxyUrl.trim() ? proxyUrl.trim() : null,
      proxy_runtimes: orderedRuntimes,
    };
    try {
      await saveMutation.mutateAsync(config);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      // config-or-throw: a raced `computer_offline` rejects here (went offline
      // between load and save) — show the same connect hint once, without
      // caching offline anywhere. Any other failure surfaces inline.
      if (isHostProxyOfflineError(err)) {
        setError(computerCopy.proxyOfflineHint);
      } else {
        setError(
          err instanceof Error && err.message
            ? `Could not save proxy settings. (${err.message})`
            : "Could not save proxy settings. Please try again.",
        );
      }
    }
  };

  const settingsLoading = query.isLoading;
  const saving = saveMutation.isPending;

  return (
    <HostSection title={computerCopy.proxyTitle}>
      {settingsLoading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>Loading proxy settings…</span>
        </div>
      ) : query.isError ? (
        // config-or-throw: a raced `computer_offline` (went unreachable
        // between the availability gate and the GET landing) propagates as a
        // query error — classify it and show the same short connect hint;
        // any other failure is a real load error. Durable offline is the
        // availability gate above, not this branch.
        isHostProxyOfflineError(query.error) ? (
          <Banner tone="muted">{computerCopy.proxyOfflineHint}</Banner>
        ) : (
          <Banner tone="error">
            Could not load proxy settings.
            {query.error instanceof Error ? ` (${query.error.message})` : ""}
          </Banner>
        )
      ) : (
        <form onSubmit={handleSubmit} className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="proxy-url">Proxy URL</Label>
            {/* v6.9 (#task:917, shiki computer-pane review): proxy URLs
                are host:port / scheme strings — make the input read as a
                config value, not prose. `font-mono` on the field itself
                keeps it readable across themes; the `data-host-proxy-url`
                hook lets forza6 layer HUD-specific weight/tracking
                without forking the input. */}
            <Input
              id="proxy-url"
              data-host-proxy-url
              className="font-mono"
              value={proxyUrl}
              onChange={(event) => {
                setProxyUrl(event.target.value);
                setSaved(false);
                setError(null);
              }}
              placeholder="http://127.0.0.1:7897"
              disabled={settingsLoading}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label>Enabled runtimes</Label>
              <button
                type="button"
                disabled={!proxyEnabled}
                className="text-xs font-medium text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setSaved(false);
                  setError(null);
                  setProxyRuntimes(allChecked ? new Set() : new Set(PROXY_RUNTIMES));
                }}
              >
                {allChecked ? "Clear all" : "Select all"}
              </button>
            </div>

            <div className={cn("grid gap-2 sm:grid-cols-2", !proxyEnabled && "opacity-55")}>
              {PROXY_RUNTIMES.map((kind) => {
                const checked = proxyRuntimes.has(kind);
                return (
                  <label
                    key={kind}
                    // v6.9.2 #task:917 (shiki "runtime 选中 background 和
                    // border 不搭"): the generic `border-accent` + `bg-row-
                    // selected` pair lands as pink-border + acid-lime fill
                    // in forza6 — two high-sat hues fighting. The
                    // `data-runtime-tile` + `data-checked` hooks let
                    // forza6 swap the border (and inner check fill) to
                    // ink-black so the tile reads as a poster-sticker
                    // family member (lime ground + 1px ink stroke) instead
                    // of clashing complements. Other themes keep the
                    // accent border untouched.
                    data-runtime-tile
                    data-checked={checked || undefined}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-(--control-radius) border px-3 py-2 transition-colors",
                      proxyEnabled ? "cursor-pointer" : "cursor-not-allowed",
                      checked
                        ? "border-accent bg-(--bg-row-selected,var(--bg-selected)) text-text-on-selected"
                        : "border-border-subtle bg-bg-floating hover:bg-(--bg-option-hover)",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={(event) => toggleRuntime(kind, event.target.checked)}
                      disabled={!proxyEnabled}
                    />
                    <span
                      data-runtime-tile-check
                      data-checked={checked || undefined}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-(--control-radius) border",
                        checked
                          ? "border-accent bg-accent text-text-on-accent"
                          : "border-border-subtle bg-bg-floating text-transparent",
                      )}
                      aria-hidden
                    >
                      <Check className="size-3" />
                    </span>
                    <AgentAvatar runtime={kind} size={AVATAR_PX.sm} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm font-medium",
                        !checked && "text-text-primary",
                      )}
                    >
                      {runtimeLabel(kind)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-(length:--text-meta)",
                        !checked && "text-text-muted",
                      )}
                    >
                      {kind}
                    </span>
                  </label>
                );
              })}
            </div>
            {!proxyEnabled ? (
              <p className="text-xs text-text-muted">Add a Proxy URL before selecting runtimes.</p>
            ) : null}
          </div>

          {/* Save row sits inline with the form content rather than
              pinned to a sticky footer — the original bottom anchor
              was off-screen on shorter viewports and easy to miss. */}
          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="min-w-0 text-xs">
              {error ? (
                <span className="text-error">{error}</span>
              ) : saved ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="size-3.5" />
                  Saved
                </span>
              ) : null}
            </div>
            <Button type="submit" disabled={saving || settingsLoading} {...primaryAction("gap-2")}>
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {saving ? "Saving..." : "Save settings"}
            </Button>
          </div>
        </form>
      )}
    </HostSection>
  );
}

/* ─── Hero ──────────────────────────────────────────────────────── */

function HostHero({
  host,
  showStableName,
  statusLabel,
  statusTone,
  statusLoading,
  refreshing,
  onRefresh,
  onRename,
  appManaged,
}: {
  host: HostDto;
  showStableName: boolean;
  statusLabel: string | null;
  statusTone: HostStatusTone | null;
  statusLoading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRename: (next: string | null) => Promise<void>;
  /** Provenance chip in the state row. This is lifecycle/origin
   *  metadata (per doc §3.1), NOT a capability signal — the four
   *  danger surfaces below are picked by `computerActions`, not by
   *  this flag. */
  appManaged: boolean;
}): JSX.Element {
  return (
    <header className="flex shrink-0 items-start gap-4 border-b border-border-subtle bg-bg-floating px-6 py-4">
      <HostBadge />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="font-serif text-lg font-semibold leading-tight text-text-primary">
          <InlineRename
            value={host.display_label}
            placeholder={host.name}
            fallbackForEdit={host.display_label ?? host.name}
            ariaLabel="Rename this computer"
            onCommit={onRename}
          />
        </div>

        <div className="flex items-center gap-2">
          {statusLabel && statusTone ? (
            <StatusChip label={statusLabel} tone={statusTone} />
          ) : statusLoading ? (
            <span className="inline-flex items-center gap-1.5 border border-transparent px-1 py-0.5 text-(length:--text-badge) text-text-muted">
              <Loader2 className="size-3.75 animate-spin" aria-hidden />
              <span>Loading…</span>
            </span>
          ) : null}
          {appManaged ? <ProvenanceChip /> : null}
          <Button
            variant="ghost"
            size="icon"
            // Drop the default `size="icon"` (h-8 w-8 p-0). Use the
            // same border + py-0.5 construction as the chip so the
            // button height tracks the chip's text-derived height
            // automatically — same anatomy, swapped fill (the chip's
            // visible border becomes a transparent placeholder here so
            // padding alignment is identical).
            className="h-auto w-auto border border-transparent px-1 py-0.5"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh host status"
            title="Refresh"
          >
            <RefreshCw className={cn("size-3.75", refreshing && "animate-spin")} />
          </Button>
        </div>
        {/* Meta line: stable `host.name` (mono) ONLY when the user has
            renamed the host AND the rename actually differs from the
            underlying name. Otherwise the title (which falls back to
            `host.name` itself) would repeat the same string here —
            "two local" déjà-vu (shiki `CEq57Kisu3w2d-Pl` /
            Cindy `Fjg86GQM5qwoEjl7`). */}
        {showStableName ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
            <span className="font-mono">{host.name}</span>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/**
 * Host "avatar" analog. Mirrors `AgentAvatar`'s tinted square so the
 * Hero reads as identity-led (same silhouette as Members/Profile
 * panels), without inventing a host-specific decoration.
 *
 * Sized to roughly match the right-column stack height (title + state
 * row + meta) so the icon carries visual weight equal to the textual
 * identity instead of looking dwarfed beside the lg/serif title —
 * shiki dogfood `hLEODapuI_dHuCPz`.
 */
function HostBadge(): JSX.Element {
  // Every computer wears the same Monitor glyph — provenance/availability
  // is conveyed elsewhere, never by swapping the identity icon (shiki
  // dogfood: a network glyph made user-added computers read as a different
  // kind of thing). Kept in sync with the sidebar row's icon rule.
  const Icon = Monitor;
  return (
    <span
      data-host-hero
      data-sticker
      data-sticker-tone="host"
      data-sticker-no-frame
      data-sticker-size="lg"
      className="inline-flex size-20 shrink-0 items-center justify-center rounded-none bg-bg-elevated text-text-secondary"
      aria-hidden
    >
      <Icon className="size-9" />
    </span>
  );
}

function StatusChip({ label, tone }: { label: string; tone: HostStatusTone }): JSX.Element {
  return (
    <span
      role="status"
      data-panel-pill="host-status"
      className="inline-flex items-center gap-1.5 border border-border-subtle bg-transparent px-2 py-0.5 text-(length:--text-badge) font-semibold uppercase tracking-wider text-text-secondary"
    >
      <span
        data-status-pip
        className={cn("size-1.5 rounded-(--pill-radius)", TONE_DOT_CLASS[tone])}
        aria-hidden
      />
      {label}
    </span>
  );
}

/**
 * Provenance chip — sibling of `StatusChip` in geometry, distinct in
 * meaning. This is lifecycle/origin metadata (per doc §3.1: "explains
 * where a host came from; drives nothing runtime"), never a capability
 * signal. The four danger surfaces are picked by `computerActions`,
 * not by anything a viewer can read here.
 */
function ProvenanceChip(): JSX.Element {
  return (
    <span
      data-panel-pill="host-provenance"
      className="inline-flex items-center border border-border-subtle bg-transparent px-2 py-0.5 text-(length:--text-badge) font-semibold uppercase tracking-wider text-text-muted"
    >
      {computerCopy.appManaged}
    </span>
  );
}

/* ─── System (available) ────────────────────────────────────────── */

function SystemSection({
  snapshot,
}: {
  snapshot: Extract<HostStatusResponse, { availability: "available" }>["snapshot"];
}): JSX.Element {
  return (
    <HostSection title="System">
      {/* shiki dogfood `6QIZeGVS8u8yJ137`: one row per field. Inline
          label + value (not stacked) so 4 short facts read as a tight
          key-value list, not a stretched form.

          v6.9 (#task:917, shiki computer-pane review): wrap the `<dl>`
          in `data-host-system-list` and each value column in `data-
          host-system-value` so forza6 can paint label-column HUD caps
          + tabular spacing without leaking theme code into the base
          structure. Base styling stays plain; ID/version/PID/uptime
          values pick up `tabular-nums` here so digits line up across
          rows regardless of theme. */}
      <dl data-host-system-list className="flex flex-col gap-2.5">
        <SystemField label="OS">
          <span className="text-text-primary">{formatOsShort(snapshot.os)}</span>
          {snapshot.os_arch ? (
            <span className="ml-1 text-text-muted">({snapshot.os_arch})</span>
          ) : null}
        </SystemField>
        <SystemField label="Daemon version">
          <span className="font-mono text-text-primary">{snapshot.daemon_version}</span>
        </SystemField>
        <SystemField label="Process id">
          <span className="font-mono text-text-primary">{snapshot.daemon_pid}</span>
        </SystemField>
        <SystemField label="Uptime">
          <span className="text-text-primary">{formatUptime(snapshot.uptime_ms)}</span>
        </SystemField>
      </dl>
    </HostSection>
  );
}

function SystemField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="w-36 shrink-0 text-(length:--text-meta) font-medium uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd data-host-system-value className="min-w-0 flex-1 text-sm tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/* ─── Offline arms ──────────────────────────────────────────────── */

/**
 * #task:1631 — the "this one needs attention" notice on a computer page.
 *
 * shiki interaction gate (2026-07-26): an incompatible-version prompt for
 * a computer is **not** a banner — it is a notice placed on that
 * computer's page, pale-yellow fill + icon. So it reuses the established
 * caution-callout vocabulary of this file (`--warning-surface` fill +
 * `--control-radius`, the same form as `CascadeImpact`) instead of the
 * status `Banner`, and the status
 * chrome keeps saying plain "Offline" — one voice per question: the pill
 * answers "is it connected", this answers "what do I do about it".
 *
 * `AlertTriangle`, deliberately not an update/download glyph: the only
 * fix runs on that machine, so an icon that reads like an in-app update
 * affordance would promise a button that does not exist.
 *
 * `appManaged` selects which artifact the action clause names (the app
 * itself vs the published package the connection command installs) — see
 * `describeAdmissionFailure`.
 */
function AdmissionFailureNotice({
  failure,
  appManaged,
}: {
  failure: HostAdmissionFailure;
  appManaged: boolean;
}): JSX.Element {
  return (
    <div
      role="status"
      className="mt-5 flex items-start gap-2.5 rounded-(--control-radius) bg-(--warning-surface) px-3 py-2.5"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-text-primary">
        {describeAdmissionFailure(failure, { appManaged })}
      </p>
    </div>
  );
}

function OfflineSection({
  status,
}: {
  status: Exclude<HostStatusResponse, { availability: "available" }>;
}): JSX.Element {
  const view = describeHostStatus(status);
  // No generic "will appear when the computer is back online" fallback:
  // every non-available arm already carries its own detail, and one of
  // them (`disconnected` + `admission_failure`, `#task:1631`) is offline
  // precisely BECAUSE it will not come back unattended — printing a
  // wait-and-see promise there would be the one wrong thing to say.
  return (
    <HostSection title="System">
      <Banner tone={view.tone}>
        <span className="font-medium">{view.label}.</span> {view.detail}
      </Banner>
    </HostSection>
  );
}

/* ─── Registered agents ─────────────────────────────────────────── */

function RegisteredAgentsSection({
  hostId,
  agents,
}: {
  hostId: string;
  agents: AgentOnHostDto[];
}): JSX.Element {
  const nav = useNav();
  // Agent-on-computer liveness (layer-2) is the SAME fact the rail dot
  // reads. Read it from the shared `useAgentOnlineByHost` (same
  // `hostStatusKey`, event-driven: the backend pushes
  // `host_agent_liveness_changed` invalidations — #task:1588 removed
  // the old 5s poll) so the pip stays single-source with the rail dot.
  // Falls back to the frozen snapshot's `online` until the first live
  // sample lands. Do NOT source layer-3 conversation status here —
  // this list's subject is the computer.
  const liveOnlineByHost = useAgentOnlineByHost([hostId]);
  // shiki dogfood `DXVl5tEBshVT2LqF` #2: route avatar uploads through
  // the shared object-URL cache so cards show the user-picked image
  // instead of the runtime tint fallback. Memoize the source list so
  // the batch hook's cache key stays stable across renders.
  const avatarSources = useMemo(
    () => agents.map((a) => ({ id: a.agent_id, avatar_url: a.avatar_url })),
    [agents],
  );
  const avatarUrls = useAgentAvatarObjectUrls(avatarSources);
  return (
    <HostSection
      title={
        <span className="inline-flex items-baseline gap-2">
          <span>Agents on this machine</span>
          <span className="text-text-muted">{agents.length}</span>
        </span>
      }
    >
      {agents.length === 0 ? (
        <p className="text-sm text-text-muted">No agents are registered on this computer yet.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Agents on this machine">
          {agents.map((agent) => {
            const live = liveOnlineByHost.get(agent.agent_id);
            const online: "online" | "offline" =
              live === undefined ? agent.online : live ? "online" : "offline";
            return (
              <AgentCard
                key={agent.agent_id}
                agent={agent}
                online={online}
                avatarObjectUrl={avatarUrls.get(agent.agent_id) ?? null}
                onOpen={() => nav.toMembers(agent.agent_id)}
              />
            );
          })}
        </ul>
      )}
    </HostSection>
  );
}

/* ─── HostSection (local) ───────────────────────────────────────── */

/**
 * Section primitive for this surface. shiki #task:1360 redesign: the
 * previous version wrapped each section's body in a solid white card
 * (`data-panel-card="profile-section"` border + `bg-bg-floating` tile +
 * `p-4` + hover border, amplified to a 2px frame in forza6). Multiple
 * equal-weight boxes read as "obvious boxes" and diluted the hierarchy —
 * the loudness budget went to containers instead of content.
 *
 * Now a section is just a **title + flush-left content**, separated from
 * the previous section by a single hairline (`border-t border-border-subtle`,
 * skipped on the first child). No box, no inner padding inset, so the title
 * and its content share one left edge and the whole pane reads as one
 * continuous document rather than an admin dashboard. Controls inside a
 * section (proxy input, runtime tiles, agent row cards) keep their own
 * borders — they are controls, not section boxes.
 *
 * The title stays a quiet uppercase caps label (the box was the noise, not
 * the title). Vertical rhythm is `py-6` per section; the hairline lands in
 * the gap between two sections.
 */
function HostSection({
  title,
  children,
}: {
  /** ReactNode so the caller can compose inline trailing content
   *  (e.g. an agent count number after the title text). Per shiki
   *  dogfood `6QIZeGVS8u8yJ137`: no right-aligned headerSlot for
   *  this surface — counts read better attached to the title than
   *  floating at the far edge. */
  title: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col border-t border-border-subtle py-6 first:border-t-0">
      <header className="mb-3.5">
        <h3 className="text-(length:--text-meta) font-semibold uppercase tracking-[0.14em] text-text-muted">
          {title}
        </h3>
      </header>
      <div>{children}</div>
    </section>
  );
}

/**
 * Per-agent identity card. Reuses `AgentAvatar` (with the user-
 * uploaded `avatarObjectUrl` when available) so the host detail
 * surface speaks the same identity vocab as #Members / Chat. Status
 * reads as a dot+text pip aligned with the Hero status indicator.
 *
 * **Border / radius / hover** (shiki dogfood `DXVl5tEBshVT2LqF` #1):
 * uses plain theme tokens — `border-border-subtle` at rest,
 * transitions to `border-text-primary` on hover — with width driven
 * by `var(--control-border-width)` (forza6 = 2px, warm = 1px) so the
 * card chrome matches the theme's stroke weight. Radius is NOT forced
 * here: forza6 wants 0 (poster aesthetic) and the browser default is
 * 0, which is what we get without inline radius styling. The previous
 * `var(--card-radius)` (forza6 = 6px) was wrong — shiki only asked
 * for a color change, not a corner change.
 *
 * **Click**: the whole card is a button that navigates to
 * `routes.membersAgent(id)` — same destination as the #Members tab
 * uses. `<li>` wrapping a button keeps the list semantics intact while
 * the inner button takes the focus/click handlers.
 *
 * `AgentOnHostDto.runtime` is `string` on the wire (forward-compat for
 * future runtimes daemon-side). We narrow via `RuntimeKindSchema.safeParse`;
 * a runtime the renderer doesn't know yet renders a generic
 * `<Cpu />` tile rather than borrowing a brand color we don't own.
 */
function AgentCard({
  agent,
  online,
  avatarObjectUrl,
  onOpen,
}: {
  agent: AgentOnHostDto;
  online: "online" | "offline";
  avatarObjectUrl: string | null;
  onOpen: () => void;
}): JSX.Element {
  const knownRuntime = RuntimeKindSchema.safeParse(agent.runtime);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${agent.display_name} profile`}
        className="flex w-full items-center gap-3 rounded-(--row-radius) border-(length:--control-border-width) border-border-subtle bg-bg-floating px-3 py-2.5 text-left transition-colors hover:border-text-primary focus-visible:border-text-primary focus-visible:outline-none"
      >
        {knownRuntime.success ? (
          <AgentAvatar
            runtime={knownRuntime.data as RuntimeKind}
            size={AVATAR_PX.xl}
            avatarObjectUrl={avatarObjectUrl}
            alt={agent.display_name}
          />
        ) : (
          <span
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-none bg-bg-elevated text-text-muted"
            aria-hidden
            title={`${agent.runtime} (unknown runtime)`}
          >
            <Cpu className="size-5" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-text-primary">
            {agent.display_name}
          </span>
          <span className="truncate text-xs text-text-muted">
            {/* `handle` is already `@<name>` per backend DTO contract —
             *  do NOT prefix here or the UI shows `@@<name>`. */}
            <span className="font-mono">{agent.handle}</span>
            <span className="mx-1.5" aria-hidden>
              ·
            </span>
            <span className="uppercase tracking-wide">{agent.runtime}</span>
          </span>
        </div>
        <AgentStatusPip online={online} />
      </button>
    </li>
  );
}

/**
 * Per-agent online indicator. Same dot-plus-text form as the Hero
 * `StatusChip` — drop the prior filled `bg-success` pill so the cards
 * stay quiet on hover/sweep and the green dot does the at-a-glance
 * signaling (shiki dogfood `CEq57Kisu3w2d-Pl`: "色彩使用注意主题搭配").
 */
function AgentStatusPip({ online }: { online: "online" | "offline" }): JSX.Element {
  return (
    <span
      role="status"
      aria-label={online === "online" ? "Online" : "Offline"}
      className="inline-flex items-center gap-1.5 text-(length:--text-meta) font-medium uppercase tracking-wider text-text-muted"
    >
      <span
        data-status-pip
        className={cn(
          "size-1.5 rounded-(--pill-radius)",
          online === "online" ? "bg-success" : "bg-text-muted/40",
        )}
        aria-hidden
      />
      {online === "online" ? "Online" : "Offline"}
    </span>
  );
}

/* ─── shared bits ───────────────────────────────────────────────── */

function SectionSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 text-sm text-text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

function Banner({ tone, children }: { tone: HostStatusTone; children: ReactNode }): JSX.Element {
  return (
    <div
      className={cn("border bg-bg-floating px-3 py-2 text-sm", TONE_BANNER_CLASS[tone])}
      role="status"
    >
      {children}
    </div>
  );
}
