import { SkeletonBlock, SkeletonRegion } from "@/components/layout/skeleton";
import { AVATAR_PX } from "@/components/avatar-scale";

export function WorkspaceMembersSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label="Loading members">
      <div className="space-y-1">
        {["w-24", "w-20", "w-28"].map((width) => (
          <div
            key={width}
            className="flex h-8 items-center gap-2 rounded-(--chip-radius) border-(length:--control-border-width) border-border-subtle bg-bg-base px-2"
          >
            <div className="shrink-0" style={{ width: AVATAR_PX.sm, height: AVATAR_PX.sm }}>
              <SkeletonBlock className="size-full" />
            </div>
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
              <SkeletonBlock className={`h-3 ${width}`} />
              <SkeletonBlock className="h-2.5 w-16" />
            </div>
            <div className="size-6 shrink-0" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
