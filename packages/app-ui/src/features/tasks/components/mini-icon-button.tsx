import { type IconComponent } from "@/icons";
import { cn } from "@/lib/cn";

/** Small flat icon-only control (18px) for the task detail modal's inline
 *  affordances — the per-field edit pencils and the Assignee row's clear: no
 *  fill, no border, just deepening from muted → primary ink on hover. Shared so
 *  those read as one family. (The header "View in conversation" jump is NOT one
 *  of these — it's the close ✕'s twin, styled via `dialogCornerButtonClass`.)
 *  Always carries a tooltip + accessible name (`<button>` exposes aria-label). */
export function MiniIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
}: {
  icon: IconComponent;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-4.5 shrink-0 items-center justify-center rounded-(--control-radius) text-text-muted transition-colors hover:text-text-primary focus-outline disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
