// A stream's NAMES at render time — the row becomes an address
// (#task:2021 P4-4).
//
// The exact inverse of `delivery-target-resolution.ts`: that module turns an
// address into a stream, this one turns a stream into what may be SPELLED for it.
// Both are needed and neither derives the other, because the two directions do not
// have the same domain — a title the current name domain would refuse still names a
// row (so it must resolve), and yet must not be emitted as an address (so it must
// not render). Keeping them as two rules that meet at the codec is what makes that
// asymmetry statable instead of a bug in one shared function.
//
// THE ONE PROPERTY THIS MODULE EXISTS TO GUARANTEE. A `named` answer promises that
// the token `formatStreamAddressToken` builds from it RESOLVES BACK to this row, and
// QUOTES the name the product displays for it:
//
//   1. the stored display string parses under the CURRENT domain — so there is a
//      canonical form to spell at all, and
//   2. that canonical form is BYTE-IDENTICAL to what is stored, and
//   3. re-folding it reproduces the STORED KEY — the column the resolver actually
//      looks up by.
//
// (3) is the one that cannot be dropped, and it is not implied by (1) and (2): a
// half state (`title_key ≠ fold(title)`) is what `conversation-title-audit.ts` and
// `workspace-name-audit.ts` exist to DETECT and fail boot on, and while one exists
// an address built from the title would resolve to nothing at all. Such a row
// therefore renders `#conv:<id>` with reason `unrenderable` — a permanent form that
// always works — rather than an address the reader cannot use. Fail closed, on the
// rendering side, where the cost is a less pretty header instead of an
// undeliverable reply. This module does NOT re-implement the audits' verdict: it
// asks the narrower question "may I spell this row", which the ROUND TRIP answers
// on its own, so there is no fourth copy of the half-state definition here.
//
// (2) is the one that is STRICTER THAN RESOLUTION, deliberately. A stored title of
// `" design "` or one in NFD parses, folds to the same key, and its canonical
// spelling would resolve straight back to this row — so (2) is not buying
// deliverability. It buys the header being a QUOTE: the target a reader compares
// against the title in the UI is the stored string itself, never a tidied variant of
// it. Without that, the render path would silently normalize away exactly the rows
// the audits exist to surface, and the only visible symptom would be a header whose
// name does not match the one on screen.
//
// WHAT IS NOT A FALLBACK. `direct_pair` is not counted (`AddressFallbackReason` says
// why) — neither its first-person `dm:@handle` label nor the id form it falls back to
// when this viewer is not an endpoint of the pair: it has no name form BY DESIGN, so
// counting it would bury the three real reasons under traffic no naming machinery
// could remove.
//
// LOOKUPS ARE PREDICATES, NOT PORTS — the style `conversation-placement.ts` sets
// and for the same reason: the rule stays a pure function of the row, so the fanout
// can memoize the two reads per framing while the tests state the policy directly.
import {
  directPairEndpointsOf,
  isWorkspacePlaced,
  parseConversationTitle,
  parseWorkspaceName,
  type ConversationEndpointIdentity,
  type ConversationEndpointRef,
  type StreamNaming,
} from '@silverhand/shared';
import { isAgentHomeWorkspace } from '@silverhand/shared';

/**
 * The columns naming reads: the placement arc, plus the display title and the
 * stored fold of it.
 *
 * Structural, so `ConversationRepo.addressFacts`'s projection satisfies it
 * unchanged. Both the title and its KEY are here because property (3) above is
 * about the key — a shape carrying only the display string could not state the
 * guarantee, only hope for it.
 */
export interface StreamNamingConversation extends ConversationEndpointRef {
  id: string;
  workspace_id: string | null;
  title: string;
  title_key: string | null;
}

/** The address root as this rule needs it — `WorkspaceRepo.addressRoot`'s
 *  projection. `name_key === null` is the agent-home case (#task:2027), and
 *  `owner_agent_id` is what says WHY (see {@link workspaceNaming}). */
export interface StreamNamingRoot {
  owner_agent_id: string | null;
  name: string;
  name_key: string | null;
}

export interface StreamNamingLookups {
  /** The workspace this conversation is placed in. `null` is treated as an
   *  unrenderable row rather than thrown: a framing pass must still deliver. */
  rootOf(workspaceId: string): StreamNamingRoot | null;
  /** The current handle of a `direct_pair` endpoint, or `null` when that
   *  principal is gone. A deleted handle is RELEASED and may be reused
   *  (#task:2028), which is precisely why the label is rendered per framing from
   *  the live registry and never stored. */
  handleOf(endpoint: ConversationEndpointIdentity): string | null;
}

/**
 * How this stream may be spelled FOR THIS VIEWER — total, and the one policy that
 * decides it.
 *
 * The viewer is an agent because the only consumer is the runtime stdin header,
 * and it matters only for the pair arm: `dm:@handle` names the OTHER endpoint, so
 * the same row renders two different tokens for its two participants. A viewer who
 * is not an endpoint of a pair gets `id_only` rather than a guess — the shorthand
 * is first-person and there is no first person to read it in.
 *
 * Throws only where {@link directPairEndpointsOf} does (a `direct_pair` row with a
 * missing endpoint coordinate, which the placement arc CHECK cannot produce). That
 * stays a throw rather than degrading to `id_only` so there is ONE verdict on a
 * malformed pair across the ACL, the write gate and rendering.
 */
export function streamNamingOf(
  conversation: StreamNamingConversation,
  viewer: { agentId: string },
  lookups: StreamNamingLookups,
): StreamNaming {
  if (isWorkspacePlaced(conversation)) {
    return workspaceNaming(conversation, lookups.rootOf(conversation.workspace_id));
  }
  const endpoints = directPairEndpointsOf(conversation);
  if (endpoints === null) return { kind: 'id_only' };
  // Which endpoint is the OTHER one is decided by finding the viewer, not by
  // eliminating them: a viewer who is not an endpoint has no other side, and
  // `find(not viewer)` would have handed them the first endpoint of somebody
  // else's DM. A self-pair cannot exist (`canonicalEndpointOrder` refuses one), so
  // "the viewer is a" and "the viewer is b" are exclusive.
  const [a, b] = endpoints;
  const isViewer = (endpoint: ConversationEndpointIdentity): boolean =>
    endpoint.kind === 'agent' && endpoint.id === viewer.agentId;
  const other = isViewer(a) ? b : isViewer(b) ? a : null;
  if (other === null) return { kind: 'id_only' };
  const otherHandle = lookups.handleOf({ kind: other.kind, id: other.id });
  return otherHandle === null
    ? { kind: 'id_only' }
    : { kind: 'direct_pair', otherHandle };
}

/**
 * The workspace arm: two names, each of which must survive the round trip of
 * properties (1)–(3), and one reason when either does not.
 *
 * `agent_home` is decided by the ROOT's own ownership and not by the
 * conversation's placement, because the reason answers "does this stream have an
 * address root at all" — and a workspace with no home agent whose `name_key` is
 * somehow NULL is corruption, not privacy, so it must not be reported as the
 * benign reason.
 *
 * Two columns, ONE question plus a TRIPWIRE: schema CHECKs tie `name_key IS NULL`
 * and `owner_agent_id IS NOT NULL` to each other, so the `unrenderable` arm below
 * is UNREACHABLE for any row the DB accepted, today and after the column swap. It
 * stays because it is the only place a row that violated that pairing (a rebuilt
 * table that lost the CHECK) would be caught instead of silently reported as a
 * private container. Nothing in the domain can produce that state — do not write
 * handling for it elsewhere.
 */
function workspaceNaming(
  conversation: StreamNamingConversation,
  root: StreamNamingRoot | null,
): StreamNaming {
  const unrenderable = { kind: 'unnameable', reason: 'unrenderable' } as const;
  if (root === null) return unrenderable;
  if (root.name_key === null) {
    return isAgentHomeWorkspace(root)
      ? { kind: 'unnameable', reason: 'agent_home' }
      : unrenderable;
  }
  if (conversation.title_key === null) return unrenderable;
  const workspace = parseWorkspaceName(root.name);
  if (
    !workspace.ok
    || workspace.value.name !== root.name
    || workspace.value.key !== root.name_key
  ) {
    return unrenderable;
  }
  const title = parseConversationTitle(conversation.title);
  if (
    !title.ok
    || title.value.title !== conversation.title
    || title.value.key !== conversation.title_key
  ) {
    return unrenderable;
  }
  return { kind: 'named', workspace: workspace.value, title: title.value };
}
