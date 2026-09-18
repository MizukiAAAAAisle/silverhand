import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import "./profile-fact-band.css";

export interface ProfileSectionProps {
  title: string;
  /** Rendered inline immediately after the title — for a small edit
   *  affordance (pencil icon) that visually belongs to the label rather
   *  than the section's right edge. Use this for section-scoped edit
   *  triggers; use `headerSlot` for trailing utility actions (copy,
   *  disclosure) whose natural home is the right edge. */
  titleAdornment?: ReactNode;
  /** Right-aligned slot in the section header — typically a trailing
   *  utility action (copy, download). Visual subordinate to the title. */
  headerSlot?: ReactNode;
  /** When `true` the title renders in `text-muted` rather than
   *  `text-secondary`. Used for the Metadata section so it visually
   *  recedes below the user-facing fields. */
  muted?: boolean;
  children: ReactNode;
}

export function ProfileSection({
  title,
  titleAdornment,
  headerSlot,
  muted = false,
  children,
}: ProfileSectionProps): JSX.Element {
  return (
    <section className="flex flex-col">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3
            className={cn(
              "font-serif text-(length:--text-strong) font-semibold uppercase tracking-wider",
              muted ? "text-text-muted" : "text-text-secondary",
            )}
          >
            {title}
          </h3>
          {titleAdornment ?? null}
        </div>
        {headerSlot ? (
          <div className="text-(length:--text-meta) text-text-muted">{headerSlot}</div>
        ) : null}
      </header>
      <div
        data-panel-card="profile-section"
        className={cn(
          "border border-border-subtle bg-bg-floating/50 p-3",
          "transition-colors duration-150 hover:border-border",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Wrap one or more `<ProfileField>` to lay them out as a responsive
 *  2-column grid that wraps to a single column on narrow widths. */
export function ProfileFieldGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">{children}</div>;
}

export interface ProfileFieldProps {
  label: string;
  /** Tiny one-liner below the value (NOT below the label) — for hints
   *  like "Stop the agent before changing." that explain a disabled
   *  state. */
  hint?: string;
  /** When `true` the field spans the full grid width. Use for
   *  long-form values (descriptions, system prompts) that need the
   *  whole row. */
  full?: boolean;
  children: ReactNode;
}

export function ProfileField({
  label,
  hint,
  full = false,
  children,
}: ProfileFieldProps): JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", full ? "sm:col-span-2" : "")}>
      <div className="text-(length:--text-meta) font-medium uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
      {hint ? (
        <div className="text-(length:--text-meta) leading-snug text-text-muted">{hint}</div>
      ) : null}
    </div>
  );
}

/** Metadata band under a profile hero: a breakpoint-driven responsive grid keyed
 *  off its own container width — all facts on one row when wide, wrapping to a
 *  2-up then 1-up grid as the pane narrows, with icon / label / value columns
 *  staying aligned across rows (see profile-fact-band.css). */
export function ProfileFactBand({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-fact-band className="text-(length:--text-meta) text-text-muted">
      <div data-fact-band-grid>{children}</div>
    </div>
  );
}

/** One fact in a `ProfileFactBand`: a muted `icon` + text `label` (both
 *  non-selectable, so copying the value never drags in the dimension marker)
 *  + selectable value. `display: contents` (via [data-fact]) so the icon, label
 *  and value land directly in the band's three grid columns. */
export function ProfileFact({
  icon,
  label,
  children,
}: {
  icon?: ReactNode;
  label?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span data-fact>
      <span className="flex size-3.5 shrink-0 select-none items-center justify-center text-text-muted">
        {icon}
      </span>
      <span className="shrink-0 select-none pl-1.5 pr-1.5 text-text-muted">{label}</span>
      <span className="min-w-0 pr-6">{children}</span>
    </span>
  );
}
