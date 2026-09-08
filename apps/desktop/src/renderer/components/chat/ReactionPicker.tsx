import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";

/**
 * Curated quick-reaction set for v1. Rendered with the OS-native emoji font
 * (Apple on macOS, the only v1 target) — no third-party emoji library, so
 * the bundle stays lean and the picker stays simple
 * (docs/reactions-design.md; shiki 2026-06-14 拍板 native Apple + 这 8 个).
 */
export const QUICK_REACTIONS = ["👍", "🎉", "👀", "💯", "🔥", "🚀", "😄", "🤣"] as const;

export interface ReactionPickerProps {
  /** The popover anchor. Must be a single ref-forwarding element (a native
   *  `<button>` is fine) — Radix clones it via `asChild`. */
  trigger: React.ReactNode;
  onPick: (emoji: string) => void;
  /** Bubbled so the host row can stay "framed" while the picker is open: the
   *  trigger often lives in a hover-revealed cluster that would otherwise
   *  collapse out from under the (portaled) picker — the four-pit nested-
   *  overlay guard (see notes/user-preferences.md). */
  onOpenChange?: (open: boolean) => void;
  /** Which trigger edge the grid grows from: `start` grows rightward, `end`
   *  leftward. Callers whose trigger is mirrored for own (`user-right`)
   *  messages must mirror this too, so the grid always opens into the message
   *  row rather than out of it (#task:1840). */
  align?: "start" | "center" | "end";
}

/**
 * Click-driven emoji picker shared by both add affordances — the message's
 * top-right "React" corner button and the inline trailing add chip. v1 is a
 * compact grid of common emoji; a searchable / full picker is a deliberate
 * later add (the entry points and contract don't change).
 */
export function ReactionPicker({
  trigger,
  onPick,
  onOpenChange,
  align = "start",
}: ReactionPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const handleOpen = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Popover.Root open={open} onOpenChange={handleOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          data-popover-frame="info"
          className="z-[var(--z-popover-nested)] rounded-[var(--floating-radius)] border border-border bg-bg-floating p-1.5 shadow-popover outline-none"
        >
          <div className="grid grid-cols-8 gap-0.5">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  handleOpen(false);
                  onPick(emoji);
                }}
                aria-label={`React ${emoji}`}
                className="flex size-7 items-center justify-center rounded-[var(--floating-item-radius)] text-base leading-none transition-colors hover:bg-bg-hover focus-outline"
              >
                {emoji}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
