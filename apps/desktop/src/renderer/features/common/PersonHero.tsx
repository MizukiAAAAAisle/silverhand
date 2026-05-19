import type { ReactNode } from 'react';

/**
 * Identity-led header bar shared by the agent and human panels.
 *
 * Replaces the old per-surface header rows (which were drifting toward
 * a small dashboard) with a slot-based identity summary: avatar,
 * display name, handle, inline meta items, optional bio, and action
 * buttons on the right. Anything operational (active channel list,
 * activity ticker, etc.) belongs in the panel body, NOT here — keeping
 * the Hero purely identity-focused is what lets the same component
 * serve both Agent and Human surfaces.
 *
 * Contract (see #task:396):
 *   - actions slot owns Stop/Delete/etc.; Hero does NOT inject any.
 *   - meta is caller-composed (use {@link HeroDot} as separator) so each
 *     surface can pick which fields belong on the inline meta line.
 *   - presence rendering is the caller's responsibility — pass it
 *     through `meta` next to a `<HeroDot />` for the dotted look.
 *   - bio is a single-line clamp (full text lives in the Profile
 *     panel's Capabilities section, never duplicated multi-line here).
 */
export interface PersonHeroProps {
  /** Pre-sized avatar element. The Hero does not resize or restyle it
   *  so the same `AgentAvatar` / `<img>` / `AvatarPickerButton` instance
   *  used elsewhere can be passed through. */
  avatar: ReactNode;
  /** Big display name. Single line, truncates on overflow. */
  displayName: string;
  /** Bare handle (no leading `@` — the Hero adds it). */
  handle: string;
  /** Inline meta items rendered after the handle. Caller controls the
   *  contents and separators — use {@link HeroDot} between items for
   *  the standard dotted look. */
  meta?: ReactNode;
  /** Single-line summary. Empty/null means the row is skipped entirely
   *  (no empty placeholder band). The full multi-line value belongs in
   *  the Capabilities → Description field. */
  bio?: string | null;
  /** Right-aligned action buttons. Typically Stop + Delete for agents,
   *  Sign-out etc. for humans. */
  actions?: ReactNode;
}

export function PersonHero({
  avatar,
  displayName,
  handle,
  meta,
  bio,
  actions,
}: PersonHeroProps): JSX.Element {
  const hasBio = typeof bio === 'string' && bio.trim().length > 0;
  return (
    <header className="flex shrink-0 items-start gap-4 border-b border-border-subtle bg-bg-floating px-6 py-4">
      <div className="shrink-0">{avatar}</div>

      <div className="min-w-0 flex-1">
        <h1 className="truncate font-serif text-lg font-semibold text-text-primary">
          {displayName}
        </h1>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          <span className="font-mono">@{handle}</span>
          {meta ? <>{meta}</> : null}
        </div>
        {hasBio ? (
          <p
            className="mt-1 truncate text-xs text-text-secondary"
            title={bio ?? undefined}
          >
            {bio}
          </p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

/** Inline dot separator for the meta line. */
export function HeroDot(): JSX.Element {
  return <span aria-hidden="true">·</span>;
}

export interface PresencePillProps {
  /** Count of conversations the agent is `starting` or `active` in.
   *  Zero collapses the pill to plain muted text — empty pills read as
   *  "broken status" on first glance. */
  runningCount: number;
  /** Override label. Defaults to `${runningCount} running/starting`
   *  which intentionally mentions both states so `starting` doesn't
   *  silently vanish from the Hero between spawn and first message. */
  label?: string;
}

/**
 * Presence indicator. When the agent has any starting/active conversation
 * we render a HUD-style state tag — solid `bg-success` tile + on-color
 * dot + uppercase tracking-wider caps — matching the Activity / Schedule
 * status pill vocabulary. Idle falls back to muted text-only so the Hero
 * doesn't carry a state chip when there's no live work. Mirrors the
 * AgentHeader Stop button's `starting || active` predicate so the Hero
 * count never disagrees with what Stop targets.
 */
export function PresencePill({
  runningCount,
  label,
}: PresencePillProps): JSX.Element {
  if (runningCount <= 0) {
    return (
      <span className="text-text-muted">
        {label ?? 'Idle in every conversation'}
      </span>
    );
  }
  const shown =
    label ??
    `${runningCount} running/starting`;
  return (
    <span
      data-panel-pill="presence"
      className="inline-flex items-center gap-1.5 bg-success px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-on-success"
    >
      <span className="size-1.5 rounded-full bg-text-on-success/90" />
      {shown}
    </span>
  );
}
