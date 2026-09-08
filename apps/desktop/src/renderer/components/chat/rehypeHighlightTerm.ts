// Rehype plugin: wrap every case-insensitive literal occurrence of `term`
// in a message body's text with `<mark class="search-hit">`, so the
// in-conversation header find (#task:1335) highlights matched keywords
// INSIDE the rendered markdown — not just plain-text excerpts (that's what
// `SearchPanel.highlightText` does for the advanced-panel list).
//
// It runs AFTER `rehype-highlight`, and deliberately:
//  - descends INTO `pre` / `code` subtrees so a keyword that only occurs inside
//    a code fence or inline code still gets marked. The backend search predicate
//    is a dumb raw-`content LIKE` substring match (it does not parse markdown),
//    so a code-only hit is a real returned+jumpable message — the invariant
//    "命中 ⟹ 可高亮" (highlightable set ⊇ backend match set) requires the
//    renderer, as the sole rendering authority, to mark ANY substring position,
//    code included (#task:1335, Cindy gate-2 / Alice bounded-context call);
//  - marks only whole text nodes, never restructuring the `<span class="hljs-*">`
//    tokens `rehype-highlight` already produced (the `const` text node inside
//    `<span class="hljs-keyword">` is wrapped in place; the span is untouched);
//  - skips existing `mark` nodes, so it stays idempotent;
//  - matches a LITERAL substring, mirroring the backend `LIKE '%term%'`.
//
// Accepted degradation: a match STRADDLING two nodes (e.g. `st fo` across
// `<span>const</span> foo`, or a markdown syntax char the renderer dropped) is
// not marked — per-text-node coverage satisfies the invariant for the common
// case without re-flattening the rendered tree.
//
// Written as a self-contained hast walk (mirroring `remarkRefs` in
// `Markdown.tsx`) rather than pulling in `unist-util-visit`, since the tree
// shape we touch is trivial and node mutation during a visit is fiddly.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Only `mark` is skipped — descending into it would double-wrap (breaking
// idempotency). `pre` / `code` are intentionally NOT skipped (see header).
const SKIP_TAGS = new Set(["mark"]);

export interface HighlightTermOptions {
  term: string;
}

export function rehypeHighlightTerm(options: HighlightTermOptions) {
  const term = options.term.trim();
  return (tree: unknown): void => {
    if (!term) return;
    walk(tree as HastNode, term.toLowerCase(), term.length);
  };
}

function walk(node: HastNode, needleLower: string, needleLen: number): void {
  if (!node.children || node.children.length === 0) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "element" && child.tagName && SKIP_TAGS.has(child.tagName)) {
      next.push(child);
      continue;
    }
    if (child.type === "text" && typeof child.value === "string") {
      const split = splitTextNode(child.value, needleLower, needleLen);
      if (split) {
        next.push(...split);
        continue;
      }
      next.push(child);
      continue;
    }
    walk(child, needleLower, needleLen);
    next.push(child);
  }
  node.children = next;
}

// Split one text node on every case-insensitive occurrence of the needle,
// wrapping each hit in a `<mark class="search-hit">`. Returns null when the
// needle doesn't occur (so the caller keeps the original node untouched).
function splitTextNode(text: string, needleLower: string, needleLen: number): HastNode[] | null {
  const hay = text.toLowerCase();
  let idx = hay.indexOf(needleLower);
  if (idx === -1) return null;
  const out: HastNode[] = [];
  let from = 0;
  while (idx !== -1) {
    if (idx > from) out.push({ type: "text", value: text.slice(from, idx) });
    out.push({
      type: "element",
      tagName: "mark",
      properties: { className: ["search-hit"] },
      // Preserve the ORIGINAL casing of the matched span, not the needle's.
      children: [{ type: "text", value: text.slice(idx, idx + needleLen) }],
    });
    from = idx + needleLen;
    idx = hay.indexOf(needleLower, from);
  }
  if (from < text.length) out.push({ type: "text", value: text.slice(from) });
  return out;
}
