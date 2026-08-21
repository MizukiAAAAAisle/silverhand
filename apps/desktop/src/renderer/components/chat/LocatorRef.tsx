import { AtSign, Hash } from 'lucide-react';
import type { Locator } from '@silverhand/shared';
import { ThreadIcon } from '@/components/icons/conversation-icons';
import { useDirectPairs } from '@/features/direct-pairs/hooks';
import {
  locatorChannelListWorkspaceId,
  resolveLocatorTarget,
  resolveLocatorWorkspaceId,
  type LocatorTarget,
} from '@/features/conversations/locator-target';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from '@/features/me/hooks';
import {
  useArchivedChannelsForWorkspace,
  useChannelsForWorkspace,
  useWorkspaces,
} from '@/features/workspaces/hooks';
import { buildLocatorTargetUrl, useNav } from '@/router';
import { faceLabel } from './ConversationRef';
import { INLINE_REF_HOVER_CLASS } from './inline-ref-chip';

/**
 * Inline rendering of a `silverhand://` LOCATOR — a coordinate for a container
 * (#task:2119 / #task:2120), as opposed to a reference, which addresses a person.
 *
 * WHAT IT DRAWS (shiki, 2026-08-21). One sigil per segment, all of equal weight:
 * the workspace wears a serif `W`, a channel `#`, a DM pair `@`, a thread the
 * product's thread glyph followed by the fixed word "thread". There is NO
 * separator character between segments — each segment's own glyph is its left
 * delimiter, which is why the chip stays readable without borrowing the URI's
 * slashes. The two handles of a pair are joined by `&`, which is unambiguous
 * because the handle charset cannot contain one. The whole coordinate sits inside
 * ONE filled block — the same box the sibling `#conv:` chip draws — so a
 * multi-segment locator reads as a single interactive object; see `LocatorChip`.
 *
 * EVERY SEGMENT THE LOCATOR SPELLS IS DRAWN, including a workspace the reader is
 * already in. The chip is a COORDINATE, so dropping a segment because it happens to
 * match the current context would make two different locators render identically and
 * make the same locator change shape as the reader navigates.
 *
 * THE TEXT COMES FROM THE PARSE, never from the resolved row (@Alice, `locator.ts`):
 * "a chip labelled from the resolved row's endpoints instead of from these parsed
 * handles would swap its two names the moment the locator became navigable". So
 * resolution decides ink and pointer only — the words are the author's, and they do
 * not move.
 *
 * THREE OUTCOMES, and only the last two are this component's:
 *   - a destination the grammar refuses is not a chip at all — it stays the literal
 *     text the author typed (`classifyReferenceHref`), silently;
 *   - a locator the viewer cannot open draws an INERT box: same shape, same glyphs,
 *     same size, the accent wash swapped for a neutral fill and the ink for muted,
 *     no pointer, no click. One state for "no such name", "two such names", "not
 *     your workspace" and "not your DM" — telling them apart is exactly the
 *     existence oracle the design refuses;
 *   - a navigable locator draws the accent-wash box. Closed or archived keeps the
 *     box and dims it, as `ChannelRef` does: the container is still reachable.
 */

/** Live locator chip. Resolves against the viewer's own caches — see
 *  `locator-target.ts` for why that is a lookup rather than a request.
 *
 *  COST. Three of the four reads are viewer-global lists the app already holds
 *  mounted, so a stream of chips adds no traffic to them. The fourth is one
 *  workspace's channel tables, asked ONLY by a channel locator and only once its
 *  workspace resolved ({@link locatorChannelListWorkspaceId}); React Query dedupes it
 *  per workspace and `eventWsClient.subscribe` is ref-counted, so N chips naming one
 *  workspace cost one read and one WS scope. A channel locator naming a workspace the
 *  viewer is not currently looking at does open that scope for as long as the message
 *  is on screen — bounded by what is visible, and released on unmount. */
export function LocatorRef({ locator }: { locator: Locator }): JSX.Element {
  const nav = useNav();
  const workspaces = useWorkspaces().data ?? [];
  const workspaceId = resolveLocatorWorkspaceId(locator, workspaces);
  const channelListId = locatorChannelListWorkspaceId(locator, workspaceId);
  // `workspaceResolved` is TRUE BY CONSTRUCTION here and never a guess: the only
  // non-null value this can carry came from a row in the viewer's workspace list.
  const live = useChannelsForWorkspace(channelListId, channelListId !== null);
  const archived = useArchivedChannelsForWorkspace(
    channelListId,
    channelListId !== null,
  );
  const viewer = useViewerUser();
  const pairs = useDirectPairs();
  // The viewer's HANDLE, and only when the viewer record is a real one: the three
  // non-user arms of `ViewerState` describe the app's own state, not a person, so
  // none of them can be an endpoint of a DM. Cold or degraded reads as "not an
  // endpoint" → inert sigil, which is the fail-closed direction.
  const viewerHandle =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
    && !isUpdateRequired(viewer.data)
      ? viewer.data.name
      : null;

  const target = resolveLocatorTarget(locator, {
    workspaceId,
    // Both tables, because an archived channel is still the channel that name
    // points at. Concatenated rather than merged: the two lists are disjoint by
    // construction (a channel sits in exactly one of them), and a duplicate would
    // read as ambiguity and go inert.
    channels: [...(live.data ?? []), ...(archived.data ?? [])],
    viewerHandle,
    pairs,
  });

  return (
    <LocatorChip
      locator={locator}
      target={target}
      onOpen={t => nav.go(buildLocatorTargetUrl(t))}
    />
  );
}

/**
 * Export / static-render locator chip: always the inert sigil.
 *
 * The static path renders outside the query layer, so there is nothing to resolve
 * against — and an export is read where the app is not, where no coordinate is
 * navigable. Drawing the inert form is therefore honest rather than degraded: the
 * reader still gets the full coordinate, which is the whole point of a locator.
 */
export function LocatorRefStaticChip({
  locator,
}: {
  locator: Locator;
}): JSX.Element {
  return <LocatorChip locator={locator} target={null} onOpen={undefined} />;
}

function LocatorChip({
  locator,
  target,
  onOpen,
}: {
  locator: Locator;
  target: LocatorTarget | null;
  onOpen: ((target: LocatorTarget) => void) | undefined;
}): JSX.Element {
  const tooltip = locatorTooltip(locator);
  const body = <LocatorSegments locator={locator} />;
  // Both states are the SAME box the sibling `#conv:` chip draws
  // (`ConversationRef`): a filled, radiused, padded block, so the whole
  // coordinate reads as ONE object instead of a run of loose words wearing two
  // colours (shiki dogfood, 2026-08-21 — the flat form read as "grey workspace +
  // accent channel", two controls). The state lives entirely in fill + ink:
  // navigable is the faint accent wash under accent ink, inert is a neutral fill
  // under one muted ink. Nothing is coloured per-segment — that split was the
  // bug, and the box now carries "these belong together" on its own.
  const shared =
    'inline-flex max-w-[280px] items-center gap-1 rounded-[var(--chip-radius)] px-1.5 -mx-0.5 align-baseline font-medium';

  if (!target || !onOpen) {
    return (
      <span
        className={`${shared} bg-bg-elevated text-text-muted`}
        title={tooltip}
        data-locator-ref={locator.kind}
        data-locator-navigable="false"
      >
        {body}
      </span>
    );
  }
  const dim = target.kind === 'channel' && target.closed;
  return (
    <span
      role="button"
      tabIndex={0}
      className={
        `${shared} cursor-pointer bg-accent-soft text-accent focus-outline ` +
        INLINE_REF_HOVER_CLASS +
        (dim ? ' opacity-60' : '')
      }
      title={tooltip}
      data-locator-ref={locator.kind}
      data-locator-navigable="true"
      onClick={event => {
        // The default action would follow the anchor's SANITIZED href, which is a
        // second navigation authority and the wrong one — see
        // `buildLocatorTargetUrl`.
        event.preventDefault();
        event.stopPropagation();
        onOpen(target);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(target);
      }}
    >
      {body}
    </span>
  );
}

/** The sigil + label pairs, in the order the locator spells them. */
function LocatorSegments({ locator }: { locator: Locator }): JSX.Element {
  if (locator.kind === 'workspace') {
    return <WorkspaceSegment name={locator.workspace.name} />;
  }
  if (locator.kind === 'channel') {
    return (
      <>
        <WorkspaceSegment name={locator.workspace.name} />
        <Segment
          sigil={<Hash className="size-3 shrink-0 self-center" />}
          label={locator.channel.title}
        />
        {locator.threadRootId !== null && <ThreadSegment />}
      </>
    );
  }
  return (
    <>
      <Segment
        sigil={<AtSign className="size-3 shrink-0 self-center" />}
        // `&` joins the pair rather than a slash: the two handles are one
        // coordinate, not a path, and neither of them can contain this character.
        label={`${locator.endpoints[0]} & ${locator.endpoints[1]}`}
      />
      {locator.threadRootId !== null && <ThreadSegment />}
    </>
  );
}

/** The workspace's sigil is a flat serif `W` — a letter, not the rail's ink badge
 *  (shiki, 2026-08-21). The badge is the workspace's identity primitive where it
 *  IS the subject; inside a coordinate every segment has to weigh the same, and a
 *  filled badge beside a hairline `#` does not. Segment ink is not set here: the
 *  chip is one colour end to end (see `LocatorChip`), so a leading workspace reads
 *  as context through its position and sigil, not through a colour demotion that
 *  would split the coordinate back into two voices. */
function WorkspaceSegment({ name }: { name: string }): JSX.Element {
  return (
    <Segment
      sigil={
        <span
          aria-hidden
          className="shrink-0 self-center font-serif text-[length:var(--text-badge)] font-semibold leading-none"
        >
          W
        </span>
      }
      label={name}
    />
  );
}

/** The thread leaf. shiki, 2026-08-21: the glyph is followed by the fixed word
 *  "thread" — a root message id is not a name, so the segment says what it is
 *  instead of showing an opaque id the reader cannot check. */
function ThreadSegment(): JSX.Element {
  return <Segment sigil={<ThreadIcon className="size-3 shrink-0 self-center" />} label="thread" />;
}

function Segment({
  sigil,
  label,
}: {
  sigil: JSX.Element;
  label: string;
}): JSX.Element {
  // Segments align to EACH OTHER on their label's text baseline, not on a
  // synthesized flex baseline. The chip itself is baseline-aligned to the prose
  // line by the family rule (`.markdown-body [data-locator-ref]`, global.css), so
  // it takes ITS baseline from these segments; when each segment was
  // `items-center` its baseline was synthesized from content, and a serif-`W`
  // sigil vs an SVG sigil synthesized to different heights — the segments sat
  // ~2.7px apart (shiki dogfood, measured over CDP). `items-baseline` here makes
  // every segment expose its label baseline instead, which is identical across
  // segments (one font, one size), so the multi-segment block reads as one line
  // and the chip still sits on the prose baseline. The sigil keeps `self-center`
  // (see the call sites) so the glyph stays centred against its label — the same
  // baseline-container + centred-icon idiom the family rule uses for a chip.
  return (
    <span className="inline-flex min-w-0 items-baseline gap-0.5">
      {sigil}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The coordinate in words, for the pointer tooltip and the accessible name. The
 *  container words are the ones every other conversation surface uses
 *  ({@link faceLabel}), so a locator names a channel the same way a `#conv:` chip
 *  does; a thread renames the whole coordinate because the thread IS what a
 *  thread-bearing locator points at. */
function locatorTooltip(locator: Locator): string {
  if (locator.kind === 'workspace') return `Workspace · ${locator.workspace.name}`;
  const [kind, path] =
    locator.kind === 'channel'
      ? [faceLabel('channel'), `${locator.workspace.name} / ${locator.channel.title}`]
      : [
          faceLabel('direct_line'),
          `${locator.endpoints[0]} & ${locator.endpoints[1]}`,
        ];
  return locator.threadRootId === null
    ? `${kind} · ${path}`
    : `Thread · ${path}`;
}
