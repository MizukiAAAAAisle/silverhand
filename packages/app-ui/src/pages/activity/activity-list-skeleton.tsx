import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { COLLECTION_CARD_CLASS } from "@/components/layout/collection-item-card";
import { t } from "@/lib/i18n";
export function ActivityListSkeleton(): JSX.Element {
  return (
    <Region label={t("activity.loadingActivity")}>
      <div className="space-y-5">
        {[0, 1].map((group) => (
          <section key={group}>
            <div className="px-1 pb-1.5">
              <Block className="h-2.5 w-20" />
            </div>
            <div className="space-y-2">
              {["w-4/5", "w-3/5"].map((width, i) => (
                <div
                  key={width}
                  className={`${COLLECTION_CARD_CLASS} flex items-start gap-3 px-4 py-3`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex gap-1.5 items-center overflow-hidden">
                      <Block className="size-4" />
                      <Block className="h-2.5 w-16" />
                      <Block className="h-2.5 w-20" />
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Block className="size-4" />
                      <Block className={`h-3 ${width}`} />
                    </div>
                    {i === 0 ? <Block className="mt-2 h-3 w-2/3" /> : null}
                  </div>
                  <Block className="h-2.5 w-10" />
                  <div className="size-7 shrink-0 self-center" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Region>
  );
}
