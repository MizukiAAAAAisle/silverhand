import { REFERENCE_PREFIX, parseReference, type Reference } from '@silverhand/shared';

/**
 * #task:2001 — which arm of the `a` override a link destination takes, for the
 * canonical reference scheme only.
 *
 * Extracted as a pure function because the decision is BEHAVIOUR, not painting:
 * one of the three outcomes renders a chip, one renders inert text, and the
 * third hands the href back to the caller — whose last arm calls
 * `window.silverhand.openExternal(href)`. Reading that branch off rendered DOM
 * would mean inferring an IPC call from a class name, so the branch is data and
 * the fence tests it directly.
 *
 * The scheme test is case-INSENSITIVE while {@link parseReference} is
 * case-sensitive, and the asymmetry is the whole point: admitting
 * `SILVERHAND://agent/Alice` here is what keeps it from falling through to the
 * opener, and the strict parser then refuses it as a chip. Fail-closed in both
 * directions from one comparison.
 */
export type ReferenceHrefArm =
  /** A reference written as a bare autolink whose destination
   *  {@link parseReference} accepts: draw the member chip. */
  | { readonly arm: 'reference'; readonly reference: Reference }
  /** Our scheme, but not a reference this renderer draws — a malformed
   *  destination, or a spelling other than a bare autolink. Render the authored
   *  text inertly. Never a link — the destination is internal. */
  | { readonly arm: 'inert' }
  /** Not this scheme. The caller's remaining arms decide. */
  | { readonly arm: 'other' };

/** Whether this href is spelled in the reference scheme, ignoring scheme case
 *  (URI schemes are case-insensitive; handles are not). Also the admission test
 *  for `urlTransform`, which must let the scheme survive sanitization or the
 *  arms below can never see it. */
export function isReferenceScheme(href: string): boolean {
  return (
    href.slice(0, REFERENCE_PREFIX.length).toLowerCase() === REFERENCE_PREFIX
  );
}

/**
 * hast property `remarkRefs` stamps on a link node it produced itself, or on a
 * reference it admitted as a bare autolink. Provenance, not content.
 *
 * WHY PROVENANCE MUST NOT LIVE IN THE HREF (@Cindy, #task:2001). The first
 * implementation carried this signal as an internal URL scheme wrapped around
 * the destination. A message body is attacker input, so a string prefix proves
 * nothing: an author could write `[anything](silverhand-ref:silverhand://agent/
 * Alice)` by hand and get the chip that spelling is supposed to be denied. A
 * `data.hProperties` flag has exactly one writer — the remark pass — because
 * nothing in a Markdown body can reach mdast metadata (raw HTML is escaped; we
 * do not register `rehype-raw`).
 *
 * WHY ONLY AUTOLINKS ARE STAMPED (shiki, 2026-08-13, ruling C). Display could
 * afford to be wider than the addressing side, and briefly was: it chipped any
 * link whose visible text equalled its destination. But the two axes then
 * disagreed about `[silverhand://agent/Alice](silverhand://agent/Alice)` — a chip
 * that addresses nobody — and a chip that means "addressed" in one spelling and
 * "not addressed" in another cannot be read. Sharing the addressing side's syntax
 * test instead makes the anti-spoof property STRUCTURAL rather than a
 * hand-written rule: an autolink's visible text IS its destination, so a chip can
 * no longer replace authored text that named someone else. The plain `@handle`
 * alias is untouched by this and stays what it has always been — a display
 * affordance that addresses nobody: it yields no canonical reference, so no
 * mention notification, no thread follow / CC, and no directed framing in an
 * agent's stdin. On the main line it says nothing about whether the message
 * reaches a channel member — that fanout never reads references; inside a thread
 * it does cost something, because a reference is what adds a referenced member
 * to the follower set this reply is planned against (@shiki, @Cindy, 2026-08-13).
 *
 * The value is the boolean `true` and the predicate below compares against it
 * exactly: one writer, one reader, no coercion in between.
 */
export const PLUGIN_LINK_PROP = 'data-sh-plugin-link';

/** The part of the hast node react-markdown hands a component that carries
 *  provenance. Everything else about the node is irrelevant here. */
export interface PluginLinkNode {
  readonly properties?: Readonly<Record<string, unknown>> | null | undefined;
}

/** Whether `remarkRefs` produced or vouched for this link node. False for every
 *  link an author wrote, which is what keeps the internal schemes from being
 *  hand-forgeable. */
export function isPluginLink(
  node: PluginLinkNode | null | undefined,
): boolean {
  return node?.properties?.[PLUGIN_LINK_PROP] === true;
}

export function classifyReferenceHref(
  href: string | null | undefined,
  node?: PluginLinkNode | null | undefined,
): ReferenceHrefArm {
  if (typeof href !== 'string' || !isReferenceScheme(href)) {
    return { arm: 'other' };
  }
  // Our scheme without provenance: a labelled link, a reference link, or a
  // hand-written destination the remark pass declined to stamp. Inert either
  // way — clickable would hand an internal scheme to the OS, and a chip would
  // read as addressed while the addressing side records no reference here.
  if (!isPluginLink(node)) return { arm: 'inert' };
  const reference = parseReference(href);
  return reference ? { arm: 'reference', reference } : { arm: 'inert' };
}
