import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { t } from "@/lib/i18n";
export function TaskBodySkeleton(): JSX.Element {
  return (
    <Region label={t("tasks.loadingTask")}>
      <div className="border-b border-border-subtle px-5 py-4 space-y-3">
        <Block className="h-2.5 w-16" />
        <Block className="h-5 w-3/5" />
      </div>
      <div className="flex min-w-0">
        <div className="min-w-0 flex-1 px-5 py-4 space-y-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Block className="h-3 w-full" />
              <Block className="h-3 w-4/5" />
              <Block className="h-3 w-2/3" />
            </div>
          ))}
        </div>
        <div className="w-60 shrink-0 border-l border-border-subtle p-4 space-y-5">
          {[t("tasks.status"), t("tasks.assignee"), t("tasks.created")].map((label) => (
            <div key={label} className="space-y-2">
              <span className="text-xs text-text-muted">{label}</span>
              <Block className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </Region>
  );
}

export function TaskCardsSkeleton(): JSX.Element {
  return (
    <Region label={t("tasks.loadingTasks")}>
      <div className="space-y-1.5">
        {["w-4/5", "w-3/5", "w-2/3"].map((width) => (
          <div
            key={width}
            className="rounded-(--card-radius) border border-border-subtle p-2 space-y-2"
          >
            <div className="flex items-center justify-between">
              <Block className="h-2 w-10" />
              <Block className="h-3 w-14" />
            </div>
            <Block className={`h-3 ${width}`} />
            <div className="flex items-center gap-2 pt-1">
              <Block className="size-4" />
              <Block className="h-2 w-16" />
              <Block className="ml-auto h-2 w-10" />
            </div>
          </div>
        ))}
      </div>
    </Region>
  );
}
