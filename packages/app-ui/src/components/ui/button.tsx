import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { CONTROL_HOVER_LIFT, CONTROL_INK_BORDER } from "@/components/common/control-ink-border";

/**
 * The poster-action family lives here as `variant`s, not as external prop
 * factories: a Cancel that is one `variant="cancel"` cannot drift from its frame
 * the way a `variant="outline" + {...primaryCancel()}` pair could. Each action
 * variant carries its own hover transition (the base row omits it so the fuller
 * `translate,box-shadow` tuple is not fighting a `transition-colors` from base),
 * and tags itself with `data-button-action` so a theme can finish the sticker
 * (see forza6-components.css). Layout stays on `className`.
 *
 * The three action treatments a theme paints:
 *  - `primary`  — the filled commit (Save / Create).
 *  - `destructive` / `destructive-outline` — the delete rank. Solid `danger`
 *    fill for a dialog footer where the delete IS the primary; red-on-paper
 *    frame for a settings / inline delete whose page already has a primary and
 *    must not gain a second shout. In forza6 both are the same red poster.
 *  - `cancel` / `neutral` — the ink-framed surface. `cancel` answers a commit
 *    (hover changes the frame only); `neutral` is a reversible action like
 *    Archive (hover also fills). Both are the same forza6 ink poster.
 */
const SURFACE_BASE = `${CONTROL_INK_BORDER} bg-bg-floating text-text-primary ${CONTROL_HOVER_LIFT} hover:border-[color:var(--border-control-hover)]`;

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-(--control-radius) text-sm font-medium focus-outline disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "transition-colors bg-[var(--bg-control-primary,var(--accent))] text-[color:var(--text-on-control-primary,var(--text-on-accent))] hover:bg-[var(--bg-control-primary-hover,var(--accent-hover))]",
        soft: "transition-colors bg-accent-soft text-accent hover:bg-[color-mix(in_srgb,var(--accent),transparent_72%)]",
        ghost: "transition-colors text-text-secondary hover:bg-bg-hover hover:text-text-primary",
        outline:
          "transition-colors border border-border bg-bg-floating text-text-primary hover:bg-bg-hover",
        danger: "transition-colors bg-error text-text-on-error hover:opacity-90",
        primary: `${CONTROL_HOVER_LIFT} bg-[var(--bg-control-primary,var(--accent))] text-[color:var(--text-on-control-primary,var(--text-on-accent))] hover:bg-[var(--bg-primary-action-hover,var(--bg-control-primary-hover,var(--accent-hover)))]`,
        destructive: `${CONTROL_HOVER_LIFT} bg-error text-text-on-error hover:opacity-100`,
        "destructive-outline": `${CONTROL_HOVER_LIFT} border-[length:var(--control-border-width)] border-error bg-bg-floating text-error hover:bg-error-soft`,
        cancel: SURFACE_BASE,
        neutral: `${SURFACE_BASE} hover:bg-[var(--bg-hover)]`,
      },
      size: {
        xs: "h-6 px-2 text-xs",
        sm: "h-7 px-2.5",
        md: "h-9 px-3",
        lg: "h-10 px-4",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

/** The `data-button-action` a theme keys its sticker off. `primary` and the two
 *  destructive ranks and the two surface ranks collapse to three groups because
 *  that is how many treatments forza6 paints. */
function actionHook(variant: ButtonProps["variant"]): string | undefined {
  switch (variant) {
    case "primary":
      return "primary";
    case "destructive":
    case "destructive-outline":
      return "destructive";
    case "cancel":
    case "neutral":
      return "neutral";
    default:
      return undefined;
  }
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        data-button-action={actionHook(variant)}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
