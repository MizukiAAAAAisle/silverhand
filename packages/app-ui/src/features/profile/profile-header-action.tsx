import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function ProfileHeaderAction({
  compact,
  label,
  title,
  onClick,
  disabled,
  destructive = false,
  children,
}: {
  compact: boolean;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}): JSX.Element {
  if (compact) {
    return (
      <button
        type="button"
        aria-label={label}
        title={title}
        onClick={onClick}
        disabled={disabled}
        data-sticker
        data-sticker-size="md"
        data-sticker-tone="neutral"
        className={`flex size-7 shrink-0 items-center justify-center rounded-(--control-radius) transition-colors hover:bg-bg-hover focus-outline disabled:pointer-events-none disabled:opacity-50 ${destructive ? "text-error" : "text-text-secondary hover:text-text-primary"}`}
      >
        {children}
      </button>
    );
  }

  return (
    <Button
      variant={destructive ? "destructive-outline" : "neutral"}
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      {label}
    </Button>
  );
}
