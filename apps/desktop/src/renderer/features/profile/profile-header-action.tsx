import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { neutralAction } from "@/components/common/control-ink-border";
import { destructiveAction, DESTRUCTIVE_TRIGGER } from "@/components/common/destructive-action";

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
        className={`flex size-7 shrink-0 items-center justify-center rounded-(--control-radius) transition-colors hover:bg-bg-hover focus-outline disabled:pointer-events-none disabled:opacity-50 ${destructive ? "text-error" : "text-text-muted hover:text-text-primary"}`}
      >
        {children}
      </button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
      {...(destructive ? destructiveAction(DESTRUCTIVE_TRIGGER) : neutralAction())}
    >
      {children}
      {label}
    </Button>
  );
}
