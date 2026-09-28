declare const __SILVERHAND_SIDEBAR_PERF_VARIANT__: string | undefined;

export type SidebarPerformanceVariant = "baseline" | "keep-mounted" | "compositor-isolation";

const raw =
  typeof __SILVERHAND_SIDEBAR_PERF_VARIANT__ === "string"
    ? __SILVERHAND_SIDEBAR_PERF_VARIANT__
    : "baseline";

export const SIDEBAR_PERFORMANCE_VARIANT: SidebarPerformanceVariant =
  raw === "keep-mounted" || raw === "compositor-isolation" ? raw : "baseline";

export const SIDEBAR_KEEP_MOUNTED = SIDEBAR_PERFORMANCE_VARIANT !== "baseline";
export const SIDEBAR_ANIMATE_LAYOUT = SIDEBAR_PERFORMANCE_VARIANT !== "compositor-isolation";
