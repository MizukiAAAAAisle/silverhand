import { EditIcon } from "@/icons";
import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * Shared pencil affordance for section-level "enter edit" triggers on
 * profile cards. Rendered by `ProfileSection titleAdornment` — sits
 * inline immediately after the section title. Icon-only, low-chrome
 * (muted → regular text color on hover, no background pill) so the trigger
 * subordinates to the title.
 *
 * When `hidden` is true the button stays in the DOM as an invisible,
 * inert placeholder so the section header height doesn't change on
 * enter-edit — otherwise removing the pencil collapses the header up by
 * its own height, pulling the whole section top upward one paint before
 * the edit form pushes it back down. Placeholder is `invisible +
 * aria-hidden + tabIndex=-1`.
 */
export function EditPencilButton({
  onClick,
  ariaLabel,
  disabled,
  hidden = false,
}: {
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
  hidden?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={hidden ? undefined : onClick}
      disabled={disabled || hidden}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      className={cn(
        "rounded-(--control-radius) p-1 text-text-muted transition-colors hover:text-text-primary disabled:opacity-50",
        hidden && "invisible",
      )}
      title={hidden ? undefined : ariaLabel}
      aria-label={ariaLabel}
    >
      <EditIcon className="size-3.5" />
    </button>
  );
}
