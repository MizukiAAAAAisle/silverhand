import { AVATAR_PX } from "@/components/avatar-scale";
import { COLLECTION_CARD_CLASS } from "@/components/layout/collection-item-card";
import { SkeletonBlock, SkeletonRegion } from "@/components/layout/skeleton";

/** Root preview and reply footer mirror ThreadRow, without interactive card hooks. */
export function ThreadsSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label="Loading threads">
      <div className="flex flex-col gap-1.5">
        {["w-4/5", "w-3/5", "w-2/3", "w-3/4"].map((width, index) => (
          <div key={width} className={`${COLLECTION_CARD_CLASS} overflow-hidden`}>
            <div className="flex items-start gap-2 px-2.5 py-2">
              <SkeletonBlock className="mt-px size-5" />
              <div className="min-w-0 flex-1 space-y-2 py-1">
                <SkeletonBlock className="h-3 w-full" />
                {index !== 1 ? <SkeletonBlock className={`h-3 ${width}`} /> : null}
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5">
              <div className="flex gap-0.75">
                <SkeletonBlock className="size-4.5" />
                <SkeletonBlock className="size-4.5" />
              </div>
              <SkeletonBlock className="h-2.5 w-12" />
              <SkeletonBlock className="ml-auto h-2.5 w-14" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Date groups, 32px thumbnails and bylines match the attachment surface. */
export function AttachmentsSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label="Loading attachments">
      {[0, 1].map((group) => (
        <div key={group}>
          <div className="pb-1 pt-2">
            <SkeletonBlock className="my-1 h-2.5 w-20" />
          </div>
          {["w-3/4", "w-1/2", "w-2/3"].slice(0, group ? 2 : 3).map((width) => (
            <div key={width} className="py-0.75">
              <div
                className={`${COLLECTION_CARD_CLASS} flex items-center gap-1.5 overflow-hidden px-4 py-3`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <SkeletonBlock className="size-8" />
                  <div data-attachment-row-body className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <SkeletonBlock className={`h-3.5 ${width}`} />
                    <div className="flex min-w-0 items-center gap-2">
                      <SkeletonBlock className="size-4" />
                      <SkeletonBlock className="h-2.5 w-12" />
                      <SkeletonBlock className="h-2.5 w-8" />
                      <SkeletonBlock className="h-2.5 w-16" />
                    </div>
                  </div>
                </div>
                <div className="w-15.5 shrink-0" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Members use a single name/handle line and retain the real responsive groups. */
export function MembersSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label="Loading members">
      <div data-members-groups>
        {[0, 1].map((group) => (
          <div key={group}>
            <div className="px-1.5 pb-1 pt-2.5">
              <SkeletonBlock className="my-1 h-2 w-14" />
            </div>
            {["w-20", "w-16", "w-24", "w-14"].slice(0, group ? 4 : 2).map((width) => (
              <div key={width} className="flex min-h-8.5 items-center gap-2.5 px-1.5 py-1">
                <div style={{ width: AVATAR_PX.sm, height: AVATAR_PX.sm }} className="shrink-0">
                  <SkeletonBlock className="size-full" />
                </div>
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                  <SkeletonBlock className={`h-3 ${width}`} />
                  <SkeletonBlock className="h-2.5 w-14" />
                </div>
                <div className="w-6 shrink-0" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
