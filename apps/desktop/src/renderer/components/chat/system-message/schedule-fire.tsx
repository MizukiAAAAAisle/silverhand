import { Clock } from "lucide-react";
import { type ScheduleFireMetadata, readScheduleFireMetadata } from "@silverhand/shared";
import { Markdown } from "@/components/chat/Markdown";
import { useRelativeTime } from "@/components/chat/useRelativeTime";
import type { RendererProps } from "./shared";

// ─── schedule_fire wake banner ─────────────────────────────────────────

/**
 * Flat banner for `schedule_fire` system messages — emitted when a
 * scheduled wake fires for an agent. The previous renderer used the
 * generic centered-italic narration, which lost the actionable shape
 * (kind, planned vs actual, missed catch-up, next fire). PR-4 swaps
 * for an inline banner with a left warning accent line, header pills
 * for the spec + timing facts, and the user's reminder text as the
 * body.
 *
 * Renderer chain:
 *  - Full metadata: structured banner with header + pills + body.
 *  - Missing metadata: muted fallback rendering `message.content` as
 *    a single muted block — same banner chrome, no pills, lets old
 *    DB rows still display sensibly.
 */
export function ScheduleFireBanner({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
}: RendererProps): JSX.Element {
  const meta = readScheduleFireMetadata(message.metadata);
  // Body is `meta.body` when producer wrote it (post-PR-4 producer
  // change); legacy rows fall back to `message.content` so older DB
  // wakes still surface their reminder text.
  const bodyMd = meta?.body ?? message.content;
  const headerTitle = meta?.title?.trim() || "Scheduled wake";

  return (
    <div
      className="border-y border-border-subtle border-l-[3px] border-l-warning bg-bg-floating px-4 py-2"
      data-schedule-fire={meta ? "1" : "0"}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
        <Clock aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate" title={headerTitle}>
          {headerTitle}
        </span>
        {meta ? (
          <span className="ml-auto font-mono text-(length:--text-meta) font-normal text-text-muted">
            {meta.spec_summary ?? meta.spec_kind}
          </span>
        ) : null}
      </div>
      {meta ? <ScheduleFirePills meta={meta} /> : null}
      <div className="text-text-primary">
        <Markdown
          content={bodyMd}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
          humansByName={humansByName}
        />
      </div>
    </div>
  );
}

function ScheduleFirePills({ meta }: { meta: ScheduleFireMetadata }): JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      <ScheduleFireFiredPill firedAt={meta.actual_fire_at} />
      {meta.planned_fire_at !== null ? (
        <ScheduleFirePlannedPill plannedAt={meta.planned_fire_at} actualAt={meta.actual_fire_at} />
      ) : null}
      <ScheduleFireMissedPill count={meta.missed_count} />
      {meta.next_fire_at !== null ? <ScheduleFireNextPill nextAt={meta.next_fire_at} /> : null}
    </div>
  );
}

const PILL_BASE =
  "inline-flex items-center gap-1 rounded bg-bg-elevated px-1.5 py-0.5 text-[length:var(--text-meta)] tabular-nums text-text-secondary";

function ScheduleFireFiredPill({ firedAt }: { firedAt: number }): JSX.Element {
  const { relative, absolute } = useRelativeTime(firedAt);
  return (
    <span className={PILL_BASE} title={absolute} data-pill="fired">
      <span className="text-text-muted">fired</span>
      <span>{relative}</span>
    </span>
  );
}

/** "planned 4m ago" / "planned 2s late" — relative to actual fire time.
 *  Negative delta (planned BEFORE actual) means the wake fired late;
 *  positive delta (planned AFTER actual) shouldn't really happen but
 *  display "early" defensively. */
function ScheduleFirePlannedPill({
  plannedAt,
  actualAt,
}: {
  plannedAt: number;
  actualAt: number;
}): JSX.Element {
  const { absolute } = useRelativeTime(plannedAt);
  const deltaMs = actualAt - plannedAt;
  const label = formatScheduleDelta(deltaMs);
  return (
    <span className={PILL_BASE} title={absolute} data-pill="planned">
      <span className="text-text-muted">planned</span>
      <span>{label}</span>
    </span>
  );
}

function ScheduleFireMissedPill({ count }: { count: number }): JSX.Element {
  const cls =
    count === 0 ? PILL_BASE + " text-text-muted" : PILL_BASE + " bg-warning/10 text-warning";
  return (
    <span className={cls} data-pill="missed" data-missed-count={String(count)}>
      <span className="text-text-muted">missed</span>
      <span>{count}</span>
    </span>
  );
}

function ScheduleFireNextPill({ nextAt }: { nextAt: number }): JSX.Element {
  const { relative, absolute } = useRelativeTime(nextAt);
  return (
    <span className={PILL_BASE} title={absolute} data-pill="next">
      <span className="text-text-muted">next</span>
      <span>{relative}</span>
    </span>
  );
}

/** Delta between planned and actual wake. Positive = wake fired
 *  late ("planned 4m ago"); negative = early ("planned in 2s"). */
function formatScheduleDelta(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const SEC = 1_000;
  const MIN = 60 * SEC;
  const HR = 60 * MIN;
  let value: string;
  if (abs < MIN) value = `${Math.round(abs / SEC)}s`;
  else if (abs < HR) value = `${Math.round(abs / MIN)}m`;
  else value = `${Math.round(abs / HR)}h`;
  // "planned <value> ago" if late, "<value> late" reads odd; keep it
  // symmetric with "next in <value>" by using "ago"/"in".
  if (deltaMs > 0) return `${value} ago`;
  if (deltaMs < 0) return `in ${value}`;
  return "on time";
}
