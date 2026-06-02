import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Profile panel building blocks shared by the agent and human profile
 * cards. Replaces the previous form-row pattern (120px label grid
 * across every field) — that pattern read as a settings sheet rather
 * than a profile summary, and stacking everything in a single rhythm
 * made it hard to skim. The new shape:
 *
 *   <ProfileSection title="Identity"> [editor-ish or display content] </ProfileSection>
 *   <ProfileSection title="Capabilities">
 *     <ProfileFieldGrid>
 *       <ProfileField label="Runtime">…</ProfileField>
 *       <ProfileField label="Model">…</ProfileField>
 *       <ProfileField label="Description" full>…</ProfileField>
 *     </ProfileFieldGrid>
 *   </ProfileSection>
 *   <ProfileSection title="Metadata" muted>
 *     <MetadataList items={…} />
 *   </ProfileSection>
 *
 * Sections are bordered cards (one per concept), fields inside a
 * section are stacked label-on-top in a 2-column wrap grid, metadata
 * is a tighter `<dl>`-style list because IDs/timestamps don't need
 * field chrome.
 *
 * The primitives are deliberately presentation-only — they do NOT own
 * any state or commit logic; the agent/human cards keep their existing
 * `useUpdateAgent` / `useUpdateProfile` mutations and pass editors in
 * as `children`. That keeps codex-specific selects, runtime-blocked
 * disables, and avatar pickers untouched.
 */

export interface ProfileSectionProps {
  title: string;
  /** Right-aligned slot in the section header — typically an "edit"
   *  link or an icon button. Visual subordinate to the title. */
  headerSlot?: ReactNode;
  /** When `true` the title renders in `text-muted` rather than
   *  `text-secondary`. Used for the Metadata section so it visually
   *  recedes below the user-facing fields. */
  muted?: boolean;
  children: ReactNode;
}

export function ProfileSection({
  title,
  headerSlot,
  muted = false,
  children,
}: ProfileSectionProps): JSX.Element {
  return (
    <section className="flex flex-col">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3
          className={cn(
            'font-serif text-[13px] font-semibold uppercase tracking-wider',
            muted ? 'text-text-muted' : 'text-text-secondary',
          )}
        >
          {title}
        </h3>
        {headerSlot ? (
          <div className="text-[11px] text-text-muted">{headerSlot}</div>
        ) : null}
      </header>
      <div
        data-panel-card="profile-section"
        className={cn(
          'border border-border-subtle bg-bg-floating/50 p-4',
          // Hover affordance: subtle → stronger border to give the
          // section card a "alive" feel. Forza6 theme amplifies this
          // into the poster-sticker hover (gray → ink near-black) via
          // its component overrides; warm stays soft. Radius lives in
          // global.css under the `[data-panel-card='profile-section']`
          // hook (drives off `--profile-section-radius`) — do not add
          // a `rounded-*` class or inline `border-radius` here. #task:814.
          'transition-colors duration-150 hover:border-border',
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Wrap one or more `<ProfileField>` to lay them out as a responsive
 *  2-column grid that wraps to a single column on narrow widths. */
export function ProfileFieldGrid({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {children}
    </div>
  );
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
    <div className={cn('flex min-w-0 flex-col gap-1', full ? 'sm:col-span-2' : '')}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
      {hint ? (
        <div className="text-[11px] leading-snug text-text-muted">{hint}</div>
      ) : null}
    </div>
  );
}

export interface MetadataItem {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}

/**
 * Compact `<dl>` list for IDs, timestamps, host ids — values that the
 * user reads but rarely interacts with. Kept tight on purpose so the
 * Metadata section doesn't take more visual weight than Capabilities.
 */
export function MetadataList({
  items,
}: {
  items: MetadataItem[];
}): JSX.Element {
  return (
    <dl className="divide-y divide-border-subtle/60">
      {items.map(item => (
        <div
          key={item.label}
          className="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0"
          title={item.title}
        >
          <dt className="text-[11px] uppercase tracking-wider text-text-muted">
            {item.label}
          </dt>
          <dd
            className={cn(
              'min-w-0 truncate text-xs text-text-primary',
              item.mono ? 'font-mono' : '',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
