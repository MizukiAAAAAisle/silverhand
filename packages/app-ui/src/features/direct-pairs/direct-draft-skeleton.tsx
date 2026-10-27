import { SkeletonBlock, SkeletonRegion } from "@/components/layout/skeleton";
import { t } from "@/lib/i18n";

/** No message placeholders: a first-message draft does not have history. */
export function DirectDraftSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label={t("directPairs.loadingConversation")} className="flex-1">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <SkeletonBlock className="size-6" />
        <SkeletonBlock className="h-3 w-28" />
      </div>
    </SkeletonRegion>
  );
}
