import { AtSign, Hash } from 'lucide-react';
import { HoverPopover } from './HoverPopover';
import { INLINE_REF_HOVER_CLASS } from './inline-ref-chip';
import {
  useConversationIdentity,
  type ConversationIdentity,
  type ConversationIdentityStatus,
} from '@/features/conversations/conversation-identity';
import { presentCounterpart } from '@/features/direct-pairs/counterpart-presentation';

/**
 * A conversation from a WORKSPACE-SCOPED channel list — the synchronous fast
 * path for `#conv:` chips. The name carries the invariant because the shape
 * cannot: `{id, title}` structurally admits any conversation, yet every
 * consumer of this map draws `face='channel'` without asking (see
 * `StaticConversationRef` in `Markdown.tsx`).
 *
 * Read "channel" here as WORKSPACE-PLACED, not open-roster: an agent space's
 * fixed-roster `dm_channel` is workspace-placed, belongs in this map, and drawing
 * it as `#` is correct (#task:1373 / #task:2073). Roster answers a capability
 * question; placement answers the identity one.
 *
 * Why that is sound, physically rather than by convention, on both ends: the
 * single place a `direct_pair` row is minted
 * (`ConversationRepo.getOrCreateDirectPair`) writes `workspace_id` as a literal
 * NULL, so no workspace-scoped query can return one; and this map has exactly one
 * producer (the current workspace's channel list in `App.tsx`). A private line
 * therefore cannot enter it (#task:2077).
 *
 * Two falsifiers, both of which would silently MIS-LABEL rather than fail: a
 * pair acquiring a `workspace_id`, or this map being fed from a list that is not
 * workspace-scoped. Either one turns a private line into a `#` channel chip, so
 * a new producer must prove its list is workspace-scoped before assigning here.
 */
export interface WorkspaceChannelReference {
  id: string;
  title: string;
}

interface ConversationRefProps {
  /** Raw conversation id from `#conv:<id>`. */
  id: string;
  /** Current-workspace metadata when available. Acts as a synchronous
   *  fast path — avoids a brief loading flash on chips that point at a
   *  channel already in the current workspace's lookup map. The
   *  authoritative source is `useConversationIdentity(id)` below, which
   *  also handles cross-workspace refs and private lines the lookup map
   *  can't see. */
  conversation: WorkspaceChannelReference | undefined;
  onOpen?: (id: string) => void;
}

/** What the chip draws: the reference's own identity primitive, never a glyph
 *  borrowed from another entity. A workspace conversation is a channel and wears
 *  `#` whatever its roster policy is (#task:1373 — an agent-home `dm_channel` is
 *  still a channel, and reading it as a DM is the vocabulary collision #task:2044
 *  settles); a `direct_pair` is addressed as a person and wears `@`.
 *
 *  This type is the ONLY input to the word and the glyph ({@link faceLabel} /
 *  {@link conversationIcon}), and `roster_policy` is deliberately not on it: a
 *  second derivation keyed on the roster is how the static chip came to draw `@`
 *  for an agent space's fixed-roster channel while this one drew `#` for the same
 *  id (#task:2073). Both chips consume these two functions. */
export type ConversationRefFace = 'channel' | 'direct_line';

/**
 * Inline rendering of a `#conv:<conversation_id>` reference.
 *
 * Unlike `#name`, this is id-addressed and intentionally clickable even
 * when metadata is unavailable: the side pane can surface the unresolved
 * placeholder instead of silently dropping a reference.
 *
 * Resolution: `useConversationIdentity(id)` is the authoritative source. It
 * composes the two identity faces — `GET /api/conversations/:id/ref` for a
 * workspace conversation in ANY workspace, and the viewer's own complete
 * direct-pair list for a private line, whose 404 from the ref face is the
 * correct answer rather than a gap (#task:2038). The optional `conversation`
 * prop is a synchronous fast path that avoids a loading flash when the id is
 * already in the current-workspace channels map (PR-2 review by @Cindy on
 * commit 3 — the prop alone fails for any cross-workspace `#conv:<id>` since
 * the map is workspace-scoped).
 *
 * Cost of putting this on every chip: the pair list is ONE viewer-global entry
 * whose observers never trigger a re-read (`DIRECT_PAIRS_QUERY_POLICY`), so a
 * stream of chips adds no requests to it; the ref face is keyed per id, retried
 * at most twice, and not requested at all for an id the pair list already names.
 *
 * Hover ≥500ms surfaces a popover with the conversation's full
 * metadata. Loading shows a skeleton; a decided non-resolution renders an
 * explicit "unavailable" body so we never sit on a forever-skeleton popover.
 */
export function ConversationRef({
  id,
  conversation,
  onOpen,
}: ConversationRefProps): JSX.Element {
  const resolution = useConversationIdentity(id);
  // Prefer the prop (current-workspace fast path) over the resolution; both
  // describe the same conversation, the prop just avoids a loading flash for the
  // common case. It can only ever name a workspace channel — the map it comes
  // from is workspace-scoped.
  const resolved: { face: ConversationRefFace; title: string } | null =
    conversation
      ? { face: 'channel', title: conversation.title }
      : resolution.status === 'resolved'
        ? presentIdentity(resolution.identity)
        : null;
  // Three-state for popover purposes:
  //   - 'resolved'    → render real metadata
  //   - 'unavailable' → a decided non-resolution (403 / 404 / a failed private-
  //                     line read), render explicit body (NOT skeleton — a
  //                     forever-skeleton popover is what Cindy review of
  //                     `45fca42` flagged on cross-workspace ids)
  //   - 'loading'     → skeleton via HoverPopover.isContentReady=false
  const popoverStatus: 'resolved' | 'unavailable' | 'loading' = resolved
    ? 'resolved'
    : resolution.status === 'loading'
      ? 'loading'
      : 'unavailable';

  const label = resolved ? resolved.title : `#conv:${shortConversationId(id)}`;
  const tooltip = resolved
    ? `${faceLabel(resolved.face)} · ${resolved.title}`
    : `Open conversation #conv:${id}`;
  const icon = conversationIcon(resolved?.face);
  // Unresolved fallback (`#conv:<short>`) is pure ASCII → mono so the id
  // segment reads as the structured atom it is. Resolved labels surface
  // the human-readable title which may contain CJK, so they stay sans —
  // mono CJK fallback (PingFang etc.) looks uneven next to ASCII chars.
  // See forza6 font split spec (msg vWYNLYq_Wtw6P4rj).
  const chipBody = (
    <>
      {icon}
      <span className={resolved ? 'truncate' : 'truncate font-mono'}>
        {label}
      </span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
      // Wrapped in HoverPopover below — `aria-label` instead of the
      // native `title` attribute. macOS browsers schedule the native
      // tooltip on a 2-3s cycle that competes with Radix HoverCard
      // (the OS tooltip overlays the trigger area, mouse "leaves" the
      // trigger → popover closes; mouseenter reopens after the 500ms
      // grace, producing a periodic flicker — @shiki report
      // `NbcXUOnFDKfXYRxV`).
      aria-label={tooltip}
      data-conversation-ref={id}
    >
      {chipBody}
    </span>
  );

  const interactiveChip = (
    <span
      role="button"
      tabIndex={0}
      className={
        'inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded-[var(--chip-radius)] bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent focus-outline ' +
        // The resting soft fill stays — it is this chip's identity as a BOX
        // (an opaque id, not running text). Only the hover fill is gone: a
        // soft→solid flip plus an ink inversion is a whole new surface for a
        // pointer event, where the family now just darkens the ink.
        INLINE_REF_HOVER_CLASS
      }
      aria-label={tooltip}
      data-conversation-ref={id}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpen?.(id);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen?.(id);
      }}
    >
      {chipBody}
    </span>
  );

  const popoverContent =
    popoverStatus === 'resolved' && resolved ? (
      <ConversationPopoverBody
        id={id}
        face={resolved.face}
        title={resolved.title}
      />
    ) : popoverStatus === 'unavailable' ? (
      <UnresolvedConversationPopoverBody id={id} reason={resolution.status} />
    ) : null;

  return (
    <HoverPopover
      trigger={onOpen ? interactiveChip : inertChip}
      content={popoverContent}
      isContentReady={popoverStatus !== 'loading'}
    />
  );
}

/**
 * Popover body for resolved conversation refs — kind, full title, and
 * the id (small + monospace) so the user can eyeball-match the
 * reference if needed.
 */
function ConversationPopoverBody({
  id,
  face,
  title,
}: {
  id: string;
  face: ConversationRefFace;
  title: string;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded-[var(--chip-radius)] bg-bg-elevated px-1 py-0.5 text-[length:var(--text-badge)] font-medium uppercase tracking-wide text-text-muted">
          {faceLabel(face)}
        </span>
      </div>
      <p className="line-clamp-2 break-words text-xs font-medium text-text-primary">
        {title}
      </p>
      <p
        className="truncate font-mono text-[length:var(--text-badge)] text-text-muted"
        aria-label={id}
      >
        {id}
      </p>
    </div>
  );
}

/**
 * Popover for refs no face could resolve — clicking the chip still opens the
 * side pane (which renders its own placeholder), so the popover only documents
 * the id and the reason we couldn't resolve. Visible state is "decided" —
 * `isContentReady=true` — so the user gets a clear "unavailable" message instead
 * of a forever-skeleton. Cindy review of commit 3.
 *
 * The `unauthorized` line names no LEVEL. A 403 from `/ref` is not evidence of
 * a missing workspace, and once the gate is public-aware (#task:1692) most of
 * what remains is same-workspace: a private channel, an archived public one, a
 * DM the viewer isn't in. Telling a workspace member they lack workspace access
 * is a false statement about the one thing they can check.
 *
 * `not_found` may claim deletion because it rests on the direct-pair list's
 * completeness contract; `unresolved` (that read failed) may not — see
 * `resolveConversationIdentity`.
 */
function UnresolvedConversationPopoverBody({
  id,
  reason,
}: {
  id: string;
  reason: ConversationIdentityStatus;
}): JSX.Element {
  const message =
    reason === 'unauthorized'
      ? "You don't have access to this conversation."
      : reason === 'not_found'
        ? 'Conversation not found — it may have been deleted.'
        : 'Couldn’t resolve this conversation.';
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">{message}</p>
      <p
        className="truncate font-mono text-[length:var(--text-badge)] text-text-muted"
        aria-label={id}
      >
        {id}
      </p>
    </div>
  );
}

export function shortConversationId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

/** A resolved identity as the chip renders it. A `direct_pair` has no title of
 *  its own — the counterpart IS its name, resolved by the one rule every DM
 *  surface uses. */
function presentIdentity(identity: ConversationIdentity): {
  face: ConversationRefFace;
  title: string;
} {
  if (identity.placement === 'direct_pair') {
    return {
      face: 'direct_line',
      title: presentCounterpart(identity.pair.counterpart).label,
    };
  }
  return { face: 'channel', title: identity.ref.title };
}

export function faceLabel(face: ConversationRefFace): string {
  return face === 'direct_line' ? 'Direct message' : 'Channel';
}

export function conversationIcon(face: ConversationRefFace | undefined): JSX.Element {
  if (face === 'direct_line') {
    return <AtSign className="size-3 shrink-0 self-center" />;
  }
  return <Hash className="size-3 shrink-0 self-center" />;
}
