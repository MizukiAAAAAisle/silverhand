import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { PLAIN_MENTION_PATTERN } from './api/message.js';
import { ENTITY_NAME_MAX_LENGTH } from './api/name.js';
import {
  formatReferenceToken,
  mayContainReference,
  parseReference,
  type Reference,
  type ReferenceKind,
} from './reference.js';

/**
 * #task:2000 — the POSITION half of the reference contract: which references in
 * a message body carry mention semantics.
 *
 * Behind its own subpath export (`@silverhand/shared/reference-markdown`) and
 * deliberately NOT re-exported from the package barrel: this is the only module
 * in `@silverhand/shared` that pulls in a Markdown parser, and the barrel is
 * imported by the CLI and the daemon, which never need it.
 *
 * ONE AUTHORITY. Every consumer of "who is addressed" — viewer `mention_self`
 * notifications, thread auto-follow, mention CC, and the runtime's
 * directed-vs-broadcast framing — calls {@link extractMessageReferences} and
 * nothing else. The set it returns is the definition of "who this message
 * addresses"; there is no second lexical scan anywhere, and the result is never
 * persisted (a stored copy would be a second authority that can disagree with the
 * body it came from).
 *
 * NOT the main-line delivery gate. An ordinary channel message reaches every
 * member whatever this returns — that fanout is membership, and a human send's
 * start-idle sweep does not read references either. What references DO drive, in
 * four distinct layers:
 *
 *   1. main line — nothing. Fanout and runtime start ignore them.
 *   2. thread reply — a referenced channel member becomes a follower BEFORE the
 *      reply's follower-gated recipient plan is computed, so here a reference can
 *      widen who receives it.
 *   3. mention CC — a referenced agent gets a wrapped copy in its Mentions DM.
 *   4. after arrival — human notification/unread, and the wake batch's framing.
 *
 * What an empty set costs depends on the layer, and the answer is NOT uniform:
 *
 *   - main line — targeting only. The message still reaches every member and
 *     still starts every idle one; what is lost is the notification, the CC, and
 *     the aim.
 *   - thread reply — possibly delivery itself. Without the reference the person
 *     the author named never becomes a follower, so the follower-gated recipient
 *     plan can leave them out of a reply that was written AT them.
 *   - once a recipient IS in the batch — framing. A user message with no
 *     references is "for everyone", so that recipient gets the UNDIRECTED
 *     broadcast directive instead of one aimed at its subject; only a NON-empty
 *     set that omits the recipient frames the batch as somebody else's.
 *
 * So never describe this predicate as the gate on whether a channel message is
 * delivered or whether an agent runs — and equally never as never deciding who
 * receives anything.
 *
 * The module also owns the INVERSE, {@link rewriteShorthandReferences}: which
 * positions the composer may rewrite a plain `@handle` INTO a reference before
 * send (#task:2001). The two belong together because they are one predicate read
 * in two directions — a rewrite in a position the extractor won't read changes
 * the stored bytes and addresses nobody, which is the exact silent failure
 * this design exists to remove. Keeping them in one file makes the rewritable
 * set a DERIVED subset of the prose set rather than a second list to maintain.
 */

/**
 * The coordinate system the parser's offsets are expressed in, derived from the
 * value the parser was given.
 *
 * `fromMarkdown` removes ONE leading U+FEFF from its input and does not adjust the
 * positions it reports, so every offset in the document is expressed against
 * `original.slice(1)`. Both consumers here index text BY those offsets — the
 * autolink discriminator slices it, the shorthand scan tests containment against it
 * — so indexing the original value made a BOM-prefixed body address nobody and made
 * the composer silently drop its last `@handle`.
 *
 * THE PARSER ALWAYS EATS THE ORIGINAL (@Cindy, review of the first fix). This
 * function describes a coordinate origin; it does not choose the parser's input.
 * Removing the whole leading RUN and parsing that instead looked equivalent — the
 * offsets line up either way — but it silently reclassifies content as prefix: the
 * parser drops one BOM and SEES the rest, so `\uFEFF\uFEFF` + four spaces is a
 * paragraph (the surviving BOM opens the line), while the same value with both
 * removed is an indented CODE BLOCK. Same reference, opposite answer. So exactly one
 * character comes off here, and any survivor stays in `body`, where the parser
 * counted it.
 *
 * LEADING ONLY, and U+FEFF only. A BOM anywhere else was never dropped and shifts
 * nothing. This is not whitespace handling and not normalization — widening it (a
 * trim, a Unicode normalize, ZWSP/NBSP) would change which bytes a body is made of.
 *
 * Callers that only READ use `body` and ignore `prefix`. The one caller that
 * REWRITES splices `body` and puts `prefix` back verbatim, so no byte is lost and
 * the stored value differs from the author's only where a handle was rewritten.
 */
function parserCoordinates(value: string): { prefix: string; body: string } {
  return value.charCodeAt(0) === 0xfeff
    ? { prefix: value.slice(0, 1), body: value.slice(1) }
    : { prefix: '', body: value };
}

/**
 * Node types whose subtree is not prose, and therefore cannot address anyone.
 *
 * - `code` / `inlineCode` — quoted syntax. A reference shown as an EXAMPLE (in
 *   this repo's own docs, in an agent explaining the syntax, in the platform
 *   prompt quoted back) must not summon its subject. This is also what lets
 *   `inlineCode()` stay a safe way to interpolate an arbitrary user-chosen label
 *   into agent-facing prose.
 * - `blockquote` — someone else's words. Quoting a message re-states its
 *   references verbatim, and quoting is the normal way to reply; re-delivering
 *   to everyone named in the quote would make every reply a broadcast.
 *
 * Nothing else needs an entry, because the autolink predicate below already
 * excludes it structurally: raw `html` and `image` destinations never produce a
 * `link` node, and a reference link (`[x][id]` + a `definition`) is by
 * construction not an autolink, so no definition table is collected at all.
 */
const NON_PROSE_TYPES: ReadonlySet<string> = new Set([
  'code',
  'inlineCode',
  'blockquote',
]);

/**
 * The references a message body addresses, deduplicated, in first-occurrence
 * order.
 *
 * The predicate is a CONJUNCTION, and both halves must hold:
 *
 *   1. the node is a CommonMark autolink — `<silverhand://agent/Alice>` — in
 *      prose position, and
 *   2. {@link parseReference} accepts its destination.
 *
 * Anything else — `[Alice](silverhand://human/shiki)`, a reference link, an
 * uppercase scheme, a destination with a query or a trailing path segment —
 * addresses nobody. Fail-closed in both directions: a body that misses either
 * half addresses no one.
 *
 * WHY autolinks only, when a label-carrying link renders identically? Because
 * the label is a place to hide a different identity, and the surfaces where that
 * lie is visible are not the surfaces that make the decision. Agent stdin,
 * `message history`, `message search` and every export see the RAW body, where
 * the label is what a reader's eye lands on and the destination is what
 * addressed. Admitting labels would mean the product's only spoofable identity
 * surface is also an addressing one. An autolink cannot lie: its text IS its
 * destination. The renderer refuses the same shape for a reason of its own
 * (#task:2001, shiki 2026-08-13): WITHIN this scheme it chips exactly what this
 * function admits, so a `silverhand://` spelling cannot look addressed without
 * being addressed. The plain `@handle` alias stays outside that equivalence —
 * it renders as a chip and addresses nobody, permanently and by design.
 *
 * mdast does not record which syntax produced a `link`: `<url>` and `[url](url)`
 * yield field-identical nodes. So the discriminator is an exact slice between the
 * node's own offsets, compared against the reconstructed autolink — taken from the
 * string the PARSER measured ({@link parserCoordinates}), which is not always the
 * value the caller passed. Offsets, never `position.end.column` arithmetic —
 * a column is only equal to a byte count on the first line of a document, and
 * the interesting case is always mid-paragraph. The slice is sound because
 * `mdast-util-from-markdown` copies an autolink's destination verbatim into
 * `url` (no entity decoding, no percent-normalization), so a body whose
 * destination survives {@link parseReference} also survives the comparison.
 *
 * Parsed as plain CommonMark, without the GFM extensions the renderer enables:
 * GFM adds CONTAINERS and emphasis forms, not link syntaxes that could produce
 * our scheme (its literal autolinks only fire for `www.`/`http`/`https`/`mailto`/
 * `xmpp`), so the accepted destination set is identical either way.
 *
 * The plain `@handle` alias is deliberately absent — it is a rendering
 * compatibility affordance and never a delivery.
 */
export function extractMessageReferences(content: string): Reference[] {
  // No Markdown parse at all for the overwhelming majority of bodies. Sound
  // because the parser's accepted set is prefixed by the literal this tests for.
  if (!mayContainReference(content)) return [];

  const tree = fromMarkdown(content);

  const out: Reference[] = [];
  const seen = new Set<string>();

  // Iterative walk: a body may legally nest containers thousands of levels deep
  // within the content cap, so recursion here would be a stack overflow on the
  // send path.
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (NON_PROSE_TYPES.has(node.type)) continue;
    if (node.type === 'link') {
      // Children are the label. In an autolink they are a copy of the
      // destination, and in every other link form they are exactly the part we
      // refuse to read — so identity comes from the destination or nowhere.
      if (isAutolink(node, content)) {
        const ref = parseReference(node.url);
        if (ref) {
          const key = `${ref.kind}/${ref.handle}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(ref);
          }
        }
      }
      continue;
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i]!);
      }
    }
  }
  return out;
}

/**
 * A `link` node reduced to what the autolink question needs: its destination and
 * its span in the source it was parsed from. Structural so both mdast's `Link`
 * and the renderer's own loose node type satisfy it without either importing the
 * other's types.
 */
export type LinkSpan = {
  readonly url?: string | undefined;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
};

/**
 * Whether this `link` node was written as a CommonMark autolink, decided by
 * slicing the document it was parsed from. A node without offsets or without a
 * destination is refused rather than guessed at — `fromMarkdown` always positions
 * its nodes, so the absence would mean a synthetic tree, which is not a body
 * anyone sent.
 *
 * `source` is THE VALUE THE PARSER WAS GIVEN — the whole document, exactly as it
 * arrived. The coordinate adjustment the offsets need lives inside this function
 * ({@link parserCoordinates}), which is why callers need to know nothing about it:
 * the parser expresses its positions against the input minus one leading U+FEFF, so
 * a naive slice of the original is one character out for every link in the
 * document, and this predicate then answers `false` for perfectly well-formed
 * autolinks — silently, leaving a body that addresses nobody and renders no chip.
 *
 * SHARED BETWEEN THE TWO AXES, and only at this layer (@Cindy, #task:2001):
 * delivery and display both ask "was this written as `<dest>`?", so asking it
 * twice would be two implementations of one syntax fact — and a body's bytes
 * would then be able to mean different things to the reader and to the fanout.
 * That is also why the adjustment belongs HERE rather than in each caller: the
 * renderer hands over its own document and gets the same answer as the fanout,
 * without a second copy of this correction to keep in step.
 * What is NOT shared is POSITION policy: delivery refuses code spans and
 * blockquotes ({@link extractMessageReferences}), while the renderer chips inside
 * both, because quoting a message must keep looking like the message. Each axis
 * names its own position rule; this function knows nothing about either.
 */
export function isAutolink(node: LinkSpan, source: string): boolean {
  const url = node.url;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (url === undefined || start === undefined || end === undefined) {
    return false;
  }
  return parserCoordinates(source).body.slice(start, end) === `<${url}>`;
}

/**
 * Resolve a bare handle to the principal kind it names, or `null` for "nobody
 * here by that name". The composer supplies this from the conversation's
 * workspace roster; returning `null` is what leaves the shorthand untouched.
 */
export type ShorthandResolver = (handle: string) => ReferenceKind | null;

/**
 * Node types whose subtree the composer must not rewrite. A SUPERSET of
 * {@link NON_PROSE_TYPES}, derived from it so the subset relation is structural:
 * a position the extractor refuses to read must never be rewritten (the rewrite
 * would change the stored body and deliver to nobody), so every non-prose type
 * is automatically non-rewritable.
 *
 * The two additions are about nesting rather than semantics: CommonMark links do
 * not nest, so an autolink written inside a link label or a reference label
 * would not parse as a link at all — the destination would survive as visible
 * text in someone else's link.
 */
const NON_REWRITABLE_TYPES: ReadonlySet<string> = new Set([
  ...NON_PROSE_TYPES,
  'link',
  'linkReference',
]);

/**
 * One plain `@handle` occurrence the composer may rewrite: an exact source range
 * plus the handle it names. Everything about it is decided from the body alone —
 * position, grammar, length, escaping — EXCEPT whether anyone by that name is
 * here, which is the resolver's job and the caller's.
 */
type ShorthandMatch = {
  readonly start: number;
  readonly end: number;
  readonly handle: string;
};

/**
 * Every rewritable plain `@handle` occurrence in the body, in source order.
 *
 * Positions come from the mdast tree, but the MATCHING is done against the
 * source text, never against node values: a `text` node's `value` is decoded
 * (`&commat;alice` arrives as `@alice`, a backslash escape is dropped), so
 * value offsets do not map back onto source offsets. Matching the source and
 * keeping only matches that fall inside an admitted `text` range gives both the
 * real document context for the boundary lookbehind and an exact splice range —
 * and it makes an entity-encoded `@` a non-match for free, which is correct:
 * `&commat;alice` is not the alias form.
 *
 * Takes the ORIGINAL value and PARSES it — block structure is decided by the whole
 * document — while every offset it returns belongs to the parser's coordinate body
 * ({@link parserCoordinates}), which is also what the regex scans so the two agree.
 * A caller that spliced the original with these ranges would be one character out
 * for every document that began with a BOM, which is how the last `@handle` in such
 * a body came to be dropped.
 */
function collectShorthandMatches(source: string): ShorthandMatch[] {
  // Fast path, mirroring `mayContainReference` on the delivery side but keyed on
  // the OTHER spelling: no `@` anywhere means nothing to rewrite, so an ordinary
  // message never pays for a Markdown parse on the send path.
  if (!source.includes('@')) return [];

  // Plain CommonMark, deliberately the same dialect (and the same call) as the
  // extractor above: the two must agree about block structure, and the extractor
  // is the one that decides delivery. Both hand over the ORIGINAL, so neither can
  // change what the other sees.
  const tree = fromMarkdown(source);
  const { body } = parserCoordinates(source);

  // Admitted `text` ranges in document order. The walk is the extractor's —
  // iterative for the same reason, and pre-order so leaves come out ascending
  // and non-overlapping, which the two-pointer scan below relies on.
  const ranges: Array<readonly [number, number]> = [];
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (NON_REWRITABLE_TYPES.has(node.type)) continue;
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      continue;
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i]!);
      }
    }
  }
  if (ranges.length === 0) return [];

  const re = new RegExp(PLAIN_MENTION_PATTERN, 'g');
  const out: ShorthandMatch[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Both sequences ascend, so the range pointer only ever moves forward. If it
    // somehow did not, the containment test below fails and the match is left
    // alone — the safe direction.
    while (cursor < ranges.length && ranges[cursor]![1] <= start) cursor += 1;
    const range = ranges[cursor];
    if (!range || start < range[0] || end > range[1]) continue;
    if (isEscapedAt(body, start, range[0])) continue;
    const handle = match[1]!;
    // The stored handle domain is grammar AND length; `PLAIN_MENTION_PATTERN`
    // carries only the grammar, so a 300-character run of legal characters would
    // otherwise be rewritten into a destination `parseReference` then rejects.
    if (handle.length > ENTITY_NAME_MAX_LENGTH) continue;
    out.push({ start, end, handle });
  }
  return out;
}

/**
 * Whether the `@` at `at` is backslash-escaped, by CommonMark's rule: count the
 * unbroken run of backslashes before it and read its PARITY. Each pair is itself
 * an escaped backslash, so only an odd run leaves one over to escape the `@`.
 *
 * The parity, not the single preceding character (#task:2001 review, @Cindy). In
 * `\\@Alice` — two source backslashes — the pair collapses to a literal `\` and
 * the `@` is NOT escaped, so mdast's text value is `\@Alice` and the renderer
 * draws its alias chip. Skipping the rewrite there produced a chip that
 * addressed nobody: the exact silent failure this transform exists to remove.
 *
 * An odd run is left alone, and that is not the same bug mirrored. Rewriting it
 * would emit `\<silverhand://…>`, whose `<` is escaped in turn, so the reader
 * would see the raw destination in place of the name the author wrote — the
 * rewrite would both fail to address anyone AND change what the message says.
 * Leaving it puts an escaped `@handle` in the same accepted family as one inside
 * a blockquote: the alias chip still renders, and nobody is addressed.
 *
 * `floor` is the enclosing `text` node's own start offset (@Alice's suggestion),
 * which is the correct scope for the question: a CommonMark escape cannot reach
 * across a node boundary, so backslashes belonging to whatever precedes this node
 * must not join the run. Every neighbouring construct I could build puts a
 * delimiter byte between itself and the `@`, so today the bound changes no
 * answer — it is here so that a future change in parse structure cannot silently
 * make the count read someone else's bytes.
 */
function isEscapedAt(source: string, at: number, floor: number): boolean {
  let run = 0;
  while (at - 1 - run >= floor && source[at - 1 - run] === '\\') run += 1;
  return run % 2 === 1;
}

/**
 * The distinct handles a body would rewrite GIVEN a roster that knows everyone —
 * i.e. the plain shorthands whose delivery depends on the member set, in
 * first-occurrence order.
 *
 * Exists because "the roster has not loaded yet" is not the same fact as "nobody
 * here by that name", and {@link ShorthandResolver} cannot tell the caller which
 * one it just reported (#task:2001 review, @Cindy). A composer that treats the
 * cold window as an empty workspace ships `@Alice` verbatim: the message sends,
 * the chip renders, and Alice is never woken. So the send path asks this first
 * and waits for the authoritative member set when the answer is non-empty.
 *
 * Position-aware for the same reason the rewrite is: a substring test would
 * stall a send over an email address, a `@` in a code span, or someone else's
 * words in a blockquote — none of which could ever have addressed anyone.
 */
export function findShorthandCandidates(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of collectShorthandMatches(source)) {
    if (seen.has(match.handle)) continue;
    seen.add(match.handle);
    out.push(match.handle);
  }
  return out;
}

/**
 * Rewrite every resolvable plain `@handle` in prose position into its canonical
 * autolink, and return the body to store. #task:2001 — the composer's send-time
 * transform, and the only place the two spellings meet.
 *
 * WHY at send rather than at insertion into the draft (shiki's ruling): the
 * textarea shows what the author typed. A picker that inserted
 * `<silverhand://human/shiki>` would make the draft stop resembling the message,
 * which costs every author on every mention to spare a reader who is looking at
 * a raw body. So authoring bytes and stored bytes differ by design; the
 * difference is visible only where raw bodies are (CLI history, copy, export).
 *
 * Fail-closed in the direction that keeps meaning: an unresolvable handle is
 * left exactly as written. It still draws a chip (the display alias) and still
 * addresses nobody — which is the truth, since no participant by that name
 * exists in this workspace. That truth is the caller's to establish: pass a
 * resolver built from an authoritative roster, never from a still-loading one
 * (see {@link findShorthandCandidates}).
 */
export function rewriteShorthandReferences(
  source: string,
  resolve: ShorthandResolver,
): string {
  const { prefix, body } = parserCoordinates(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const { start, end, handle } of collectShorthandMatches(source)) {
    const kind = resolve(handle);
    if (!kind) continue;
    edits.push({ start, end, text: formatReferenceToken({ kind, handle }) });
  }
  // The author's own value, not a reassembled copy of it: nothing was rewritten,
  // so nothing about the bytes may change.
  if (edits.length === 0) return source;

  // Right to left, so each splice leaves the earlier offsets valid. Applied to the
  // string the offsets were measured against; the prefix the parser dropped goes
  // back verbatim, so the result differs from the author's only where a handle was
  // replaced.
  let out = body;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i]!;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return prefix + out;
}
