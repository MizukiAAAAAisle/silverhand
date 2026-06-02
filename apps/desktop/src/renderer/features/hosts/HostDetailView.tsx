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
 * Forward-compat: NO `host.kind === 'local'` branching. shiki: "功能应是
 * hosts 主语的通用功能, 不是 local only" — every screen here renders
 * against generic `HostDto` + `HostStatusResponse`, so dropping in a
 * remote host requires zero diff here.
 *
 * Manual-refresh contract: `useHostStatusQuery` pins
 * `staleTime: Infinity` + no focus/interval refetch. The Refresh button
 * invalidates the query key on click.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Cpu, Globe, Loader2, Monitor, RefreshCw } from 'lucide-react';
import { useMemo, type JSX, type ReactNode } from 'react';
import type {
  AgentOnHostDto,
  HostDto,
  HostStatusResponse,
  RuntimeKind,
} from '@silverhand/shared';
import { RuntimeKindSchema } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useNav } from '@/router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  hostStatusKey,
  useHostStatusQuery,
  useUpdateHostMutation,
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

export interface HostDetailViewProps {
  host: HostDto;
}

export function HostDetailView({ host }: HostDetailViewProps): JSX.Element {
  const qc = useQueryClient();
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
            <RegisteredAgentsSection agents={statusQuery.data.agents} />
          </>
        ) : null}
      </div>
    </main>
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
        {/* shiki dogfood `hLEODapuI_dHuCPz` / `z5DyAzlG34Rto52-`: state
            row in the MIDDLE between title and meta; Ready chip + Refresh
            both `h-7` (28px) — chip drove down to a tighter HUD size and
            Refresh follows, not the other way around. */}
        <div className="flex items-center gap-2">
          {statusLabel && statusTone ? (
            <StatusChip label={statusLabel} tone={statusTone} />
          ) : statusLoading ? (
            <span className="inline-flex h-7 items-center gap-1 text-xs text-text-muted">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              <span>Loading…</span>
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            // Override the default `size="icon"` (h-8 w-8) to match
            // the tighter `h-7` chip — shiki dogfood
            // `z5DyAzlG34Rto52-` wants the strip shorter, not the
            // chip taller.
            className="h-7 w-7"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh host status"
            title="Refresh"
          >
            <RefreshCw
              className={cn('size-3.5', refreshing && 'animate-spin')}
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
      className="inline-flex size-20 shrink-0 items-center justify-center rounded-none bg-bg-elevated text-text-secondary"
      aria-hidden
    >
      <Icon className="size-9" />
    </span>
  );
}

/**
 * Lightweight status indicator — see the `TONE_DOT_CLASS` comment.
 * Height `h-7` keeps it on the same baseline as the adjacent ghost
 * Refresh button without forcing a filled tile.
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
      className="inline-flex h-7 items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary"
    >
      {/* shiki dogfood `DXVl5tEBshVT2LqF` #3: bump from `size-1.5` (6px)
          to `size-2.5` (10px) so the tone signal is legible at a glance
          in the Hero row — the prior pinhead read as decoration, not
          status. Keep `AgentStatusPip` smaller; per-agent rows live in
          a denser stack and a 10px dot there would shout. */}
      <span
        className={cn('size-2.5 rounded-full', TONE_DOT_CLASS[tone])}
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
          key-value list, not a stretched form. */}
      <dl className="flex flex-col gap-2.5">
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
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
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
 * `aF5e0z_kHXo1Omv7`: "forza6 主题下是 0 才对".
 * Border is the light subtle stroke; forza6's poster-frame treatment
 * is reserved for `row` cards.
 *
 * Intentionally NOT reusing the shared `ProfileSection`: shiki dogfood
 * asked for a heavier white treatment here and we don't want that ripple
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
        className="border border-border-subtle/60 bg-bg-floating p-4"
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
        className="flex w-full items-center gap-3 border-[length:var(--control-border-width)] border-border-subtle bg-bg-floating px-3 py-2.5 text-left transition-colors hover:border-text-primary focus-visible:border-text-primary focus-visible:outline-none"
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
