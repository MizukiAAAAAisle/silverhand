import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { t } from "@/lib/i18n";
export function ChannelSettingsSkeleton(): JSX.Element {
  return (
    <Region label={t("conversationShell.loadingChannelSettings")} className="p-4">
      <div className="space-y-8">
        <section>
          <h3 className="mb-3 text-xs font-semibold text-text-muted">
            {t("conversationShell.members")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Block key={i} className="size-6" />
            ))}
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-text-muted">{t("conversationShell.info")}</h3>
          <Block className="h-3 w-1/3" />
          <Block className="h-3 w-full" />
          <Block className="h-3 w-2/3" />
        </section>
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-text-muted">
            {t("conversationShell.notifications")}
          </h3>
          <Block className="h-3 w-3/5" />
        </section>
      </div>
    </Region>
  );
}
