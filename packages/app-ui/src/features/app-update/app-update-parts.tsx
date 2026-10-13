import type { JSX } from "react";
import type { AppUpdateState } from "@silverhand/client";

export function describeAppUpdate(state: AppUpdateState): string {
  switch (state.status) {
    case "idle":
      return state.lastCheckedAt === null
        ? `Silverhand ${state.currentVersion} has not checked for updates yet.`
        : `Silverhand ${state.currentVersion} is the latest version.`;
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Silverhand ${state.version} is available.`;
    case "downloading":
      return `Downloading Silverhand ${state.version}…`;
    case "downloaded":
      return `Silverhand ${state.version} is ready to install. Restart now, or install it the next time you quit.`;
    case "installing":
      return `Preparing Silverhand ${state.version}…`;
    case "scheduled":
      return `Silverhand ${state.version} will be installed when you quit.`;
    case "error":
      return state.message;
  }
}

function progressPercent(state: Extract<AppUpdateState, { status: "downloading" }>): number | null {
  if (!state.total) return null;
  return Math.min(100, Math.round((state.transferred / state.total) * 100));
}

export function AppUpdateProgress({
  state,
}: {
  state: Extract<AppUpdateState, { status: "downloading" }>;
}): JSX.Element {
  const percent = progressPercent(state);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-1.5 w-full overflow-hidden rounded-full bg-bg-hover"
    >
      <div
        className="h-full bg-(--accent) transition-[width]"
        style={{ width: `${percent ?? 0}%` }}
      />
    </div>
  );
}
