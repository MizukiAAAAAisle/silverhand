import { useId, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useCompactLayout } from "@/navigation/layout";
import { cn } from "@/lib/cn";
import { Button } from "./button";

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
  const label = `${disclosure.expanded ? "Hide" : "Show"} filters${active ? " (active)" : ""}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-expanded={disclosure.expanded}
      aria-controls={disclosure.contentId}
      data-sticker={disclosure.expanded ? "" : undefined}
      data-sticker-tone={disclosure.expanded ? "neutral" : undefined}
      data-sticker-size="sm"
      className={cn("shrink-0", disclosure.expanded && "bg-bg-hover", active && "text-accent")}
      onClick={disclosure.toggle}
    >
      <SlidersHorizontal className="size-4" />
    </Button>
  );
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
      aria-label="Filters"
      hidden={!disclosure.expanded}
      className={className}
    >
      {children}
    </section>
  );
}
