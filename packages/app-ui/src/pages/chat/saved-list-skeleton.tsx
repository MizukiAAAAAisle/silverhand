import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { COLLECTION_CARD_CLASS } from "@/components/layout/collection-item-card";
import { t } from "@/lib/i18n";
export function SavedListSkeleton(): JSX.Element {
  return (
    <Region label={t("chat.loadingSavedMessages")}>
      <div className="space-y-2">
        {[2, 1, 3, 2].map((lines, i) => (
          <div key={i} className={`${COLLECTION_CARD_CLASS} px-4 py-3`}>
            <div className="mb-2 flex min-w-0 items-center gap-2 overflow-hidden">
              <Block className="size-4" />
              <Block className="h-2.5 w-16" />
              <Block className="size-4" />
              <Block className="h-2.5 w-14" />
              <Block className="h-2.5 w-12" />
              <div className="ml-auto size-3.5 shrink-0" />
            </div>
            <div className="space-y-2 py-1">
              {Array.from({ length: lines }, (_, line) => (
                <Block
                  key={line}
                  className={`h-3.5 ${line === lines - 1 ? (i % 2 ? "w-1/2" : "w-2/3") : "w-11/12"}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Region>
  );
}
