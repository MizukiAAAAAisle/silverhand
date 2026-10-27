import { useId, useState, type ReactNode } from "react";
import { FiltersIcon } from "@/icons";
import { useCompactLayout } from "@/navigation/layout";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { iconMarkup, type NativeBarAction } from "@/components/layout/native-page-bar";

/** Presentation only: query and filter values remain owned by the page. */
export function useFilterDisclosure() {
  const contentId = useId();
  const compact = useCompactLayout();
  const [open, setOpen] = useState(false);
  return {
    contentId,
    compact,
    expanded: !compact || open,
    toggle: () => setOpen((previous) => !previous),
  };
}

type FilterDisclosure = ReturnType<typeof useFilterDisclosure>;

/** Fits an existing header action slot without adding filter APIs to the header. */
export function FilterToggle({
  disclosure,
  active,
}: {
  disclosure: FilterDisclosure;
  active: boolean;
}): JSX.Element | null {
  if (!disclosure.compact) return null;
  const label = t(`ui.filters.${disclosure.expanded ? "hide" : "show"}${active ? "Active" : ""}`);
  // Compact only: the navigation bar's glass capsule, like Back beside it.
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={disclosure.expanded}
      aria-controls={disclosure.contentId}
      data-filter-toggle
      className={cn("mobile-header-action focus-outline", active && "text-accent")}
      onClick={disclosure.toggle}
    >
      <FiltersIcon />
    </button>
  );
}

/** `FilterToggle` as a native bar button. */
export function filterBarAction(
  disclosure: FilterDisclosure,
  active: boolean,
): NativeBarAction | null {
  if (!disclosure.compact) return null;
  return {
    id: "filters",
    label: t(`ui.filters.${disclosure.expanded ? "hide" : "show"}`),
    accessibilityLabel: active
      ? t(`ui.filters.${disclosure.expanded ? "hide" : "show"}Active`)
      : undefined,
    icon: iconMarkup(FiltersIcon),
    selected: disclosure.expanded,
    dot: active,
    run: disclosure.toggle,
  };
}

export function FilterPanel({
  disclosure,
  className,
  children,
}: {
  disclosure: FilterDisclosure;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      id={disclosure.contentId}
      aria-label={t("ui.filters.label")}
      hidden={!disclosure.expanded}
      className={className}
    >
      {children}
    </section>
  );
}
