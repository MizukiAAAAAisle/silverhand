import type { MessageAuthorDto } from '@silverhand/shared';

/**
 * The ONE author-presentation seam (#task:1792). Every surface that renders a
 * message/thread author — byline, avatar, thread repliers, reply preview, saved
 * / search rows, attachment source, selection export, activity preview — turns
 * the server-authoritative {@link MessageAuthorDto} into this presentation via
 * `presentAuthor`, instead of re-joining the live directory by `from_*_id` and
 * guessing "deleted" from a directory miss.
 *
 * WHY server-authoritative: `messages.from_agent_id` / `from_user_id` are
 * `ON DELETE SET NULL`, so a hard-deleted actor's rows lose the live-join
 * identity source and every historical byline degrades to a generic "@agent".
 * The DTO carries a send-time snapshot so `deleted` authors stay nameable, and
 * makes the active/deleted/unresolved distinction a fact from the server — the
 * renderer never infers deletion from a missing roster row.
 *
 * Three states, locked by the DTO's discriminated union:
 *  - `active`     — actor row still exists; current identity (rename/avatar/
 *                   runtime propagate live). Agent → runtime-branded avatar;
 *                   user → their avatar/initials. Navigable to the profile.
 *  - `deleted`    — actor hard-deleted; the send-time snapshot names it. Quiet
 *                   "deleted" marker + a kind-generic neutral avatar (no bytes
 *                   are snapshotted, no runtime is leaked). NOT navigable — the
 *                   actor is gone, there is no profile to open.
 *  - `unresolved` — FK null AND no snapshot (a legacy row deleted before the
 *                   snapshot columns, or a loader fault). Neutral "Unknown
 *                   agent/user" by kind, NO deleted marker (we can prove the
 *                   identity is unrecoverable, not that it was deleted), NOT
 *                   navigable, and NON-grouping (see {@link authorGroupKey}).
 */

/**
 * The `unresolved` labels, exported so a surface OUTSIDE this seam can borrow
 * the word instead of re-typing it (@Paul, #task:2065).
 *
 * The borrower is the sender picker, whose selected agent can stop resolving in
 * the viewer's directory. It deliberately says the WEAKER thing there — a
 * directory miss proves "not resolvable here", never "deleted" — and its whole
 * licence for that is that this is already the product's word for exactly that
 * claim. A hand-typed copy would let the two drift while the borrowed-word
 * justification silently stayed in the comment, so the sharing is structural.
 */
export const UNRESOLVED_AGENT_LABEL = 'Unknown agent';
export const UNRESOLVED_USER_LABEL = 'Unknown user';

type ActiveAgentAuthor = Extract<
  MessageAuthorDto,
  { status: 'active'; kind: 'agent' }
>;

/** How the byline avatar should render. `active` arms resolve the image bytes
 *  from the author's own id (fed into a same-session object-url batch keyed by
 *  that id — never the roster). `deleted`/`unresolved` get a kind-generic
 *  neutral glyph: no runtime, no fetch. */
export type AuthorAvatar =
  | { variant: 'agent'; id: string; runtime: ActiveAgentAuthor['runtime'] }
  | { variant: 'user'; id: string }
  | { variant: 'neutral-agent' }
  | { variant: 'neutral-user' };

export interface AuthorPresentation {
  /** The name to render. NEVER derived from a `.trim()` on a possibly-null
   *  field — `unresolved` has no name, so it is branched off first. */
  label: string;
  kind: 'agent' | 'user';
  status: 'active' | 'deleted' | 'unresolved';
  /** Only `deleted` shows the quiet "deleted" marker. `unresolved` does NOT —
   *  an unrecoverable identity is not the same claim as a deleted one. */
  isDeleted: boolean;
  /** The actor id for click-to-profile, or null when not navigable. Only
   *  `active` authors are navigable: a `deleted` actor has no profile to open,
   *  and `unresolved` has no id. */
  navigableId: string | null;
  avatar: AuthorAvatar;
}

/**
 * Resolve a {@link MessageAuthorDto} into its presentation. Pure. Branches on
 * `status` FIRST so the null-everything `unresolved` arm never reaches a
 * `.trim()` on a null name (the discriminated union already makes that a type
 * error; this ordering keeps it a runtime impossibility too).
 */
export function presentAuthor(author: MessageAuthorDto): AuthorPresentation {
  if (author.status === 'unresolved') {
    return {
      label: author.kind === 'agent' ? UNRESOLVED_AGENT_LABEL : UNRESOLVED_USER_LABEL,
      kind: author.kind,
      status: 'unresolved',
      isDeleted: false,
      navigableId: null,
      avatar:
        author.kind === 'agent'
          ? { variant: 'neutral-agent' }
          : { variant: 'neutral-user' },
    };
  }
  // `active` | `deleted` — both carry a non-null id + name.
  const label = author.display_name.trim() || author.name;
  if (author.status === 'deleted') {
    return {
      label,
      kind: author.kind,
      status: 'deleted',
      isDeleted: true,
      navigableId: null,
      avatar:
        author.kind === 'agent'
          ? { variant: 'neutral-agent' }
          : { variant: 'neutral-user' },
    };
  }
  return {
    label,
    kind: author.kind,
    status: 'active',
    isDeleted: false,
    navigableId: author.id,
    avatar:
      author.kind === 'agent'
        ? { variant: 'agent', id: author.id, runtime: author.runtime }
        : { variant: 'user', id: author.id },
  };
}

/**
 * The actor-row precondition, made explicit and checkable (#task:1792, Alice +
 * Cindy). `MessageDto.author` has two distinct absent forms that must NEVER be
 * conflated:
 *   - `from_kind === 'system'` → the message has NO actor identity. The resolver
 *     returns `author: null` for it by contract (no synthetic system tombstone).
 *   - a non-system row → the server ALWAYS resolves an author; `unresolved` is
 *     itself a RESOLVED answer — a genuinely unrecoverable actor (`id === null`).
 *
 * So a non-system row whose `author` is null is neither: it is a carrier that
 * failed to hydrate — a PRECONDITION BREACH, reported as `missing` and never
 * coerced into an `unresolved` actor (which would manufacture the claim "this
 * actor is unrecoverable" out of "we failed to load it"). `null` is not
 * `unresolved`; `system` is not an actor. A row whose raw `from_kind` disagrees
 * with the resolved `author.kind` (an agent row carrying a user author, or vice
 * versa) is a corrupt combination — the two would drive viewer alignment and
 * displayed identity from conflicting facts — so it fails closed to `missing`
 * (`kind-mismatch`) rather than rendering as an actor. Consumers that render
 * only actor rows (MessageItem) treat anything but `actor` as the breach it is,
 * rather than papering over it with a fabricated identity.
 */
export type RowAuthor =
  | { kind: 'system' }
  | { kind: 'actor'; author: MessageAuthorDto }
  | { kind: 'missing'; reason: 'absent' | 'kind-mismatch' };

export function classifyRowAuthor(
  fromKind: 'agent' | 'user' | 'system',
  author: MessageAuthorDto | null,
): RowAuthor {
  if (fromKind === 'system') return { kind: 'system' };
  if (author === null) return { kind: 'missing', reason: 'absent' };
  if (author.kind !== fromKind) return { kind: 'missing', reason: 'kind-mismatch' };
  return { kind: 'actor', author };
}

/**
 * The author's identity as a single plain string that CARRIES the deleted
 * state — for surfaces that cannot show the visual `DeletedActorMarker`:
 * an avatar-only face (the state rides its `title`/`alt`) and frozen exports
 * (transcript text / screenshot), where there is no hover to recover it later.
 *
 * `deleted` appends a quiet suffix; `active`/`unresolved` read as their plain
 * label (an unresolved author is "Unknown …" — NEVER "(deleted account)", since
 * we can prove the identity is unrecoverable, not that it was deleted). This is
 * the ONE place that phrasing lives, so text/avatar/export surfaces never
 * hand-assemble the deleted suffix and can never diverge on it.
 */
export function authorStateLabel(presentation: AuthorPresentation): string {
  return presentation.isDeleted
    ? `${presentation.label} (deleted account)`
    : presentation.label;
}

/**
 * The avatar-byte sources for a set of authors, split by kind (#task:1792 B2).
 * ONLY `active` authors contribute — they are the only arm that carries an
 * `avatar_url`; `deleted` snapshots no bytes and `unresolved` has no id, so both
 * render a neutral glyph with no fetch. Deduped by id (one author repeated down
 * a list resolves once). This is the single place a surface turns its own author
 * DTO set into an avatar batch, so the bytes for a byline can NEVER come from the
 * live directory (a source the DTO's name did not come from). Returns the plain
 * `{ id, avatar_url }` shape the agent/user object-url batch hooks accept.
 */
export interface AuthorAvatarSources {
  agents: { id: string; avatar_url: string | null }[];
  users: { id: string; avatar_url: string | null }[];
}

export function collectAuthorAvatarSources(
  authors: ReadonlyArray<MessageAuthorDto | null>,
): AuthorAvatarSources {
  const agents = new Map<string, string | null>();
  const users = new Map<string, string | null>();
  for (const author of authors) {
    // Only the active arm carries bytes; deleted/unresolved/system never enter
    // the batch (they render a neutral glyph, no fetch).
    if (author === null || author.status !== 'active') continue;
    if (author.kind === 'agent') agents.set(author.id, author.avatar_url);
    else users.set(author.id, author.avatar_url);
  }
  return {
    agents: Array.from(agents, ([id, avatar_url]) => ({ id, avatar_url })),
    users: Array.from(users, ([id, avatar_url]) => ({ id, avatar_url })),
  };
}

/**
 * Consecutive-message grouping key. `active`/`deleted` aggregate by their
 * stable id (all rows from one now-deleted actor resolve to the same `deleted`
 * key, so they still group under one byline). `unresolved` returns `null` and
 * NEVER groups: two lost actors are not provably the same author, so folding
 * them into one byline is a false fact. System rows (author === null) also
 * return null — they are not an author byline.
 *
 * Consumers MUST NOT compare keys with `null === null`; use
 * {@link isSameAuthorGroup}, which treats a null key as "always a fresh group".
 */
export function authorGroupKey(author: MessageAuthorDto | null): string | null {
  if (author === null || author.status === 'unresolved') return null;
  return `${author.kind}:${author.id}`;
}

/**
 * Whether two adjacent messages share one author group. Encapsulates the
 * "unresolved / system never merges" rule in one tested place so no consumer
 * accidentally merges two null-keyed rows into a single byline.
 */
export function isSameAuthorGroup(
  a: MessageAuthorDto | null,
  b: MessageAuthorDto | null,
): boolean {
  const keyA = authorGroupKey(a);
  return keyA !== null && keyA === authorGroupKey(b);
}
