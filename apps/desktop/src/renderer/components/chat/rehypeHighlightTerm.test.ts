import { describe, expect, it } from 'vitest';
import { rehypeHighlightTerm } from './rehypeHighlightTerm';

// The header find highlights matched keywords INSIDE rendered markdown by
// wrapping literal occurrences in `<mark class="search-hit">` (#task:1335).
// These lock the invariants that keep it safe on real message bodies: it must
// never fracture code tokens, must be case-insensitive while preserving the
// original casing, and must be idempotent (safe to re-run over its own output).

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const text = (value: string): HastNode => ({ type: 'text', value });
const el = (tagName: string, children: HastNode[]): HastNode => ({
  type: 'element',
  tagName,
  properties: {},
  children,
});
const root = (children: HastNode[]): HastNode => ({ type: 'root', children });

function run(tree: HastNode, term: string): HastNode {
  rehypeHighlightTerm({ term })(tree);
  return tree;
}

function marks(node: HastNode): HastNode[] {
  const out: HastNode[] = [];
  const visit = (n: HastNode): void => {
    if (n.type === 'element' && n.tagName === 'mark') out.push(n);
    n.children?.forEach(visit);
  };
  visit(node);
  return out;
}

describe('rehypeHighlightTerm', () => {
  it('wraps a literal occurrence in <mark class="search-hit">', () => {
    const tree = run(root([el('p', [text('the quick fox')])]), 'quick');
    const found = marks(tree);
    expect(found).toHaveLength(1);
    expect(found[0]!.properties?.className).toEqual(['search-hit']);
    expect(found[0]!.children?.[0]?.value).toBe('quick');
  });

  it('is case-insensitive but preserves the original casing', () => {
    const tree = run(root([el('p', [text('Hello HELLO hello')])]), 'hello');
    const found = marks(tree);
    expect(found).toHaveLength(3);
    expect(found.map(m => m.children?.[0]?.value)).toEqual([
      'Hello',
      'HELLO',
      'hello',
    ]);
  });

  it('marks matches inside pre / code so code-only hits still highlight', () => {
    // The backend search is a raw substring match that does not parse markdown,
    // so a keyword occurring only in a code block is a real returned hit and
    // must be highlighted (#task:1335 gate-2). The highlighter descends into
    // code/pre.
    const tree = run(
      root([
        el('p', [text('call foo() here')]),
        el('pre', [el('code', [text('const foo = 1')])]),
      ]),
      'foo',
    );
    // Both the prose occurrence and the one inside <pre><code> are marked.
    expect(marks(tree)).toHaveLength(2);
  });

  it('marks a hljs token text node in place without fracturing the span', () => {
    // rehype-highlight has already tokenised code into <span class="hljs-*">.
    // Marking the token's text node must leave the span structure intact.
    const codeEl = el('code', [
      { type: 'element', tagName: 'span', properties: { className: ['hljs-keyword'] }, children: [text('const')] },
      text(' foo'),
    ]);
    const tree = run(root([el('pre', [codeEl])]), 'const');
    const found = marks(tree);
    expect(found).toHaveLength(1);
    // The mark lives INSIDE the hljs-keyword span, which is preserved.
    const kwSpan = codeEl.children![0]!;
    expect(kwSpan.tagName).toBe('span');
    expect(kwSpan.properties?.className).toEqual(['hljs-keyword']);
    expect(kwSpan.children).toHaveLength(1);
    expect(kwSpan.children![0]!.tagName).toBe('mark');
    expect(kwSpan.children![0]!.children?.[0]?.value).toBe('const');
  });

  it('is idempotent — re-running does not double-wrap', () => {
    const once = run(root([el('p', [text('foo foo')])]), 'foo');
    const twice = run(once, 'foo');
    expect(marks(twice)).toHaveLength(2);
  });

  it('leaves the tree untouched for an empty / whitespace term', () => {
    const tree = run(root([el('p', [text('nothing to mark')])]), '   ');
    expect(marks(tree)).toHaveLength(0);
  });

  it('leaves the tree untouched when the term does not occur', () => {
    const tree = run(root([el('p', [text('nothing to mark')])]), 'zzz');
    expect(marks(tree)).toHaveLength(0);
    expect(tree.children?.[0]?.children?.[0]?.value).toBe('nothing to mark');
  });
});
