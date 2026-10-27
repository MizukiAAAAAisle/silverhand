import { CheckIcon, ClockIcon, DragHandleIcon, SortIcon } from "@/icons";
import type { SortMode } from "@silverhand/shared";
import { Button } from "@/components/ui/button";
import { AppDropdownMenu, AppDropdownMenuItem } from "@/components/menus/app-context-menu";
import { t } from "@/lib/i18n";

/**
 * Per-list sort-mode entry (#task:1146). A small icon button in a list's
 * section header (channel sidebar + workspace rail) that opens a two-item
 * menu: Recent (recently-opened) / Manual (drag-to-reorder). The active mode
 * carries a check. The same component serves both surfaces so the product
 * expression stays identical.
 */
export function SortModeMenu({
  mode,
  onChange,
}: {
  mode: SortMode;
  onChange: (mode: SortMode) => void;
}): JSX.Element {
  return (
    <AppDropdownMenu
      align="end"
      contentClassName="min-w-[120px]"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("ui.sort")}
          title={t("ui.sort")}
        >
          <SortIcon className="size-3.5" />
        </Button>
      }
    >
      <AppDropdownMenuItem
        icon={<ClockIcon className="size-3.5" />}
        trailing={mode === "recent" ? <CheckIcon className="size-3.5 text-accent" /> : undefined}
        onSelect={() => onChange("recent")}
      >
        {t("ui.recent")}
      </AppDropdownMenuItem>
      <AppDropdownMenuItem
        icon={<DragHandleIcon className="size-3.5" />}
        trailing={mode === "manual" ? <CheckIcon className="size-3.5 text-accent" /> : undefined}
        onSelect={() => onChange("manual")}
      >
        {t("ui.manual")}
      </AppDropdownMenuItem>
    </AppDropdownMenu>
  );
}
