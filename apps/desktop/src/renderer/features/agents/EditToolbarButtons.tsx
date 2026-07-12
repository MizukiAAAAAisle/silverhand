import type { JSX } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Save / Cancel button pair for the agent-profile edit sessions
 * (display_name, description, runtime configuration — three sections
 * × two buttons = six sites). Centralized so the button chrome stays
 * uniform as the design language evolves:
 *
 *  - Both buttons carry the same ink border. Border WIDTH consumes
 *    `--control-border-width` (per-theme; forza6 raises it to 2px);
 *    border COLOR is `border-border-focus` (theme ink).
 *  - Save uses the theme primary fill (`variant="default"`), Cancel
 *    stays neutral (`variant="outline"`). Main/subordinate hierarchy
 *    intentional — shiki wants them visually differentiated but both
 *    bordered.
 *
 * shiki 2026-07-12 dogfood round-4 #2 + Cindy scope note: "6 个按钮都
 * 走同一局部 class/source"。No edits to the shared Button variants.
 */

const EDIT_BUTTON_BORDER =
  'border-[length:var(--control-border-width)] border-border-focus';

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
      className={cn(EDIT_BUTTON_BORDER)}
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
      className={cn(EDIT_BUTTON_BORDER)}
    >
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}
