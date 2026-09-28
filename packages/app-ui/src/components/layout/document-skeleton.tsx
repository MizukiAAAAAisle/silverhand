import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
/** Text/document preview keeps its reading column instead of imitating a settings form. */
export function DocumentSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <Region label={label} className="px-4 py-3">
      <div className="max-w-[76ch] space-y-6">
        <Block className="h-5 w-2/5" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2.5">
            <Block className="h-3 w-full" />
            <Block className="h-3 w-11/12" />
            <Block className={`h-3 ${i % 2 ? "w-2/3" : "w-4/5"}`} />
          </div>
        ))}
      </div>
    </Region>
  );
}
