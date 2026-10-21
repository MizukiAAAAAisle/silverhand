import type { JSX } from "react";
import type { AppUpdateState } from "@silverhand/client";
import { t } from "@/lib/i18n";

export function describeAppUpdate(state: AppUpdateState): string {
  switch (state.status) {
    case "idle":
      return state.lastCheckedAt === null
        ? t("appUpdate.notChecked", { version: state.currentVersion })
        : t("appUpdate.latest", { version: state.currentVersion });
    case "checking":
      return t("appUpdate.checkingForUpdates");
    case "available":
      return t("appUpdate.available", { version: state.version });
    case "downloading":
      return t("appUpdate.downloading", { version: state.version });
    case "downloaded":
      return t("appUpdate.readyToInstall", { version: state.version });
    case "installing":
      return t("appUpdate.preparing", { version: state.version });
    case "scheduled":
      return t("appUpdate.willInstallOnQuit", { version: state.version });
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
