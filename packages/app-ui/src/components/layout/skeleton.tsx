import type { ReactNode } from "react";

/** Share paint and accessibility; the consuming surface owns the geometry. */
export function SkeletonBlock({ className = "" }: { className?: string }): JSX.Element {
  return <div className={`shrink-0 rounded-(--control-radius) bg-bg-elevated ${className}`} />;
}

export function SkeletonRegion({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div role="status" aria-label={label} className={`min-w-0 overflow-hidden ${className}`}>
      <div aria-hidden className="motion-safe:animate-pulse">
        {children}
      </div>
    </div>
  );
}
