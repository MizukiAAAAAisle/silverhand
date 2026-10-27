import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { COLLECTION_CARD_CLASS } from "@/components/layout/collection-item-card";
import { AGENT_PANE_INSET } from "../model/agent-pane-layout";
import { t } from "@/lib/i18n";

export function AgentChatsSkeleton(): JSX.Element {
  return (
    <Region label={t("agents.loadingChats")} className={AGENT_PANE_INSET}>
      {[0, 1].map((group) => (
        <div key={group} className="mb-5">
          <Block className="mb-2 h-3 w-28" />
          <div className="space-y-2">
            {["w-3/5", "w-2/5"].map((width) => (
              <div
                key={width}
                className={`${COLLECTION_CARD_CLASS} flex items-center gap-3 px-3 py-2.5`}
              >
                <Block className="size-8" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Block className={`h-3.5 ${width}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Region>
  );
}

export function AgentActivitySkeleton(): JSX.Element {
  return (
    <Region label={t("agents.loadingActivity")}>
      <div className="space-y-4">
        {["w-3/4", "w-1/2", "w-2/3", "w-4/5", "w-3/5"].map((width, i) => (
          <div key={width} className="flex gap-2 py-1">
            <Block className="size-3.5" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex gap-3">
                <Block className={`h-3 ${width}`} />
                <Block className="ml-auto h-2 w-10" />
              </div>
              {i % 2 === 0 ? (
                <div className="space-y-2 border-l border-border-subtle pl-3 py-2">
                  <Block className="h-2.5 w-4/5" />
                  <Block className="h-2.5 w-3/5" />
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </Region>
  );
}

export function SchedulesSkeleton(): JSX.Element {
  return (
    <Region label={t("agents.loadingSchedules")}>
      <div className="agent-schedules flex flex-col gap-2">
        {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
          <div key={width} className="schedule-card border border-border-subtle bg-bg-floating/50">
            <Block className={`schedule-title h-3.5 ${width}`} />
            <div className="schedule-cancel size-7" />
            <div className="schedule-metadata py-1">
              <Block className="h-2.5 w-16" />
              <Block className="h-2.5 w-24" />
              <Block className="h-2.5 w-20" />
            </div>
          </div>
        ))}
      </div>
    </Region>
  );
}

export function McpSkeleton(): JSX.Element {
  return (
    <Region label={t("agents.loadingMcpServers")} className="mx-auto w-full max-w-3xl">
      <h2 className="font-serif text-lg font-semibold text-text-primary">
        {t("agents.profileMcp")}
      </h2>
      <Block className="mt-2 mb-6 h-3 w-2/3" />
      <h3 className="mb-3 text-xs font-semibold text-text-muted">{t("agents.servers")}</h3>
      <div className="space-y-3">
        {["w-28", "w-36", "w-24"].map((width) => (
          <div
            key={width}
            className="space-y-3 border border-border-subtle rounded-(--control-radius) p-3"
          >
            <div className="flex items-center gap-2">
              <Block className="size-4" />
              <Block className={`h-3 ${width}`} />
            </div>
            <Block className="h-2.5 w-4/5" />
            <Block className="h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </Region>
  );
}

export function FileTreeSkeleton(): JSX.Element {
  return (
    <Region label={t("agents.loadingWorkspaceFiles")}>
      <div className="py-1">
        {[0, 1, 1, 2, 0, 1, 1, 0].map((depth, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 py-1.5 pr-3"
            style={{ paddingLeft: 12 + depth * 16 }}
          >
            <Block className="size-3.5" />
            <Block className={`h-2.5 ${i % 2 ? "w-20" : "w-28"}`} />
          </div>
        ))}
      </div>
    </Region>
  );
}
