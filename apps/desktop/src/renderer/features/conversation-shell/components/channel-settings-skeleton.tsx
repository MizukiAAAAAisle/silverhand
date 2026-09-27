import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
export function ChannelSettingsSkeleton(): JSX.Element {
  return (
    <Region label="Loading channel settings" className="p-4">
      <div className="space-y-8">
        <section>
          <h3 className="mb-3 text-xs font-semibold text-text-muted">Members</h3>
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Block key={i} className="size-6" />
            ))}
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-text-muted">INFO</h3>
          <Block className="h-3 w-1/3" />
          <Block className="h-3 w-full" />
          <Block className="h-3 w-2/3" />
        </section>
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-text-muted">Notifications</h3>
          <Block className="h-3 w-3/5" />
        </section>
      </div>
    </Region>
  );
}
