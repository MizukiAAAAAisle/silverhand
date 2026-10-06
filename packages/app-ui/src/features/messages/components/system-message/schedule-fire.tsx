import { AlarmIcon } from "@/icons";
import { readScheduleFireMetadata } from "@silverhand/shared";
import { useRelativeTime } from "@/features/messages/hooks/use-relative-time";
import type { RendererProps } from "./shared";

export function ScheduleFireRow({ message }: RendererProps): JSX.Element {
  const meta = readScheduleFireMetadata(message.metadata);
  const title = meta?.title?.trim() || "Scheduled wake";
  const firedAt = meta?.actual_fire_at ?? message.created_at;
  const { absolute } = useRelativeTime(firedAt);
  const time = new Date(firedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className="px-4 py-3 text-center text-xs leading-5 text-text-secondary"
      data-schedule-fire={meta ? "1" : "0"}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        <AlarmIcon aria-hidden className="size-4 shrink-0 text-success" />
        <span className="min-w-0 wrap-anywhere font-semibold text-text-primary">{title}</span>
        <span>triggered</span>
        <time
          className="text-(length:--text-meta) tabular-nums"
          dateTime={new Date(firedAt).toISOString()}
          title={absolute}
        >
          {time}
        </time>
      </div>
      {meta && meta.missed_count > 0 ? (
        <div className="mt-0.5 text-(length:--text-meta) text-warning">
          Skipped {meta.missed_count} {meta.missed_count === 1 ? "occurrence" : "occurrences"}
        </div>
      ) : null}
    </div>
  );
}
