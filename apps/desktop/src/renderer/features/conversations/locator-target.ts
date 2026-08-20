import {
  canonicalizeStoredConversationTitle,
  canonicalizeStoredWorkspaceName,
  type DirectPairListItem,
  type Locator,
} from '@silverhand/shared';
import {
  isAgentSpace,
  type WorkspaceOwnership,
} from '../workspaces/workspace-ownership';

/**
 * #task:2120 — what a locator chip may NAVIGATE to, decided from the viewer's own
 * caches and nothing else.
 *
 * PURE, and separate from the chip, because navigability is BEHAVIOUR: it decides
 * whether a coordinate in prose becomes a live control or an inert sigil, and every
 * arm of that decision is a product ruling rather than a class name. The chip paints
 * what this module returns; asserting the rulings through rendered DOM would test
 * the painting instead.
 *
 * A LOCATOR RESOLVES THROUGH A LIVE NAME (shiki, 2026-08-21 — see `locator.ts`), so
 * resolution is a LOOKUP, never a request: the workspace segment is matched against
 * the workspaces this viewer can already see, the channel segment against that
 * workspace's channel list, the DM endpoints against the viewer's own complete pair
 * list. No endpoint is asked "does this exist", which is what keeps the chip from
 * being an existence oracle for containers the viewer has no business knowing about.
 *
 * NON-NAVIGABLE IS ONE OUTCOME, deliberately. A name nobody bears, a name two
 * objects bear, a channel in a workspace the viewer is not in, a DM between two other
 * principals — all of them return `null` and draw the same inert sigil. Splitting
 * them into distinct states would answer, from the renderer, precisely the questions
 * the parse/resolution split exists to leave unanswered (`locator.ts`: a missing
 * object and an unauthorized one "degrade identically, or the pair would be an
 * existence oracle").
 *
 * A THREAD IS NOT RESOLVED HERE. Its root id is carried through opaquely and
 * navigability is the CONTAINER's — the thread pane renders its own not-found state,
 * exactly as `buildTaskOpenUrl` is "dumb about resolution". Asking whether a root
 * message exists would add a request per chip to answer a question the destination
 * already answers.
 */

/** A workspace row as resolution reads it — the viewer's own list. Structural on
 *  purpose: `ViewerWorkspaceDto` satisfies it, and so does a test literal.
 *
 *  OWNERSHIP IS PART OF THE ROW, not an optional extra (@Cindy, #task:2120 review):
 *  the name a locator spells only names a REGULAR workspace, so a row that cannot
 *  answer "is this an Agent Space" cannot participate in resolution at all. */
export interface LocatorWorkspaceRow extends WorkspaceOwnership {
  readonly id: string;
  readonly name: string;
}

/** A conversation row as resolution reads it. Live and archived channels are the
 *  same shape and both participate — an archived channel is still the channel that
 *  name points at, and the chip dims rather than dies (`ChannelRef` precedent). */
export interface LocatorChannelRow {
  readonly id: string;
  readonly title: string;
  readonly closed_at?: number | null;
  readonly archived_at?: number | null;
}

/** Where a navigable locator points. `null` from {@link resolveLocatorTarget} is
 *  the inert sigil — see this module's docblock for why it is a single outcome. */
export type LocatorTarget =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | {
      readonly kind: 'channel';
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly threadRootId: string | null;
      /** The channel is closed or archived: still navigable, drawn quieter. */
      readonly closed: boolean;
    }
  | {
      readonly kind: 'direct_pair';
      readonly conversationId: string;
      readonly threadRootId: string | null;
    };

/** Everything resolution reads, gathered by the chip's hooks. `workspaceId` is the
 *  output of {@link resolveLocatorWorkspaceId} — the two-phase shape is real, not a
 *  convenience: the channel list cannot be asked for before its workspace has a
 *  concrete id. */
export interface LocatorFacts {
  readonly workspaceId: string | null;
  readonly channels: readonly LocatorChannelRow[];
  /** The viewer's own handle, or `null` while the viewer record is cold. */
  readonly viewerHandle: string | null;
  readonly pairs: readonly DirectPairListItem[];
}

/**
 * The workspace a locator's first segment names, or `null`.
 *
 * FOLDED, not compared byte-for-byte: the store enforces workspace-name uniqueness
 * on a fold key, so two spellings that differ only by case or width ARE the same
 * name and a locator written in either must reach the same workspace. The fold is
 * the store's own function, so the two cannot disagree about what a name is; no DTO
 * publishes the key, which is why it is recomputed here rather than read.
 *
 * ONLY REGULAR WORKSPACES ARE IN THIS NAMESPACE (@Cindy, #task:2120 review). The
 * uniqueness index the fold implements covers `owner_agent_id IS NULL` only, so an
 * Agent Space is not a name this grammar can spell — and letting one in breaks the
 * decision twice: alone it makes a coordinate navigable that names nothing, and
 * beside a same-named regular workspace it manufactures the ambiguity below and
 * demotes the one legitimate target. The exclusion asks the renderer's single
 * ownership authority (`isAgentSpace`), never a local `owner_agent_id` test — a bare
 * nullability check at a classifying read point is the drift that predicate exists to
 * prevent (`workspace-ownership.ts`).
 *
 * TWO MATCHES IS NO MATCH. Within the regular namespace the index makes that
 * unreachable, so it is a fence rather than a live case: if a list ever holds two,
 * the assumption behind this fold no longer holds and picking either would send a
 * reader somewhere the author did not name — the same reason `ChannelRef` degrades an
 * ambiguous `#name` to inert text rather than guessing.
 */
export function resolveLocatorWorkspaceId(
  locator: Locator,
  workspaces: readonly LocatorWorkspaceRow[],
): string | null {
  if (locator.kind === 'direct_pair') return null;
  const key = locator.workspace.key;
  let found: string | null = null;
  for (const row of workspaces) {
    if (isAgentSpace(row)) continue;
    if (canonicalizeStoredWorkspaceName(row.name).key !== key) continue;
    if (found !== null) return null;
    found = row.id;
  }
  return found;
}

/**
 * Which workspace's channel list this locator needs, or `null` for none.
 *
 * The admission gate for the second phase, exported because "does this chip issue a
 * request at all" is a cost decision and a fence belongs on it: a `workspace` or `dm`
 * locator must not mount a channel query, and a `channel` locator must not mount one
 * before its workspace resolved. Both are silent when wrong — the chip still renders
 * correctly, it just pays for a list it never reads.
 */
export function locatorChannelListWorkspaceId(
  locator: Locator,
  workspaceId: string | null,
): string | null {
  return locator.kind === 'channel' ? workspaceId : null;
}

/**
 * The endpoint of a DM locator that is NOT the viewer, or `null` when the locator is
 * not a DM or the viewer is not one of its two endpoints.
 *
 * THE VIEWER MUST BE AN ENDPOINT. A `direct_pair` between two other principals is
 * not a container this viewer has a door to — there is no route that could open it,
 * and there is nothing to look it up in (the pair list is the viewer's own). So it
 * draws an inert sigil, which is also what keeps a DM locator posted in a public
 * channel from telling everyone whether those two have ever talked.
 *
 * BOTH POSITIONS ARE CHECKED because the parsed pair is sorted by handle, not by
 * viewer — the locator grammar has no "me" slot and neither does the aggregate's
 * order (`locator.ts`: the two orders flip whenever the agent's handle sorts after
 * the human's).
 *
 * BYTE IDENTITY, matching `parseLocatorEndpoints`: participant handles have no stored
 * fold key in this product, so inventing one here would create a second authority on
 * who a name is.
 */
export function locatorCounterpartHandle(
  locator: Locator,
  viewerHandle: string | null,
): string | null {
  if (locator.kind !== 'direct_pair' || viewerHandle === null) return null;
  const [first, second] = locator.endpoints;
  if (first === viewerHandle) return second;
  if (second === viewerHandle) return first;
  return null;
}

/**
 * The conversation id of the viewer's line with the locator's other endpoint, or
 * `null`.
 *
 * ONLY AN EXISTING LINE. The pair list is the complete set of pairs the viewer is an
 * endpoint of (`DirectPairListResponseSchema`), so an absence here is decisive and
 * the chip goes inert. It must not fall back to the draft route: a locator is a
 * coordinate someone wrote, and following it into "start a new DM with this person"
 * would turn reading a message into opening a line.
 *
 * A `deleted` counterpart cannot match, because that arm carries no name to match
 * against — nothing about an endpoint is snapshotted. That is the right answer twice
 * over: the handle of a deleted principal is released, so a locator naming it points
 * at whoever holds it now, which is nobody.
 */
export function resolveLocatorPairConversationId(
  locator: Locator,
  viewerHandle: string | null,
  pairs: readonly DirectPairListItem[],
): string | null {
  const handle = locatorCounterpartHandle(locator, viewerHandle);
  if (handle === null) return null;
  for (const pair of pairs) {
    const other = pair.counterpart;
    if (other.status !== 'active') continue;
    if (other.name === handle) return pair.conversation_id;
  }
  return null;
}

/** The channel a locator's second segment names within an already-resolved
 *  workspace, or `null` — folded and ambiguity-refusing for the same reasons as
 *  {@link resolveLocatorWorkspaceId}. Channel titles ARE uniqueness-enforced per
 *  workspace, so two matches means the caller mixed workspaces or passed a list twice
 *  rather than "the product allows it". */
function resolveLocatorChannelRow(
  locator: Locator,
  channels: readonly LocatorChannelRow[],
): LocatorChannelRow | null {
  if (locator.kind !== 'channel') return null;
  const key = locator.channel.key;
  let found: LocatorChannelRow | null = null;
  for (const row of channels) {
    if (canonicalizeStoredConversationTitle(row.title).key !== key) continue;
    if (found !== null) return null;
    found = row;
  }
  return found;
}

/** The whole decision: a target to navigate to, or `null` for the inert sigil. */
export function resolveLocatorTarget(
  locator: Locator,
  facts: LocatorFacts,
): LocatorTarget | null {
  switch (locator.kind) {
    case 'workspace':
      return facts.workspaceId === null
        ? null
        : { kind: 'workspace', workspaceId: facts.workspaceId };
    case 'channel': {
      if (facts.workspaceId === null) return null;
      const row = resolveLocatorChannelRow(locator, facts.channels);
      if (row === null) return null;
      return {
        kind: 'channel',
        workspaceId: facts.workspaceId,
        conversationId: row.id,
        threadRootId: locator.threadRootId,
        closed: row.closed_at != null || row.archived_at != null,
      };
    }
    case 'direct_pair': {
      const conversationId = resolveLocatorPairConversationId(
        locator,
        facts.viewerHandle,
        facts.pairs,
      );
      if (conversationId === null) return null;
      return {
        kind: 'direct_pair',
        conversationId,
        threadRootId: locator.threadRootId,
      };
    }
  }
}
