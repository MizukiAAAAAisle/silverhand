import type { JSX } from "react";
import { Button } from "@/components/ui/button";

/**
 * Save / Cancel button pair for profile-card edit sessions (display
 * name, description, runtime configuration on the agent card; display
 * name on the human card). Centralized so the button chrome stays
 * uniform as the design language evolves:
 *
 *  - Save is the app-wide primary CTA (`variant="primary"`) plus an ink
 *    border of its own (`--control-border-width` + `border-border-focus`),
 *    so outside forza6 the inline Save reads as a bordered solid fill; in
 *    forza6 the theme sticker frame supersedes it.
 *  - Cancel is `variant="cancel"` — the pair's neutral framed surface, whose
 *    frame + control-hover pair (and forza6 ink sticker shadow) match Save.
 */

const EDIT_BUTTON_BORDER = "border-[length:var(--control-border-width)] border-border-focus";

export function CancelButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Button type="button" variant="cancel" size="xs" onClick={onClick} disabled={disabled}>
      Cancel
    </Button>
  );
}

export function SaveButton({
  onClick,
  disabled,
  pending,
}: {
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="primary"
      size="xs"
      className={EDIT_BUTTON_BORDER}
      onClick={onClick}
      disabled={disabled || pending}
    >
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}
