/**
 * `#task:808` slice 4 / `#task:809` polish — host detail / right pane.
 *
 * Identity-led layout that reuses the renderer's existing profile-card
 * vocabulary so this surface feels like part of the app instead of an
 * admin dashboard.
 *
 *   Header        — PersonHero-shape strip: tinted icon square as the
 *                   "avatar" (sized to balance the right-column stack
 *                   weight) plus a 3-row identity column:
 *                     1. InlineRename'able display label,
 *                     2. lightweight status (colored dot + uppercase
 *                        text) + Refresh button,
 *                     3. meta line (`host.name` only; kind is conveyed
 *                        by the badge icon — Monitor=local /
 *                        Globe=remote).
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
 * Manual-refresh contract: `useHostStatusQuery` pins
 * `staleTime: Infinity` + no focus/interval refetch. The Refresh button
 * invalidates the query key on click.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Cpu,
  Globe,
  Loader2,
  Monitor,
  RefreshCw,
  Save,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  AgentOnHostDto,
  HostDto,
  HostStatusResponse,
  RuntimeKind,
} from '@silverhand/shared';
import { RuntimeKindSchema, RUNTIME_ORDER_LIST, runtimeLabel } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { useNav } from '@/router';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  hostStatusKey,
  useHostProxyConfigQuery,
  useHostStatusQuery,
  useSaveHostProxyConfigMutation,
  useUpdateHostMutation,
  type HostProxyConfig,
} from './hooks';
import {
  describeHostStatus,
  formatUptime,
  type HostStatusTone,
} from './host-status-presentation';
import { InlineRename } from './InlineRename';
import { formatOsShort } from './format-os';

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
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  muted: 'bg-text-muted/60',
};

const TONE_BANNER_CLASS: Record<HostStatusTone, string> = {
  accent: 'border-accent text-accent',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  error: 'border-error text-error',
  muted: 'border-border-subtle text-text-secondary',
};

/** The proxy form lists every known runtime kind (availability-agnostic:
 *  proxying is a host-network concern, not a "can we spawn it" concern),
 *  in the shared catalog's canonical display order — so a new runtime can't
 *  silently drop out of the form and the label matches every other surface. */
const PROXY_RUNTIMES: readonly RuntimeKind[] = RUNTIME_ORDER_LIST;

export interface HostDetailViewProps {
  host: HostDto;
  localHostId: string | null;
}

export function HostDetailView({ host, localHostId }: HostDetailViewProps): JSX.Element {
  const qc = useQueryClient();
  const viewer = useViewerUser();
  const statusQuery = useHostStatusQuery(host.id);
  const renameMutation = useUpdateHostMutation(host.id);

  const refresh = () =>
    qc.invalidateQueries({ queryKey: hostStatusKey(host.id) });

  const statusView = useMemo(
    () => (statusQuery.data ? describeHostStatus(statusQuery.data) : null),
    [statusQuery.data],
  );

  // shiki dogfood `CEq57Kisu3w2d-Pl` + Cindy `Fjg86GQM5qwoEjl7`:
  // show the stable `host.name` in the meta line ONLY when the user
  // has renamed the host AND the rename differs from the underlying
  // name. Otherwise the title (which falls back to `host.name`) and
  // meta would print the same string twice — the "two local" problem
  // shiki originally flagged, just without the kind label.
  const trimmedLabel = host.display_label?.trim() ?? '';
  const showStableName =
    trimmedLabel.length > 0 && trimmedLabel !== host.name;
  const viewerState = viewer.data;
  const viewerId =
    viewerState
    && !isRegistrationRequired(viewerState)
    && !isBackendUnreachable(viewerState)
      ? viewerState.id
      : null;
  const canEditHostLocalConfig =
    viewerId !== null && host.creator_user_id === viewerId;
  const isLocalSelf = host.id === localHostId;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-bg-base">
      <HostHero
        host={host}
        showStableName={showStableName}
        statusLabel={statusView?.label ?? null}
        statusTone={statusView?.tone ?? null}
        statusLoading={statusQuery.isLoading && !statusQuery.data}
        refreshing={statusQuery.isFetching}
        onRefresh={() => void refresh()}
        onRename={async next => {
          await renameMutation.mutateAsync({ display_label: next });
        }}
      />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
        {statusQuery.isLoading ? (
          <SectionSkeleton label="Loading host status…" />
        ) : statusQuery.isError ? (
          <Banner tone="error">
            Could not load this computer&rsquo;s status.
            {statusQuery.error instanceof Error
              ? ` (${statusQuery.error.message})`
              : ''}
          </Banner>
        ) : statusQuery.data ? (
          <>
            {statusQuery.data.availability === 'available' ? (
              <SystemSection snapshot={statusQuery.data.snapshot} />
            ) : (
              <OfflineSection status={statusQuery.data} />
            )}
            {canEditHostLocalConfig ? (
              <ProxySection hostId={host.id} isLocalSelf={isLocalSelf} />
            ) : null}
            <RegisteredAgentsSection agents={statusQuery.data.agents} />
          </>
        ) : null}
      </div>
    </main>
  );
}

/* ─── Proxy (daemon-host local) ─────────────────────────────────── */

function ProxySection({
  hostId,
  isLocalSelf,
}: {
  hostId: string;
  isLocalSelf: boolean;
}): JSX.Element {
  const query = useHostProxyConfigQuery(hostId, { enabled: isLocalSelf });
  const saveMutation = useSaveHostProxyConfigMutation(hostId);
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyRuntimes, setProxyRuntimes] = useState<Set<RuntimeKind>>(
    () => new Set(),
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed local form state from the daemon-served config. Re-runs
  // whenever the cached config refetches — keeps the form coherent if
  // another window writes the file (a rare path; renderer is the only
  // writer today, but the snapshot is shared so we still react to it).
  useEffect(() => {
    if (!query.data?.ok) return;
    setProxyUrl(query.data.config.proxy_url ?? '');
    setProxyRuntimes(new Set(query.data.config.proxy_runtimes));
    setError(null);
    setSaved(false);
  }, [query.data]);

  if (!isLocalSelf) {
    return (
      <HostSection title="Proxy" muted>
        <p className="text-sm text-text-muted">
          Proxy settings are stored on this computer. Open Silverhand on the
          physical machine that owns this host to edit them.
        </p>
      </HostSection>
    );
  }

  const toggleRuntime = (kind: RuntimeKind, checked: boolean): void => {
    setSaved(false);
    setError(null);
    setProxyRuntimes(prev => {
      const next = new Set(prev);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const proxyEnabled = proxyUrl.trim().length > 0;
  const allChecked = PROXY_RUNTIMES.every(kind => proxyRuntimes.has(kind));

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    // Stable canonical order driven by `PROXY_RUNTIMES` so the
    // persisted file doesn't churn just because the user clicked
    // checkboxes in a different sequence.
    const orderedRuntimes = PROXY_RUNTIMES.filter(kind =>
      proxyRuntimes.has(kind),
    );
    const config: HostProxyConfig = {
      proxy_url: proxyUrl.trim() ? proxyUrl.trim() : null,
      proxy_runtimes: orderedRuntimes,
    };
    const result = await saveMutation.mutateAsync(config);
    if (result.ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } else {
      setError(result.message ?? `Could not save proxy (${result.code}).`);
    }
  };

  const settingsLoading = query.isLoading;
  const saving = saveMutation.isPending;

  return (
    <HostSection title="Proxy">
      <p className="mb-4 text-xs leading-relaxed text-text-muted">
        Proxy configuration is injected only into newly spawned agent processes.
      </p>
      {settingsLoading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>Loading proxy settings…</span>
        </div>
      ) : query.isError ? (
        <Banner tone="error">
          Could not load proxy settings.
          {query.error instanceof Error ? ` (${query.error.message})` : ''}
        </Banner>
      ) : query.data && !query.data.ok ? (
        <Banner tone={query.data.code === 'not_local_host' ? 'muted' : 'error'}>
          {query.data.message ?? `Could not load proxy (${query.data.code}).`}
        </Banner>
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
              onChange={event => {
                setProxyUrl(event.target.value);
                setSaved(false);
                setError(null);
              }}
              placeholder="127.0.0.1:7897 / http://... / socks5://..."
              disabled={settingsLoading}
            />
            <p className="text-xs leading-relaxed text-text-muted">
              Expands into <code>http_proxy</code>, <code>https_proxy</code>,
              and <code>all_proxy</code> for selected runtimes. A bare
              host:port or <code>http://</code> value is treated as a
              mixed-port proxy; <code>socks5://</code> only sets{' '}
              <code>all_proxy</code>.
            </p>
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
                  setProxyRuntimes(
                    allChecked ? new Set() : new Set(PROXY_RUNTIMES),
                  );
                }}
              >
                {allChecked ? 'Clear all' : 'Select all'}
              </button>
            </div>

            <div
              className={cn(
                'grid gap-2 sm:grid-cols-2',
                !proxyEnabled && 'opacity-55',
              )}
            >
              {PROXY_RUNTIMES.map(kind => {
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
                      'flex min-w-0 items-center gap-3 rounded-[var(--control-radius)] border px-3 py-2 transition-colors',
                      proxyEnabled
                        ? 'cursor-pointer'
                        : 'cursor-not-allowed',
                      checked
                        ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))]'
                        : 'border-border-subtle bg-bg-floating hover:bg-[var(--bg-option-hover)]',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={event =>
                        toggleRuntime(kind, event.target.checked)
                      }
                      disabled={!proxyEnabled}
                    />
                    <span
                      data-runtime-tile-check
                      data-checked={checked || undefined}
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                        checked
                          ? 'border-accent bg-accent text-text-on-accent'
                          : 'border-border-subtle bg-bg-floating text-transparent',
                      )}
                      aria-hidden
                    >
                      <Check className="size-3" />
                    </span>
                    <AgentAvatar runtime={kind} size={22} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {runtimeLabel(kind)}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-text-muted">
                      {kind}
                    </span>
                  </label>
                );
              })}
            </div>
            {!proxyEnabled ? (
              <p className="text-xs text-text-muted">
                Add a Proxy URL before selecting runtimes.
              </p>
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
              ) : (
                <span className="text-text-muted">
                  Proxy changes save to this computer.
                </span>
              )}
            </div>
            <Button
              type="submit"
              disabled={saving || settingsLoading}
              className="gap-2"
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {saving ? 'Saving...' : 'Save settings'}
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
}: {
  host: HostDto;
  showStableName: boolean;
  statusLabel: string | null;
  statusTone: HostStatusTone | null;
  statusLoading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRename: (next: string | null) => Promise<void>;
}): JSX.Element {
  return (
    <header className="flex shrink-0 items-start gap-4 border-b border-border-subtle bg-bg-floating px-6 py-4">
      <HostBadge kind={host.kind} />

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
        {/* shiki dogfood `hLEODapuI_dHuCPz` / `z5DyAzlG34Rto52-`:
            state row in the MIDDLE between title and meta.
            v6.9 (#task:917): chip refactored to PresencePill geometry
            (border + py-0.5 + text-[10px], ≈20-21px tall), so Refresh
            and the Loading placeholder both drop from `h-7` (28px) to
            a matching structural construction (border + py-0.5 around
            a 15px glyph) — same vertical anatomy as the chip, no
            fragile pixel pin. shiki "把 refresh icon 高度调整到和前面
            的 status tag 一样高". */}
        <div className="flex items-center gap-2">
          {statusLabel && statusTone ? (
            <StatusChip label={statusLabel} tone={statusTone} />
          ) : statusLoading ? (
            <span className="inline-flex items-center gap-1.5 border border-transparent px-1 py-0.5 text-[10px] text-text-muted">
              <Loader2 className="size-[15px] animate-spin" aria-hidden />
              <span>Loading…</span>
            </span>
          ) : null}
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
            <RefreshCw
              className={cn('size-[15px]', refreshing && 'animate-spin')}
            />
          </Button>
        </div>
        {/* Meta line: stable `host.name` (mono) ONLY when the user has
            renamed the host AND the rename actually differs from the
            underlying name. Otherwise the title (which falls back to
            `host.name` itself) would repeat the same string here —
            "two local" déjà-vu (shiki `CEq57Kisu3w2d-Pl` /
            Cindy `Fjg86GQM5qwoEjl7`). Host kind is conveyed by the
            left badge icon (Monitor=local, Globe=remote). */}
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
function HostBadge({ kind }: { kind: HostDto['kind'] }): JSX.Element {
  const Icon = kind === 'local' ? Monitor : Globe;
  return (
    <span
      data-host-hero
      className="inline-flex size-20 shrink-0 items-center justify-center rounded-none bg-bg-elevated text-text-secondary"
      aria-hidden
    >
      <Icon className="size-9" />
    </span>
  );
}

/**
 * Lightweight status indicator. Geometry now mirrors `PresencePill` in
 * PersonHero (`#task:917` v6.9 — shiki "READY 是状态信号，应该是 status
 * pill 不是裸文字+大圆点"): outline pill, 6px tone-coloured dot, uppercase
 * caps with letter-tracking. That makes the host Hero's status indicator a
 * sibling of the agent/human Hero's active/idle pill — same indicator
 * family, with the dot's colour carrying the tone signal (success/warning/
 * error/info/muted). The `data-panel-pill` hook lets forza6 paint it
 * further; default themes get the outline pill as-is.
 *
 * Before v6.9 this was `h-7 px-1` plain text + 10px filled dot, which
 * read as decoration ("a green ball next to a label") rather than "host
 * is in state X". The pill form structures it as the same kind of thing
 * IDLE / 1 RUNNING etc. are in the agent Hero.
 */
function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: HostStatusTone;
}): JSX.Element {
  return (
    <span
      role="status"
      data-panel-pill="host-status"
      className="inline-flex items-center gap-1.5 border border-border-subtle bg-transparent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary"
    >
      <span
        data-status-pip
        className={cn('size-1.5 rounded-full', TONE_DOT_CLASS[tone])}
        aria-hidden
      />
      {label}
    </span>
  );
}

/* ─── System (available) ────────────────────────────────────────── */

function SystemSection({
  snapshot,
}: {
  snapshot: Extract<HostStatusResponse, { availability: 'available' }>['snapshot'];
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
            <span className="ml-1 text-text-muted">
              ({snapshot.os_arch})
            </span>
          ) : null}
        </SystemField>
        <SystemField label="Daemon version">
          <span className="font-mono text-text-primary">
            {snapshot.daemon_version}
          </span>
        </SystemField>
        <SystemField label="Process id">
          <span className="font-mono text-text-primary">
            {snapshot.daemon_pid}
          </span>
        </SystemField>
        <SystemField label="Uptime">
          <span className="text-text-primary">
            {formatUptime(snapshot.uptime_ms)}
          </span>
        </SystemField>
      </dl>
    </HostSection>
  );
}

function SystemField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="w-36 shrink-0 text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd data-host-system-value className="min-w-0 flex-1 text-sm tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/* ─── Offline arms ──────────────────────────────────────────────── */

function OfflineSection({
  status,
}: {
  status: Exclude<HostStatusResponse, { availability: 'available' }>;
}): JSX.Element {
  const view = describeHostStatus(status);
  return (
    <HostSection title="System" muted>
      <Banner tone={view.tone}>
        <span className="font-medium">{view.label}.</span>{' '}
        {view.detail ??
          'Live system facts will appear when the host is back online.'}
      </Banner>
    </HostSection>
  );
}

/* ─── Registered agents ─────────────────────────────────────────── */

function RegisteredAgentsSection({
  agents,
}: {
  agents: AgentOnHostDto[];
}): JSX.Element {
  const nav = useNav();
  // shiki dogfood `DXVl5tEBshVT2LqF` #2: route avatar uploads through
  // the shared object-URL cache so cards show the user-picked image
  // instead of the runtime tint fallback. Memoize the source list so
  // the batch hook's cache key stays stable across renders.
  const avatarSources = useMemo(
    () => agents.map(a => ({ id: a.agent_id, avatar_url: a.avatar_url })),
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
        <p className="text-sm text-text-muted">
          No agents are registered on this computer yet.
        </p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label="Agents on this machine"
        >
          {agents.map(agent => (
            <AgentCard
              key={agent.agent_id}
              agent={agent}
              avatarObjectUrl={avatarUrls.get(agent.agent_id) ?? null}
              onOpen={() => nav.toMembers(agent.agent_id)}
            />
          ))}
        </ul>
      )}
    </HostSection>
  );
}

/* ─── HostSection (local) ───────────────────────────────────────── */

/**
 * Section card used by this surface. Solid `bg-bg-floating` (forza6 +
 * warm both resolve to `#FFFFFF`) so the card reads as a real white
 * tile instead of the half-transparent wash `ProfileSection` uses.
 * Radius is driven by `--floating-radius` (forza6 = 0, warm =
 * `var(--radius-md)`) — `--card-radius` would be 6px in forza6, which
 * fights the theme's hard-cut poster aesthetic. shiki dogfood
 * `aF5e0z_kHXo1Omv7`: "forza6 主题下是 0 才对". Inline radius beats
 * the `[data-panel-card='profile-section']` global rule (CSS
 * specificity 1000 vs ~10), so opting into that hook for border
 * vocabulary does NOT change radius.
 *
 * Border vocabulary mirrors `ProfileSection` per shiki #task:883
 * "border 改成和 agent pane 一样,即默认主题灰,hover 主题黑,
 * forza6 2px": baseline `border-border-subtle` gray, hover transitions
 * to the stronger `border-border` ink; forza6 amplifies that into a
 * 2px structural frame + near-black hover via the
 * `[data-theme='forza6'] [data-panel-card='profile-section']` rule
 * in `themes/forza6-components.css`. Reusing that hook (rather than
 * cloning a `host-section` selector) keeps a single forza6
 * amplification spec for both surfaces.
 *
 * Intentionally NOT reusing the shared `ProfileSection`: shiki dogfood
 * asked for a heavier white treatment here (solid `bg-bg-floating`,
 * not the `/50` half-transparent wash) and we don't want that ripple
 * to other profile cards (`AgentProfileCard` / `HumanProfileCard`)
 * unless asked.
 */
function HostSection({
  title,
  muted = false,
  children,
}: {
  /** ReactNode so the caller can compose inline trailing content
   *  (e.g. an agent count number after the title text). Per shiki
   *  dogfood `6QIZeGVS8u8yJ137`: no right-aligned headerSlot for
   *  this surface — counts read better attached to the title than
   *  floating at the far edge of the card. */
  title: ReactNode;
  muted?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col">
      <header className="mb-2">
        <h3
          className={cn(
            'font-serif text-[13px] font-semibold uppercase tracking-wider',
            muted ? 'text-text-muted' : 'text-text-secondary',
          )}
        >
          {title}
        </h3>
      </header>
      <div
        data-panel-card="profile-section"
        className="border border-border-subtle bg-bg-floating p-4 transition-colors duration-150 hover:border-border"
        style={{ borderRadius: 'var(--floating-radius)' }}
      >
        {children}
      </div>
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
  avatarObjectUrl,
  onOpen,
}: {
  agent: AgentOnHostDto;
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
        className="flex w-full items-center gap-3 rounded-[var(--row-radius)] border-[length:var(--control-border-width)] border-border-subtle bg-bg-floating px-3 py-2.5 text-left transition-colors hover:border-text-primary focus-visible:border-text-primary focus-visible:outline-none"
      >
        {knownRuntime.success ? (
          <AgentAvatar
            runtime={knownRuntime.data as RuntimeKind}
            size={36}
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
        <AgentStatusPip online={agent.online} />
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
function AgentStatusPip({
  online,
}: {
  online: 'online' | 'offline';
}): JSX.Element {
  return (
    <span
      role="status"
      aria-label={online === 'online' ? 'Online' : 'Offline'}
      className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted"
    >
      <span
        data-status-pip
        className={cn(
          'size-1.5 rounded-full',
          online === 'online' ? 'bg-success' : 'bg-text-muted/40',
        )}
        aria-hidden
      />
      {online === 'online' ? 'Online' : 'Offline'}
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

function Banner({
  tone,
  children,
}: {
  tone: HostStatusTone;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        'border bg-bg-floating px-3 py-2 text-sm',
        TONE_BANNER_CLASS[tone],
      )}
      role="status"
    >
      {children}
    </div>
  );
}
