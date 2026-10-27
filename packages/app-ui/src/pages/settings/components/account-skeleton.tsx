import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { AVATAR_PX } from "@/components/avatar-scale";
import { t } from "@/lib/i18n";
export function AccountSkeleton(): JSX.Element {
  return (
    <Region label={t("settings.account.loading")} className="px-5 py-5">
      <h2 className="mb-5 text-base font-semibold text-text-primary">
        {t("settings.sections.account")}
      </h2>
      <div className="max-w-2xl space-y-6">
        <div className="flex gap-3 items-center">
          <div style={{ width: AVATAR_PX["3xl"], height: AVATAR_PX["3xl"] }}>
            <Block className="size-full" />
          </div>
          <div className="flex-1 space-y-2">
            <Block className="h-4 w-32" />
            <Block className="h-3 w-20" />
          </div>
        </div>
        <div className="border-t border-border-subtle pt-5 space-y-2">
          <p className="text-xs text-text-muted">{t("appShell.displayName")}</p>
          <Block className="h-8 w-full" />
        </div>
        <div className="space-y-3">
          <Block className="h-3 w-28" />
          <Block className="h-3 w-2/3" />
        </div>
      </div>
    </Region>
  );
}
