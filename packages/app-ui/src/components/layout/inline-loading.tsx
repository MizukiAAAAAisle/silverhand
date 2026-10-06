import { SpinnerIcon } from "@/icons";

/** Small candidate menus need a status row, not a page skeleton. */
export function InlineLoading({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted">
      <SpinnerIcon aria-hidden className="size-3 motion-safe:animate-spin" />
      {label}…
    </div>
  );
}
