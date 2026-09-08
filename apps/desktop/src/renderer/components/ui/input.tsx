import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        data-input=""
        className={cn(
          "flex h-9 w-full rounded-(--control-radius) border-(length:--control-border-width) border-border bg-bg-floating px-3 py-1 text-sm text-text-primary placeholder:text-text-muted focus-visible:border-border-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-input=""
    className={cn(
      "flex min-h-20 w-full rounded-(--control-radius) border-(length:--control-border-width) border-border bg-bg-floating px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:border-border-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & {
  required?: boolean;
}): JSX.Element {
  return (
    <label className={cn("text-xs font-medium text-text-secondary", className)} {...props}>
      {children}
      {required ? (
        <span aria-hidden className="ml-0.5 text-error">
          *
        </span>
      ) : null}
    </label>
  );
}
