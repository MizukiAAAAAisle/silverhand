import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { COLLECTION_CARD_CLASS } from "@/components/layout/collection-item-card";
export function SearchResultsSkeleton(): JSX.Element {
  return (
    <Region label="Loading search results">
      <div className="space-y-5">
        {[0, 1].map((group) => (
          <section key={group}>
            <div className="mb-2 flex items-center gap-2 px-1">
              <Block className="size-3" />
              <Block className="h-2.5 w-20" />
            </div>
            <div className="space-y-2">
              {["w-2/3", "w-1/2", "w-3/5"].slice(0, group ? 3 : 2).map((width) => (
                <div
                  key={width}
                  className={`${COLLECTION_CARD_CLASS} flex min-w-0 items-center gap-3 px-3 py-2.5`}
                >
                  <div data-search-item-icon className="hidden size-8 shrink-0">
                    <Block className="size-full" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex gap-2">
                      <Block className="h-2.5 w-16" />
                      <Block className="h-2.5 w-12" />
                    </div>
                    <Block className={`h-3.5 ${width}`} />
                    {group ? <Block className="h-3 w-4/5" /> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Region>
  );
}
