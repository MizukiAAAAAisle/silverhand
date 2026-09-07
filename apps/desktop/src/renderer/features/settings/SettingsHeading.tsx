import type { ReactNode } from 'react';

export function SettingsHeading({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span
        data-settings-icon-chip
        className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-bg-elevated text-text-secondary"
      >
        {icon}
      </span>
      <h2 className="min-w-0 font-serif text-base font-semibold text-text-primary">
        {title}
      </h2>
    </div>
  );
}
