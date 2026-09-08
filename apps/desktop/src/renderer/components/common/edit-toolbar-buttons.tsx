import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { primaryAction, primaryCancel } from "./primary-action";

/**
 * Save / Cancel button pair for profile-card edit sessions (display
 * name, description, runtime configuration on the agent card; display
 * name on the human card). Centralized so the button chrome stays
 * uniform as the design language evolves:
 *
 *  - Both buttons carry the same ink border. Border WIDTH consumes
 *    `--control-border-width` (per-theme; forza6 raises it to 2px);
 *    border COLOR is `border-border-focus` (theme ink).
 *  - Save uses the theme primary fill (`variant="default"`), Cancel
 *    stays neutral (`variant="outline"`). Main/subordinate hierarchy
 *    intentional — visually differentiated but both bordered.
 *  - Save also carries `primaryAction()`, the app-wide primary-CTA hook
 *    (#task:1623), so this inline Save is the same affordance as the
 *    dialogs' Save / Create — a poster sticker in forza6, a lifting solid
 *    fill elsewhere. Its own ink border stays for the OTHER themes; in
 *    forza6 the theme rule supersedes it with the sticker frame.
 *  - Cancel carries the matching `primaryCancel()` — the pair's neutral
 *    framed surface. Its own two-token border is dropped because the hook's
 *    `CONTROL_SURFACE_BUTTON` already ships exactly that border plus the
 *    canonical control-hover pair, and in forza6 the ink sticker shadow, so
 *    the two halves peel by the same amount.
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
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={onClick}
      disabled={disabled}
      {...primaryCancel()}
    >
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
      variant="default"
      size="xs"
      onClick={onClick}
      disabled={disabled || pending}
      {...primaryAction(cn(EDIT_BUTTON_BORDER))}
    >
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}
