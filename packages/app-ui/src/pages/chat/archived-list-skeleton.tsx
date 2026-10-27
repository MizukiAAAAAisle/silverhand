import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { COLLECTION_CARD_CLASS } from "@/components/layout/collection-item-card";
import { t } from "@/lib/i18n";
export function ArchivedListSkeleton(): JSX.Element {
  return (
    <Region label={t("chat.loadingArchivedChannels")}>
      <h2 className="px-1 pb-2 text-(length:--text-meta) font-medium uppercase tracking-wider text-text-secondary">
        {t("chat.channels")}
      </h2>
      <div className="space-y-2">
        {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
          <div key={width} className={`${COLLECTION_CARD_CLASS} flex min-w-0 items-stretch`}>
            <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3">
              <Block className="size-8" />
              <div className="min-w-0 flex-1 space-y-2">
                <Block className="h-2.5 w-20" />
                <Block className={`h-3.5 ${width}`} />
                <div className="flex gap-2">
                  <Block className="h-2.5 w-16" />
                  <Block className="h-2.5 w-20" />
                </div>
              </div>
            </div>
            <div className="m-3 ml-0 w-20 shrink-0" />
          </div>
        ))}
      </div>
    </Region>
  );
}
