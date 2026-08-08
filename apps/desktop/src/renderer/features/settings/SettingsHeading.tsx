import type { ReactNode } from 'react';

/**
 * The heading that opens a Settings pane or one of its groups: 28×28 icon chip
 * + serif title, on one baseline.
 *
 * Its own module because both users need it and `SettingsPage` already imports
 * `ConnectionPane` — exporting it from there would close the cycle. Every pane
 * heading is the SAME object rather than three look-alikes (shiki 2026-08-06
 * 「Appearance h2 前面都给了 icon,connection / Account 也给,同一个风格」), so the
 * chip's per-theme painting (`data-settings-icon-chip` — forza6 turns it into a
 * poster sticker) reaches all of them and can't drift per pane.
 *
 * Title only, no description line (shiki 2026-08-06「h2 下的 description 去掉,
 * 然后保证 h2 和 icon 对齐」): the controls under each heading state their own
 * scope, and with the second line gone the chip and the title share one axis —
 * `items-center`, no nudge. Icons are the section's own glyph — the same one the
 * rail row and the card header show — at `size-4`.
 */
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
