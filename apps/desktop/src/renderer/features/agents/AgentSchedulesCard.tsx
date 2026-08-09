import { useMemo, useState } from 'react';
import {
  Ban,
  CalendarClock,
  Clock,
  RefreshCcw,
  Repeat,
  Zap,
} from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type {
  ScheduleDto,
  ScheduleListStatusFilter,
  ScheduleStatus,
} from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useAgentSchedules, useCancelAgentSchedule } from './hooks';

dayjs.extend(relativeTime);

interface AgentSchedulesCardProps {
  agentId: string;
}

const STATUS_FILTERS: Array<{ value: ScheduleListStatusFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
];

/**
 * User-facing surface for an agent's schedule rows.
 *
 * This card is the primary audit/observability surface for schedules
 * — the agent creates them via the MCP tool but cannot show them to
 * the user except by chatting. The list also doubles as the recovery
 * path when a fire is mis-rendered in the wake DM (see task #184):
 * even if the user misses the system message, the row here still
 * shows `fired_count` and the last status, which is why we keep both
 * audit counters visible even after switching from the old <table>.
 *
 * Cancel is the only mutation; creation is intentionally agent-only
 * to preserve the "agent owns its own wake plans" semantic.
 *
 * Layout: each schedule is a `ScheduleItem` card (kind icon chip +
 * message + meta strip + cancel/disclosure). Replaces the previous
 * 6-column <table>; the new shape leads with the message (the
 * user-meaningful field) and tucks counters/cron-spec into a muted
 * meta row underneath. PR-3 (#task:396).
 */
export function AgentSchedulesCard({ agentId }: AgentSchedulesCardProps): JSX.Element {
  const [filter, setFilter] = useState<ScheduleListStatusFilter>('active');
  const query = useAgentSchedules(agentId, filter);
  const cancel = useCancelAgentSchedule(agentId);

  const rows = useMemo(() => query.data ?? [], [query.data]);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: filter + refresh, left-aligned. The "Self-scheduled wakes…"
          description was dropped (shiki) — the card's read-only/cancel-only
          nature is conveyed by the rows themselves, not a caption. */}
      <header className="flex items-stretch gap-1">
        <FilterTabs value={filter} onChange={setFilter} />
        <button
          type="button"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          data-panel-control="row-action"
          className="inline-flex min-w-7 items-center justify-center px-1.5 text-[length:var(--text-meta)] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          aria-label="Refresh schedules"
          title="Refresh"
        >
          <RefreshCcw
            className={`size-3 ${query.isFetching ? 'animate-spin' : ''}`}
          />
        </button>
      </header>

      {query.isError ? (
        <div
          data-panel-card="placeholder"
          className="border border-dashed border-error/40 bg-error/5 px-3 py-2 text-xs text-error"
        >
          Failed to load schedules.
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div
          data-panel-card="placeholder"
          className="border border-dashed border-border-subtle px-4 py-6 text-center text-xs text-text-muted"
        >
          {filter === 'active'
            ? 'No active schedules.'
            : `No schedules with status ${filter}.`}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(row => (
            <ScheduleItem
              key={row.id}
              row={row}
              cancelling={cancel.isPending && cancel.variables === row.id}
              onCancel={() => cancel.mutate(row.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScheduleItem({
  row,
  cancelling,
  onCancel,
}: {
  row: ScheduleDto;
  cancelling: boolean;
  onCancel: () => void;
}): JSX.Element {
  const cancellable = row.status === 'pending' || row.status === 'firing';
  // `next_fire_at` is only meaningful while the row is still live. For
  // any terminal status the stored value is stale (e.g. a failed row
  // would otherwise keep saying "in 3 minutes" forever), so collapse
  // the countdown to em-dash and skip the ISO tooltip.
  const hasFutureFire = row.status === 'pending' || row.status === 'firing';
  const terminal = !cancellable;
  return (
    <li
      data-panel-card="row"
      className={cn(
        // Hover affordance: subtle bg lift + border deepens
        // (`border-border-subtle` → `border-border`). Forza6 amplifies
        // border-color into ink-black + lime fill via its component
        // overrides; warm reads soft. #task:815.
        //
        // `items-center` (back from #task:819's `items-start`) — the
        // leading 36×36 colored tile is back per shiki
        // `qEeVCDus06asyQ0g` (#task:820: '保留刚才左侧的大 icon,很有
        // 标识,视觉上比较好看'); the tile anchors vertical centering
        // against the multi-line title + meta block, which reads
        // better than top-aligned when the message line is present.
        //
        // Padding uniform `p-4` (16px all sides) — was `px-4 py-3`.
        // shiki `hcRK6I54LXuO_DsF` (#task:823): '上下距离左侧是一致
        // 的,这样比较协调'. Combined with the size-14 tile bump below,
        // the tile now sits 16px from row top + 16px from row left in
        // 1-/2-line rows, ~17.5px in 3-line rows (visually identical
        // to the eye).
        'flex items-center gap-3 border border-border-subtle bg-bg-floating/50 p-4 transition-colors hover:border-border hover:bg-bg-hover/60',
        terminal ? 'opacity-70' : '',
      )}
    >
      <KindTile kind={row.spec.kind} />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-medium text-text-primary"
          title={row.title}
        >
          {row.title}
        </div>
        {row.message && row.message !== row.title ? (
          <div className="mt-0.5 truncate text-xs text-text-secondary" title={row.message}>
            {row.message}
          </div>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-meta)] text-text-muted">
          <span
            className="font-medium text-text-secondary"
            title={hasFutureFire ? dayjs(row.next_fire_at).toISOString() : undefined}
          >
            {hasFutureFire ? dayjs(row.next_fire_at).fromNow() : '—'}
          </span>
          <StatusPill status={row.status} />
          {/* Kind sits right before the spec chip so a cron row reads
              `<STATUS> <CRON> <0 10 * * 0>` as one phrase, and an
              interval row reads `<STATUS> <INTERVAL> <every 60s>`.
              For `once` rows there is no spec chip — KindPill stands
              alone after status. shiki `BMy4atSPWcXT7ROe` (#task:821):
              "kind 也放在 status 后面,这样 kind 可以跟后面的 corn 表达式连在一起". */}
          <KindPill kind={row.spec.kind} />
          <SpecPill row={row} />
          <FireCounter row={row} />
          {/* Schedule's execution target — the conversation whose
           *  (conversation, owner_agent) runtime wakes up on each fire
           *  AND posts the result. `target_label` is server-projected
           *  under schedule's own ACL (see ScheduleDto.target_label):
           *  '#name' / '@name' / 'Unavailable conversation'. We never
           *  call /conversations/:id/ref from
           *  here — schedule list is the single auth boundary, and
           *  fan-out lookups would mix two ACL models. The full id is
           *  retained as the tooltip for audit. */}
          <TargetPill
            label={row.target_label}
            conversationId={row.target_conversation_id}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {cancellable ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            data-panel-control="row-action"
            // shiki dogfood `D9XCCVkvU9BKyuYv` + Cindy `o9ftBW6a6EZanfhV`:
            // Cancel here is a low-frequency secondary row action, NOT a
            // destructive-confirm CTA. Drop the prior `bg-bg-hover` block
            // and `text-error` ink (read as "danger button" on the
            // forza6 lime-pale row); use `hover:text-text-primary` so
            // the affordance just darkens on focus.
            //
            // shiki `C9lczSyh1hw2eiq3`: drop the visible "Cancel" text
            // — keep only the glyph for a tighter row tail.
            //
            // Cindy `DSypcmTxOyvTpu5q` (P1): when the visible label
            // disappears, fix the hit target with a square `h-7 w-7`
            // shell (= 28×28, same size as the Hero Refresh button) so
            // the click target doesn't shrink with the glyph. Drop
            // `px/py` — sizing comes from `h/w` only — and add the
            // canonical `focus-outline` so keyboard focus stays visible
            // without a text label as fallback.
            //
            // shiki `tYICT4j_RcEqDmZV`: glyph swapped from `<X />` to
            // `<Ban />` — `X` reads as "close this view" (the universal
            // close-button glyph), but here the action is "cancel this
            // schedule", a different verb. `Ban` (lucide's circle-with-
            // slash) is the universal cancel/forbid glyph, distinct
            // from both close (X) and destruction (Trash). `aria-label`
            // carries the action verb for screen readers; `title` for
            // sighted hover.
            //
            // shiki `fBnECgMgvIAsoNgn`: ink-only hover wasn't loud
            // enough — pair it with a `hover:scale-110` kinetic cue so
            // the affordance reads as "yes this is a button" before the
            // user reads the glyph. `transition-all duration-150` so
            // both color and transform tween smoothly. Scaling the
            // shell (not just the glyph) keeps the visual center
            // fixed; 10% on a 28×28 target is ~3px out per side, no
            // row reflow because the shell is `shrink-0` inside a
            // flex row with implicit overflow tolerance.
            className="inline-flex h-7 w-7 items-center justify-center text-text-muted transition-all duration-150 hover:scale-110 hover:text-text-primary focus-outline disabled:opacity-50 disabled:hover:scale-100"
            aria-label="Cancel schedule"
            title="Cancel"
          >
            <Ban className="size-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Solid coloured 56×56 leading tile carrying the kind glyph — the
 *  row's primary visual landmark. shiki `qEeVCDus06asyQ0g` (#task:820)
 *  asked to bring this back after #task:819 swapped it for an inline
 *  muted icon: '保留刚才左侧的大 icon,很有标识,视觉上比较好看'. With
 *  the meta-strip <KindPill> now also carrying kind in text, the kind
 *  is double-encoded — the tile is the at-a-glance landmark, the pill
 *  is the literal label.
 *
 *  Tile size-14 / icon size-8 / row `p-4` per shiki `hcRK6I54LXuO_DsF`
 *  (#task:823): '上下距离左侧是一致的,这样比较协调'. The 56px tile
 *  ≈ a typical 3-line row's content height (title 14 + msg 12 + meta
 *  11 ≈ 56-60px including line gaps), so the tile sits ~16px from
 *  the row's top/bottom edges, matching the 16px left inset.
 *
 *  Three-token palette using saturated semantic surfaces (`bg-accent` /
 *  `bg-success` / `bg-warning` paired with their on-color foregrounds)
 *  so the tile reads as a deliberate festival landmark rather than a
 *  washed-out background tint — `*-soft` would look dull next to
 *  forza6's brand-saturated chrome. We deliberately avoid `--accent-2`:
 *  the other themes alias it to `--accent`, which would collapse to the
 *  once color and lose discriminability. */
function KindTile({
  kind,
}: {
  kind: ScheduleDto['spec']['kind'];
}): JSX.Element {
  const cls =
    kind === 'once'
      ? 'bg-accent text-text-on-accent'
      : kind === 'interval'
        ? 'bg-success text-text-on-success'
        : 'bg-warning text-text-on-warning';
  const Icon =
    kind === 'once'
      ? Clock
      : kind === 'interval'
        ? Repeat
        : CalendarClock;
  return (
    <span
      data-panel-pill="kind-tile"
      className={cn(
        // Tile size-14 (56px) ≈ typical 3-line row content height,
        // so combined with the row's symmetric `p-4` (16px) the tile
        // sits ~16px from the row's top/bottom AND left edges. shiki
        // `hcRK6I54LXuO_DsF` (#task:823): '上下距离左侧是一致的,
        // 这样比较协调'. size-9 (36px) was visibly inset more than
        // 16px from top/bottom in 3-line rows because content
        // overflowed the tile and items-center pushed it down.
        'grid size-14 shrink-0 place-items-center',
        cls,
      )}
      title={kind}
      aria-hidden="true"
    >
      <Icon className="size-8" />
    </span>
  );
}

/** Text-form kind label sharing StatusPill's geometry vocabulary
 *  (caps + tracking + saturated tile). Lives in the meta strip
 *  immediately before SpecPill so the row reads
 *  `<TIME> <STATUS> <KIND> <SPEC> <FIRES> <TARGET>` — kind glues to its
 *  spec chip (CRON + cron-expression / INTERVAL + every-Ns), keeping
 *  type and value as one phrase. The colour palette mirrors the
 *  KindTile mapping (once=accent, interval=success, cron=warning) so
 *  the leading tile and the pill stay color-keyed. The tile is the
 *  landmark; this pill is the literal label. */
function KindPill({
  kind,
}: {
  kind: ScheduleDto['spec']['kind'];
}): JSX.Element {
  const cls =
    kind === 'once'
      ? 'bg-accent text-text-on-accent'
      : kind === 'interval'
        ? 'bg-success text-text-on-success'
        : 'bg-warning text-text-on-warning';
  return (
    <span
      data-panel-pill="kind"
      className={cn(
        'inline-flex items-center px-2 py-0.5 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider',
        cls,
      )}
      aria-label={`${kind} schedule`}
    >
      {kind}
    </span>
  );
}

/**
 * Schedule-spec pill (#task:816). The expression is the unique
 * identifier of when the row fires; previously rendered as inline mono
 * text indistinguishable from the surrounding meta strip ("普通文字，
 * 辨识度太低"). Now wraps the spec value in a colored chip — the
 * background colour matches the row's kind (cron→warning,
 * interval→success), so KindPill + SpecPill read as one
 * type-and-value unit (#task:822, shiki `LI8UlqKBuXtWw_gm`):
 *   "cron 表达式 tag 颜色和 cron kind 一致... 一看就知道他俩是一起的语义".
 *
 * Layout per kind:
 *   - cron     → `<expression>  <timezone>`   (timezone reads as
 *                                              localization context, not
 *                                              the identifier — kept
 *                                              outside the chip)
 *   - interval → `every <N>s`
 *   - once     → null (the colored KindTile + KindPill already convey
 *                "once"; rendering a spec chip would just be noise.)
 *
 * Geometry mirrors StatusPill / KindPill (`px-2 py-0.5 text-[length:var(--text-badge)]`
 * → 14px box) but uses mono font (cron expressions / 'every Ns' are
 * code-island content; sans + caps would mangle '0 10 * * 0'). The
 * forza6 generic pill rule's display-caps treatment is suppressed by
 * a scoped `[data-panel-pill='schedule-spec']` override in
 * forza6-components.css that resets font-family/letter-spacing/weight
 * back to mono — the override no longer touches background or border
 * since the kind-keyed JSX class is now the single source of color.
 *
 * Kept here (not in a shared primitives file) because the chip's
 * visual + layout + semantics are tied to the schedule meta strip;
 * a generic "code chip" would lose the per-kind branching.
 */
function SpecPill({ row }: { row: ScheduleDto }): JSX.Element | null {
  const spec = row.spec;
  if (spec.kind === 'once') return null;
  // Kind-keyed background: same palette as KindTile / KindPill so the
  // three elements on a cron row (tile + pill + spec) all read as one
  // saturated colour family. `bg-warning` for cron, `bg-success` for
  // interval — mirroring KindPill's mapping exactly.
  const cls =
    spec.kind === 'interval'
      ? 'bg-success text-text-on-success'
      : 'bg-warning text-text-on-warning';
  if (spec.kind === 'interval') {
    return (
      <span
        data-panel-pill="schedule-spec"
        className={cn(
          'inline-flex items-center px-2 py-0.5 font-mono text-[length:var(--text-badge)]',
          cls,
        )}
        title={`every ${spec.every_seconds} seconds`}
      >
        every {spec.every_seconds}s
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        data-panel-pill="schedule-spec"
        className={cn(
          'inline-flex items-center px-2 py-0.5 font-mono text-[length:var(--text-badge)]',
          cls,
        )}
        title={`cron expression — ${spec.expression}`}
      >
        {spec.expression}
      </span>
      <span className="text-text-muted" title={`timezone — ${spec.timezone}`}>
        {spec.timezone}
      </span>
    </span>
  );
}

/**
 * Schedule-target pill (#task:816). `target_label` is one of:
 *   `#name` (channel) · `@name` (DM) · `Unavailable conversation`
 *   (deleted target).
 *
 * Rendered as `→ [<label>]` — the arrow stays as a connector glyph in
 * the muted meta-strip color, the label sits in a code-island chip so
 * it scans as a navigation target instead of a plain word in a
 * sentence. The `#`/`@` prefix in the label already carries the kind
 * semantic; we don't add a separate glyph (`Hash` / `At`) inside the
 * chip because target_label can be the literal "Unavailable
 * conversation" sentence — a single glyph would lie about that case.
 *
 * The full conversation id stays as the tooltip for audit (you can
 * grep logs for it).
 */
function TargetPill({
  label,
  conversationId,
}: {
  label: string;
  conversationId: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-text-muted">
      <span aria-hidden="true">→</span>
      <span
        data-panel-pill="schedule-target"
        // Height matches StatusPill — see SpecPill height-alignment
        // rationale. shiki `iGfKfOatgeYZWCgS` (#task:818).
        className="inline-flex items-center border border-border-subtle bg-bg-surface px-2 py-px font-mono text-[length:var(--text-badge)] text-text-primary"
        title={`Fires in conversation ${conversationId}`}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * Audit/recovery counter for the meta strip. `max_occurrences` is a
 * repeat-only field in the persisted DTO — `ScheduleSpecOnceSchema`
 * has no `max_occurrences`, and `ScheduleCreateInputSchema` actively
 * rejects `max_occurrences` on a `once` row (dto.ts:1584). So a `null`
 * on a once row means "not applicable" (the row can only fire once by
 * definition), NOT "unlimited" — Cindy's PR-3 review finding. Repeat
 * rows still get `∞` when there's no cap.
 *
 * Exported for the regression test that locks this distinction; not
 * part of the public component API. Used by `<FireCounter>` as the
 * audit tooltip — the on-screen rendering uses a compact icon-led
 * form (#task:817).
 */
export function formatFiredCount(row: ScheduleDto): string {
  const fired = row.fired_count;
  if (row.spec.kind === 'once') {
    // A `once` row's capacity is always 1, even when the DTO leaves
    // `max_occurrences` null.
    return `${fired} / 1 fired`;
  }
  if (row.max_occurrences != null) {
    return `${fired} / ${row.max_occurrences} fired`;
  }
  return `${fired} / ∞ fired`;
}

/**
 * Visual fire-count counter (#task:817). Replaces the prior
 * `1 / ∞ fired` plain-text span — shiki: '像是文字报告，不像是一个产品
 * 表达'. Now reads as a compact iconographic counter (Lucide `Zap` =
 * trigger semantic + numeric counter), with the verbose
 * "<n> / <cap> fired" form preserved as the audit tooltip via
 * `formatFiredCount`. Display rules:
 *
 *   once               → `⚡ <n>/1`   (cap is implicit; the `/1`
 *                                       distinguishes 0 vs 1 at a glance)
 *   repeat capped      → `⚡ <n>/<max>`
 *   repeat uncapped    → `⚡ <n>`     (no `/∞` — the absence of a slash
 *                                       carries 'no cap' visually,
 *                                       eliminates the report-y infinity
 *                                       symbol)
 */
function FireCounter({ row }: { row: ScheduleDto }): JSX.Element {
  const cap =
    row.spec.kind === 'once'
      ? 1
      : row.max_occurrences != null
        ? row.max_occurrences
        : null;
  return (
    <span
      className="inline-flex items-center gap-1 text-text-secondary"
      title={formatFiredCount(row)}
    >
      <Zap className="size-3 text-text-muted" aria-hidden="true" />
      <span className="font-mono text-[length:var(--text-meta)]">
        {cap !== null ? `${row.fired_count}/${cap}` : row.fired_count}
      </span>
    </span>
  );
}

function StatusPill({ status }: { status: ScheduleStatus }): JSX.Element {
  // Maps the persisted `ScheduleStatus` enum to a solid saturated
  // surface + on-color foreground (festival-tile recipe). `*-soft`
  // washes looked dull next to forza6's brand chrome — solid tiles
  // read as deliberate state markers in every theme.
  const cls =
    status === 'pending'
      ? 'bg-success text-text-on-success'
      : status === 'firing'
        ? 'bg-accent text-text-on-accent'
        : status === 'done'
          ? 'bg-bg-surface text-text-muted'
          : status === 'cancelled'
            ? 'bg-bg-surface text-text-secondary'
            : 'bg-error text-text-on-error'; // failed
  return (
    <span
      data-panel-pill="status"
      className={cn(
        'inline-flex items-center px-2 py-0.5 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider',
        cls,
      )}
    >
      {status}
    </span>
  );
}

function FilterTabs({
  value,
  onChange,
}: {
  value: ScheduleListStatusFilter;
  onChange: (next: ScheduleListStatusFilter) => void;
}): JSX.Element {
  return (
    <div
      data-panel-tabs
      className="flex shrink-0 items-center border border-border-subtle bg-bg-base p-0.5"
    >
      {STATUS_FILTERS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-2 py-0.5 text-[length:var(--text-meta)] transition-colors',
            opt.value === value
              ? 'bg-accent-2 text-text-on-accent-2'
              : 'text-text-muted hover:text-text-primary',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
