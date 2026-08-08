import { Bot } from 'lucide-react';
import { cn } from '@/lib/cn';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import type { AuthorAvatar, AuthorPresentation } from './author-presentation';

/**
 * The ONE avatar renderer for a resolved {@link AuthorAvatar} (#task:1792), so
 * every author surface — byline, thread repliers, reply preview, activity —
 * draws the four variants identically:
 *
 *  - `agent`         — active agent: runtime-branded {@link AgentAvatar}, bytes
 *                      from the active-author avatar batch (keyed by the
 *                      author's own id, never a roster join).
 *  - `user`          — active user: {@link UserAvatar} with their bytes.
 *  - `neutral-agent` — deleted / unresolved agent: a runtime-FREE neutral
 *                      square. A deleted actor snapshots NO avatar bytes and
 *                      MUST NOT leak a runtime (which the DTO already withholds),
 *                      so this is a generic glyph, not a de-tinted AgentAvatar.
 *  - `neutral-user`  — deleted / unresolved user: the neutral person square
 *                      (`UserAvatar` with no bytes).
 *
 * The active arms resolve their bytes from the maps the consumer already lifts
 * (`useAgentAvatarObjectUrls` / `useUserAvatarObjectUrls`); `objectUrlOverride`
 * lets the byline feed the viewer's own already-resolved blob for a self-send.
 * Neutral arms ignore all of these — they never fetch.
 */
export function AuthorAvatarView({
  avatar,
  size,
  label,
  className,
  agentAvatarUrls,
  humanAvatarUrls,
  objectUrlOverride,
}: {
  avatar: AuthorAvatar;
  size: number;
  /** Alt / title text — the resolved author label. */
  label: string;
  className?: string;
  agentAvatarUrls?: ReadonlyMap<string, string | null>;
  humanAvatarUrls?: ReadonlyMap<string, string | null>;
  /** A pre-resolved object URL that wins over the maps — the byline uses it to
   *  feed the viewer's own avatar blob for a self-authored row. */
  objectUrlOverride?: string | null;
}): JSX.Element {
  switch (avatar.variant) {
    case 'agent':
      return (
        <AgentAvatar
          runtime={avatar.runtime}
          size={size}
          className={className}
          avatarObjectUrl={objectUrlOverride ?? agentAvatarUrls?.get(avatar.id) ?? null}
          alt={label}
          title={label}
        />
      );
    case 'user':
      return (
        <UserAvatar
          size={size}
          className={className}
          avatarObjectUrl={objectUrlOverride ?? humanAvatarUrls?.get(avatar.id) ?? null}
          alt={label}
          title={label}
        />
      );
    case 'neutral-user':
      return <UserAvatar size={size} className={className} title={label} />;
    case 'neutral-agent':
      return <NeutralAgentAvatar size={size} className={className} title={label} />;
  }
}

/** A quiet chip marking that an author's account was deleted (#task:1792,
 *  #task:1797). A **neutral fill** chip — NOT a saturated status pill: the
 *  deletion is a fact about the byline, not a signal competing for the row's
 *  attention budget. The fill (not color, not weight) is what does the work:
 *  as plain muted text the marker sat on the header line next to the timestamp
 *  and read as just another meta field (shiki 2026-08-03); a neutral `bg`
 *  container makes it a discrete token that's distinguishable from flowing meta
 *  without raising its loudness. Deliberately flat — one neutral fill, no border
 *  and no shadow (utility/state stays in the ink vocabulary). Its corner radius
 *  rides the per-theme `--chip-radius` token (forza6 hard-cuts to 0, the hairline
 *  themes round to 4px) so the chip speaks each theme's shape language instead of
 *  a hardcoded `rounded` that split across them (shiki 2026-08-03). The ONE
 *  deleted-state visual, shared by every surface that shows a text author name
 *  (byline, activity, saved / search / attachment rows, thread summaries) so the
 *  state can never be dropped on one of them. */
export function DeletedActorMarker(): JSX.Element {
  return (
    <span
      className="rounded-[var(--chip-radius)] bg-bg-elevated px-1 py-px text-[length:var(--text-badge)] font-medium uppercase tracking-wide text-text-muted"
      title="This account was deleted"
    >
      deleted
    </span>
  );
}

/**
 * A text author name that CARRIES its deleted state (#task:1792). Every surface
 * with a visible text author name renders it through this ONE primitive, so a
 * `deleted` author always shows the quiet `DeletedActorMarker` beside its
 * snapshot name and no surface can hand-assemble the name while forgetting the
 * state. `active` / `unresolved` render the bare label (an unresolved author is
 * "Unknown …", never marked deleted).
 *
 * `className` styles the NAME span (font weight / color / truncation) so each
 * surface keeps its own typographic role; the marker's own scale is fixed.
 */
export function AuthorName({
  presentation,
  className,
}: {
  presentation: AuthorPresentation;
  className?: string;
}): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className={cn('min-w-0 truncate', className)}>
        {presentation.label}
      </span>
      {presentation.isDeleted ? <DeletedActorMarker /> : null}
    </span>
  );
}

/** A runtime-free neutral square for a deleted / unresolved agent — the same
 *  `data-avatar-ground` silhouette + `size × 0.6` glyph ratio as the other
 *  fallbacks so it carries equal visual mass in a mixed list, but a generic
 *  `Bot` glyph that reveals no runtime. */
function NeutralAgentAvatar({
  size,
  className,
  title,
}: {
  size: number;
  className?: string;
  title?: string;
}): JSX.Element {
  const inner = Math.round(size * 0.6);
  return (
    <span
      data-avatar-ground
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-none align-middle text-text-muted',
        className,
      )}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden
    >
      <Bot style={{ width: inner, height: inner }} />
    </span>
  );
}
