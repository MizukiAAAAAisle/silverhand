import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import type { AgentDto, ChannelDto } from '@silverhand/shared';
import { Mention } from './Mention';
import { ChannelRef } from './ChannelRef';

interface MarkdownProps {
  content: string;
  /** Forwarded to inline `<Mention>` so the agent popover can show
   *  per-session presence + retry. Optional — system messages outside
   *  a chat context omit it. */
  sessionId?: string | null;
  /** Lookup by agent `name` (the handle used in @mentions). When
   *  absent, mentions render as plain accent-colored text without the
   *  popover. */
  agentsByName?: Map<string, AgentDto>;
  /** Lookup by channel `name` (the handle used in #refs). */
  channelsByName?: Map<string, ChannelDto>;
}

const MENTION_PREFIX = 'silverhand-mention:';
const CHANNEL_PREFIX = 'silverhand-channel:';

/**
 * Renders message body as Markdown.
 *
 * Security: react-markdown defaults to escaping raw HTML. We do *not*
 * register `rehype-raw`, so agent-provided `<script>` etc. is rendered
 * as text. Links and code blocks are explicitly overridden so we never
 * navigate the renderer window or hand untrusted text to the shell.
 *
 * Mentions: `remarkMentions` rewrites `@handle` text spans into mdast
 * link nodes with a `silverhand-mention:` URL scheme. The `a` override
 * below recognizes that scheme and renders `<Mention>` (with popover)
 * instead of a normal link, so the agent map only needs to be threaded
 * one place.
 */
function MarkdownInner({ content, sessionId, agentsByName, channelsByName }: MarkdownProps): JSX.Element {
  // Plugin instance is recreated per render but is a thin closure;
  // remark instantiates the transformer once per `process` call so
  // the cost is negligible. Memoizing it doesn't help because react-
  // markdown also memoizes the pipeline by reference equality of the
  // plugins array.
  const plugins = useMemo(() => [remarkGfm, remarkRefs], []);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={[rehypeHighlight]}
        // Whitelist our internal mention scheme — react-markdown's
        // default sanitizer drops unknown URL schemes (turning `href`
        // into an empty string), which would cause the `a` override
        // below to miss the prefix check and render an inert link.
        urlTransform={url =>
          url.startsWith(MENTION_PREFIX) || url.startsWith(CHANNEL_PREFIX)
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children, ...rest }) => {
            if (typeof href === 'string' && href.startsWith(MENTION_PREFIX)) {
              const name = href.slice(MENTION_PREFIX.length);
              return (
                <Mention
                  name={name}
                  agent={agentsByName?.get(name)}
                  sessionId={sessionId ?? null}
                />
              );
            }
            if (typeof href === 'string' && href.startsWith(CHANNEL_PREFIX)) {
              const name = href.slice(CHANNEL_PREFIX.length);
              return (
                <ChannelRef name={name} channel={channelsByName?.get(name)} />
              );
            }
            return (
              <a
                {...rest}
                href={href}
                onClick={e => {
                  e.preventDefault();
                  if (href) void window.agentHub.openExternal(href);
                }}
              >
                {children}
              </a>
            );
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children, ...rest }) => (
            <code className={className} {...rest}>
              {children}
            </code>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownInner);

// Walks the mdast tree and replaces inline `@handle` / `#handle`
// substrings inside text nodes with link nodes that carry our
// internal `silverhand-mention:` / `silverhand-channel:` schemes.
// Skipped containers: `inlineCode`, `code`, and existing `link`
// nodes (so a hand-written `[#foo](https://…)` stays intact, and a
// literal `@x` inside `\`@bob\`` doesn't fire). Heading text is
// already extracted into `heading` nodes by the time we run, so a
// markdown `#` line never reaches us.
function remarkRefs() {
  return (tree: unknown): void => {
    walk(tree as MdastNode);
  };
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

function walk(node: MdastNode): void {
  if (!node.children || node.children.length === 0) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'inlineCode' || child.type === 'code' || child.type === 'link') {
      next.push(child);
      continue;
    }
    if (
      child.type === 'text' &&
      typeof child.value === 'string' &&
      (child.value.includes('@') || child.value.includes('#'))
    ) {
      pushSplit(child.value, next);
      continue;
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

// `(?<![\w/])` keeps email addresses (`me@example.com`), paths
// (`a/@b`), URL fragments (`page#anchor`), and issue refs (`PR #123`
// — alpha-first below filters those) out. Handle character class
// mirrors `CreateAgentInputSchema` / `CreateChannelInputSchema` in
// `packages/shared/src/api/dto.ts` (alphanumerics, `-`, `_`).
const REF_RE = /(?<![\w/])([@#])([a-zA-Z][a-zA-Z0-9_-]*)/g;

function pushSplit(text: string, out: MdastNode[]): void {
  let last = 0;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = REF_RE.exec(text)) !== null) {
    any = true;
    if (m.index > last) {
      out.push({ type: 'text', value: text.slice(last, m.index) });
    }
    const sigil = m[1]!;
    const name = m[2]!;
    out.push({
      type: 'link',
      // mdast `link` uses `url`, not `href`. mdast-util-to-hast maps
      // it to the `href` attribute on the rendered `<a>`.
      url: `${sigil === '@' ? MENTION_PREFIX : CHANNEL_PREFIX}${name}`,
      children: [{ type: 'text', value: `${sigil}${name}` }],
    });
    last = m.index + m[0].length;
  }
  if (!any) {
    out.push({ type: 'text', value: text });
    return;
  }
  if (last < text.length) {
    out.push({ type: 'text', value: text.slice(last) });
  }
}

function CodeBlock({ children }: { children: React.ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const lang = extractLang(children);

  const onCopy = useCallback(async () => {
    const text = extractText(children);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied; ignore */
    }
  }, [children]);

  // Detect whether the content actually exceeds the cap so we only
  // surface the Expand affordance when it would do something. Re-runs
  // on every render — the body content is the children prop, which
  // changes when streaming append-only edits land.
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [children, expanded]);

  return (
    <div className={'code-block' + (expanded ? ' code-block--expanded' : '')}>
      <div className="code-block__header">
        <span className="code-block__lang">{lang ?? 'text'}</span>
        <button
          type="button"
          onClick={onCopy}
          className="code-block__copy"
          title={copied ? '已复制' : '复制代码'}
          aria-label="复制代码"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          <span>{copied ? 'copied' : 'copy'}</span>
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
      {overflowing || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="code-block__expand"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      ) : null}
    </div>
  );
}

/** Pull `language-xxx` off the (singular) child `<code>` element that
 *  react-markdown places inside every fenced `pre`. Returns null for
 *  unfenced blocks or when the agent omitted the info string. */
function extractLang(children: React.ReactNode): string | null {
  if (
    children &&
    typeof children === 'object' &&
    'props' in children &&
    typeof (children as { props?: { className?: unknown } }).props?.className === 'string'
  ) {
    const cls = (children as { props: { className: string } }).props.className;
    const m = /language-([\w+-]+)/.exec(cls);
    if (m) return m[1] ?? null;
  }
  return null;
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (
    node &&
    typeof node === 'object' &&
    'props' in node &&
    (node as { props?: { children?: React.ReactNode } }).props?.children !== undefined
  ) {
    return extractText((node as { props: { children: React.ReactNode } }).props.children);
  }
  return '';
}
