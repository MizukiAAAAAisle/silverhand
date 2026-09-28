import { SkeletonBlock as Block, SkeletonRegion as Region } from "./skeleton";

/** Static row geometry only; never participates in selection or unread reveal. */
export function SidebarRowsSkeleton({
  label,
  nested = false,
  members = false,
}: {
  label: string;
  nested?: boolean;
  members?: boolean;
}): JSX.Element {
  return (
    <Region label={label}>
      {["w-24", "w-20", "w-28"].map((width) => (
        <div
          key={width}
          className={`sidebar-row-border flex h-8 items-center gap-2 border border-transparent pr-2 ${nested ? "pl-3" : "pl-2"}`}
        >
          <div className="flex size-5.5 shrink-0 items-center justify-center">
            <Block className="size-4" />
          </div>
          <Block className={`h-3 min-w-0 ${width}`} />
          {members ? <Block className="h-2.5 w-8" /> : null}
        </div>
      ))}
    </Region>
  );
}
