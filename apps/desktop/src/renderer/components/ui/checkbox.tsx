import { Check } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/** Minimal checkbox primitive (no Radix checkbox dep). Renders as a
 *  `role="checkbox"` button so it works inside clickable label rows. */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, onCheckedChange, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[var(--control-radius)] border-[length:var(--control-border-width)] transition-colors",
        checked
          ? "border-transparent bg-[var(--bg-control-primary)] text-[var(--text-on-control-primary)]"
          : "border-border bg-bg-floating text-transparent",
        disabled ? "opacity-50" : "cursor-pointer hover:border-[var(--bg-control-primary)]",
        className,
      )}
      {...props}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  ),
);
Checkbox.displayName = "Checkbox";
