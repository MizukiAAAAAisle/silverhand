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
        {/* Display name + inline description (subtitle style). The bio
            sits inline after the name in muted color so it reads as
            "Norman · Design Engineer" — descriptor of the person, not a
            separate band below. The full multi-line value still lives
            in the Capabilities → Description field; here it's a
            single-line clamp via the parent flex's `truncate`.
            #task:912 review round 6. */}
        <h1 className="flex min-w-0 items-baseline gap-2 font-serif text-lg font-semibold text-text-primary">
          <span className="truncate">{displayName}</span>
          {hasBio ? (
            <span
              className="min-w-0 truncate font-sans text-sm font-normal text-text-muted"
              title={bio ?? undefined}
            >
              {bio}
            </span>
          ) : null}
        </h1>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          <span className="font-mono">@{handle}</span>
          {meta ? <>{meta}</> : null}
        </div>
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
  /** Agent-on-computer liveness — whether the agent's runtime is live on
   *  its computer (`/hosts/:id/status.agents[].online`). Online → solid
   *  success pill, offline → outline pill. This is the agent-global
   *  liveness axis; it is deliberately NOT conversation activity (an agent
   *  can be live-but-idle: its CLI stays resident between turns). Per-
   *  conversation running/idle belongs on conversation surfaces, never
   *  here (#task:1362). */
  online: boolean;
  /** Override label. Defaults to Online / Offline. */
  label?: string;
}

/**
 * Presence indicator for the agent-global Hero. Renders a HUD-style state
 * tag — solid `bg-success` tile + on-color dot for online, outline form
 * (transparent bg + border + muted text + dot) for offline — the same
 * geometry across both states so online/offline read as one indicator
 * family at different states, matching the Activity / Schedule pill
 * vocabulary.
 *
 * Reads liveness, NOT conversation activity: the Agent page is the agent's
 * global profile (not a conversation), so an alive-but-idle agent must read
 * as Online here, otherwise users mistake a resident runtime for "no
 * runtime" (shiki #task:1362). Conversation running/idle lives on
 * conversation surfaces + the Stop button, never in this pill.
 */
export function PresencePill({
  online,
  label,
}: PresencePillProps): JSX.Element {
  if (!online) {
    // Outline form (transparent bg + border + muted text). Theme-safe:
    // conveys "off" via the absent fill, never collides with any theme's
    // elevated surface, and reads as the same indicator family as the
    // online pill (matched geometry, swapped fill). See #task:917 history.
    return (
      <span
        data-panel-pill="presence-offline"
        className="inline-flex items-center gap-1.5 border border-border-subtle bg-transparent px-2 py-0.5 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted"
      >
        <span className="size-1.5 rounded-full bg-text-muted/60" />
        {label ?? 'Offline'}
      </span>
    );
  }
  return (
    <span
      data-panel-pill="presence"
      className="inline-flex items-center gap-1.5 bg-success px-2 py-0.5 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-on-success"
    >
      <span className="size-1.5 rounded-full bg-text-on-success/90" />
      {label ?? 'Online'}
    </span>
  );
}
