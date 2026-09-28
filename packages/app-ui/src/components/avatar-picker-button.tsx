import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface AvatarPickerButtonProps {
  /**
   * The avatar visual itself (e.g. `<AgentAvatar>` or a custom `<img>` /
   * placeholder). The picker treats it as a square silhouette of
   * `size` × `size` pixels and overlays the hover affordance on top.
   * The visual must already be rendered at `size`; the picker doesn't
   * resize children.
   */
  children: ReactNode;
  /**
   * Pixel size of the avatar square. Used to constrain the click target
   * and to scale the hover bottom strip.
   */
  size: number;
  /**
   * Hover/focus overlay label. The strip is clipped to the avatar's
   * frame (`overflow-hidden`), so this MUST stay very short — a single
   * verb like `'Edit'` or `'Add'`. The smallest call site is the 40px
   * registration-gate avatar; even uppercase 10px text gets trimmed
   * past ~5 characters there. Use `ariaLabel` for the verbose
   * screen-reader text (e.g. `'Change avatar'`).
   */
  label: string;
  /**
   * Called with the picked `File`. Caller handles validation (we keep
   * the picker presentational so the same component fits both
   * mutation-driven flows and the registration gate's "stage locally,
   * upload on submit" flow).
   */
  onPick: (file: File) => void;
  /**
   * Disables click and dims the surface — typically wired to an
   * upload mutation's `isPending`.
   */
  disabled?: boolean;
  /**
   * Override for the accessible name read by screen readers. The visible
   * `label` is forced to a short verb to fit inside the avatar frame's
   * clip, which makes for a poor SR announcement on its own — pass a
   * verbose value here (e.g. `'Change avatar'` / `'Add avatar for @alice'`).
   * Defaults to `label`.
   */
  ariaLabel?: string;
  /** Extra classes applied to the outer label/frame. */
  className?: string;
}

/**
 * Click-the-avatar avatar picker.
 *
 * The whole square is the click target — we wrap the avatar visual in a
 * `<label>` containing a hidden `<input type="file">`. On hover or
 * keyboard focus a thin bottom strip slides in with a single short verb
 * (`'Edit'` / `'Add'`); clicking anywhere on the avatar opens the OS
 * file picker. Designed to replace the previous Choose…/Change… button
 * pattern so the affordance lives on the avatar itself, not in a
 * neighboring control.
 *
 * Removal is intentionally *not* part of this widget: callers render a
 * small "Remove" link beside the picker when an avatar is set. Keeping
 * the destructive action outside the click target avoids misclicks
 * (a mistargeted "Change → click" while aiming for an X icon would
 * silently re-open the picker in a confusing way).
 *
 * Presentational by design — `onPick` is just the picked `File`. The
 * caller does its own client-side validation and mutation wiring.
 */
export function AvatarPickerButton({
  children,
  size,
  label,
  onPick,
  disabled = false,
  ariaLabel,
  className,
}: AvatarPickerButtonProps): JSX.Element {
  const inputId = useId();
  return (
    <label
      htmlFor={inputId}
      className={cn(
        "group relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none",
        // Focus outline lives on the wrapper so keyboard users get a clear
        // outline when the hidden input gains focus via Tab.
        "focus-outline-within",
        disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={ariaLabel ?? label}
    >
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          // Reset so picking the same file again still fires `change`.
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
      {children}
      <span
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 grid place-items-center",
          "bg-black/60 text-white",
          // Tight letter-spacing + a short label is mandatory: the strip
          // sits inside the square `overflow-hidden` clip, so anything
          // wider than the available width gets cut. Callers pass single
          // verbs; `ariaLabel` carries the verbose text.
          "text-(length:--text-badge) font-semibold uppercase tracking-normal",
          "opacity-0 transition-opacity duration-100 ease-out",
          "group-hover:opacity-100 group-focus-within:opacity-100",
        )}
        style={{
          // Bottom third reads as a label band without dominating the
          // avatar; clamp so we don't get a sliver on tiny avatars or
          // an overwhelming bar on the 56–72px profile sizes.
          height: Math.max(14, Math.min(20, Math.round(size * 0.32))),
        }}
        aria-hidden
      >
        {label}
      </span>
    </label>
  );
}
