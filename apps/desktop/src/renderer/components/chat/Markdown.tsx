import { type ComponentProps, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AtSign, Check, Copy, Hash } from 'lucide-react';
import { rehypeHighlightTerm } from './rehypeHighlightTerm';
import type { AgentDto, UserDto } from '@silverhand/shared';
import {
  exceedsRenderBudget,
  markdownByteLength,
  MESSAGE_RENDER_BUDGET_BYTES,
} from './markdown-render-budget';
import { Mention } from './Mention';
import { MermaidDiagram } from './MermaidDiagram';
import { ChannelRef, type ChannelReference } from './ChannelRef';
import {
  ConversationRef,
  shortConversationId,
  type ConversationReference,
} from './ConversationRef';
import { TaskRef, TaskRefStaticChip, type StaticTaskRefSummary } from './TaskRef';

interface MarkdownProps {
  content: string;
  /** Forwarded to inline `<Mention>` so the agent popover can show
   *  per-conversation presence + retry. Optional — system messages outside
   *  a chat context omit it. */
  conversationId?: string | null;
  /** Lookup by agent `name` (the handle used in @mentions). When
   *  absent, mentions render as plain accent-colored text without the
   *  popover. */
  agentsByName?: Map<string, AgentDto>;
  /** Object-URL map keyed by agent id. Threaded straight to inline
   *  `<Mention>` so `<AgentInfoPopover>` reuses the parent's batch
   *  fetch instead of firing one GET per `@mention`. Missing entries
   *  / `null` fall back to the runtime icon. */
  agentAvatarUrls?: Map<string, string | null>;
  /** Lookup by human user `name` (same @mention namespace as agents).
   *  The data layer guarantees `users.name` and `agents.name` are
   *  globally unique; rendering only consumes that invariant. */
  humansByName?: Map<string, UserDto>;
  /** Lookup by channel `title` for `#<channel_name>` refs in the
   *  message's workspace.
   *  - `ChannelReference` → unique match in this workspace
   *  - `null`             → ambiguity sentinel (multiple channels share
   *                         this title) — chip degrades to inert text
   *                         rather than guess a destination
   *  - missing entry      → no match in this workspace
   */
  channelsByName?: Map<string, ChannelReference | null>;
  /** Click handler for resolved channel refs. Receives the resolved
   *  channel id; the caller is responsible for binding it to the
   *  message's workspace via `nav.toChannel(workspaceId, channelId)`. */
  onOpenChannelRef?: (channelId: string) => void;
  /** Lookup by conversation id for `#conv:<id>` refs in the current
   *  workspace. Missing entries still render as clickable id refs when
   *  `onOpenConversationRef` is supplied. */
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  /** Static task summaries for export / screenshot rendering. Live
   *  `TaskRef` resolves with hooks; non-interactive export trees consume
   *  this map instead so `#task:<n>` can still show `#<n> · title`
   *  without mounting query/popover components. */
  taskRefsByNumber?: Map<number, StaticTaskRefSummary>;
  /** Set to `false` for export / screenshot rendering. When false:
   *  - fenced code blocks render as a bare `<pre>` (no copy / expand
   *    buttons, no overflow useEffect)
   *  - plain external links collapse to a styled `<span>` (no href,
   *    no onClick, no IPC)
   *  - internal refs (mention / channel / #conv / #task) render as
   *    static output without mounting `<Mention>`, `<ChannelRef>`,
   *    `<ConversationRef>`, or live `<TaskRef>` — those components run
   *    hooks / queries that have no place inside an offscreen screenshot
   *    tree. `#task` uses a pure static chip with the same theme hook.
   *
   *  Default `true` keeps the in-channel behaviour exactly as before.
   *  This is consumed by `MessageScreenshotView` (Cindy's review of
   *  2f8a2ca: the export view was leaking interactive chrome into
   *  the captured PNG). */
  interactive?: boolean;
  /** Pre-rendered Mermaid SVGs keyed by trimmed diagram source, for the
   *  export/screenshot path (#task:1322). When a mermaid fence's source is
   *  present here, the non-interactive export tree injects the finished SVG
   *  instead of falling back to source — so a shared image shows the rendered
   *  diagram. Absent key (diagram failed / timed out pre-render, or interactive
   *  path) → source fallback, exactly as before. */
  mermaidSvgByCode?: ReadonlyMap<string, string>;
  /** In-conversation header find (#task:1335): when set (non-empty), every
   *  case-insensitive literal occurrence of this term in the rendered body is
   *  wrapped in `<mark class="search-hit">` by a rehype plugin. Absent / empty
   *  → the exact pre-find pipeline (no extra plugin, no re-processing). */
  searchQuery?: string;
  /** How much markdown this surface is willing to render (see
   *  `markdown-render-budget.ts`). `'message'` (default) bounds the body at the
   *  message content cap and falls back to a plain-text preview above it;
   *  `'unbounded'` renders whatever it is handed — for callers already bounded
   *  upstream, i.e. the workspace file preview. */
  renderBudget?: 'message' | 'unbounded';
}

const MENTION_PREFIX = 'silverhand-mention:';
const CHANNEL_PREFIX = 'silverhand-channel:';
const CONVERSATION_PREFIX = 'silverhand-conversation:';
const TASK_PREFIX = 'silverhand-task:';
// Bare `#<n>` task reference (no `#task:` sigil). Agents habitually write
// `#123` for a task; we resolve it against the workspace's task numbers and
// render a chip ONLY when a matching task exists. Unlike the explicit
// `#task:<n>` scheme — which keeps a muted chip even when unresolved — a bare
// `#<n>` is ambiguous (issue numbers, quantities, versions), so an unresolved
// one demotes to its literal text and leaves no chrome. The distinct scheme is
// what lets the `a` override pick the demote-to-text fallback for bare refs.
const BARE_TASK_PREFIX = 'silverhand-task-bare:';

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
function MarkdownInner({
  content,
  conversationId,
  agentsByName,
  agentAvatarUrls,
  humansByName,
  channelsByName,
  onOpenChannelRef,
  conversationRefsById,
  onOpenConversationRef,
  taskRefsByNumber,
  interactive = true,
  mermaidSvgByCode,
  searchQuery,
  renderBudget = 'message',
}: MarkdownProps): JSX.Element {
  // Oversized guard: a multi-MB body (legacy DB rows predating the send-side
  // byte cap) pins the renderer process in remark/rehype, so anything over this
  // surface's budget falls back to a bounded plain-text preview. The budget is
  // per consumer (`markdown-render-budget.ts`): a chat body is bounded by the
  // message cap, the workspace file preview is bounded by the daemon's read cap
  // and so opts out here rather than inheriting a chat limit.
  const budget =
    renderBudget === 'unbounded' ? null : MESSAGE_RENDER_BUDGET_BYTES;
  const oversizedBytes = useMemo(
    () =>
      exceedsRenderBudget(content, budget) ? markdownByteLength(content) : null,
    [content, budget],
  );

  // Plugin instance is recreated per render but is a thin closure;
  // remark instantiates the transformer once per `process` call so
  // the cost is negligible. Memoizing it doesn't help because react-
  // markdown also memoizes the pipeline by reference equality of the
  // plugins array.
  const plugins = useMemo(() => [remarkGfm, remarkBreaks, remarkRefs], []);

  // Keyword highlight is opt-in: only when the header find is active do we
  // append `rehypeHighlightTerm` after `rehype-highlight`. Recreated when the
  // term changes so react-markdown re-processes (that's the point — the marks
  // must track the query); when there's no term we return the stable
  // highlight-only array so ordinary rendering is byte-identical to before.
  const trimmedTerm = searchQuery?.trim() ?? '';
  const rehypePlugins = useMemo<
    NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>
  >(
    () =>
      trimmedTerm
        ? [rehypeHighlight, [rehypeHighlightTerm, { term: trimmedTerm }]]
        : [rehypeHighlight],
    [trimmedTerm],
  );

  if (oversizedBytes !== null) {
    return <OversizedContent content={content} bytes={oversizedBytes} />;
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={rehypePlugins}
        // Whitelist our internal mention scheme — react-markdown's
        // default sanitizer drops unknown URL schemes (turning `href`
        // into an empty string), which would cause the `a` override
        // below to miss the prefix check and render an inert link.
        urlTransform={url =>
          url.startsWith(MENTION_PREFIX) ||
          url.startsWith(CHANNEL_PREFIX) ||
          url.startsWith(CONVERSATION_PREFIX) ||
          url.startsWith(TASK_PREFIX) ||
          url.startsWith(BARE_TASK_PREFIX)
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children, ...rest }) => {
            // Export / screenshot path: every reachable href shape
            // collapses to a styled span. Internal-scheme chips keep
            // their accent class so visual fidelity is preserved, but
            // none of them mount the live components (which run their
            // own hooks / queries). Plain links lose `href` entirely
            // — no clickable handler, no `target=_blank`, no role.
            if (!interactive) {
              if (typeof href === 'string') {
                if (href.startsWith(MENTION_PREFIX)) {
                  const name = href.slice(MENTION_PREFIX.length);
                  const mentionAgent = agentsByName?.get(name);
                  const mentionHuman = humansByName?.get(name);
                  return (
                    <StaticMentionRef
                      name={name}
                      label={
                        mentionAgent?.display_name?.trim() ||
                        mentionAgent?.name ||
                        mentionHuman?.display_name?.trim() ||
                        mentionHuman?.name ||
                        null
                      }
                      resolved={!!mentionAgent || !!mentionHuman}
                      humanId={mentionHuman?.id}
                    />
                  );
                }
                if (href.startsWith(CHANNEL_PREFIX)) {
                  const name = href.slice(CHANNEL_PREFIX.length);
                  return (
                    <StaticChannelRef
                      name={name}
                      channel={channelsByName?.get(name)}
                    />
                  );
                }
                if (href.startsWith(CONVERSATION_PREFIX)) {
                  const id = href.slice(CONVERSATION_PREFIX.length);
                  return (
                    <StaticConversationRef
                      id={id}
                      conversation={conversationRefsById?.get(id)}
                    />
                  );
                }
                if (href.startsWith(TASK_PREFIX)) {
                  const raw = href.slice(TASK_PREFIX.length);
                  const taskNumber = Number.parseInt(raw, 10);
                  if (/^[1-9]\d*$/.test(raw) && Number.isFinite(taskNumber)) {
                    return (
                      <TaskRefStaticChip
                        taskNumber={taskNumber}
                        task={taskRefsByNumber?.get(taskNumber)}
                      />
                    );
                  }
                  return <span>{children}</span>;
                }
                if (href.startsWith(BARE_TASK_PREFIX)) {
                  // Bare `#<n>` in the export path: only render a chip when
                  // the export builder pre-resolved this number to a task.
                  // Otherwise keep the literal text — a bare number that
                  // isn't a task must not sprout chrome in a screenshot.
                  const raw = href.slice(BARE_TASK_PREFIX.length);
                  const taskNumber = Number.parseInt(raw, 10);
                  const resolved =
                    /^[1-9]\d*$/.test(raw) && Number.isFinite(taskNumber)
                      ? taskRefsByNumber?.get(taskNumber)
                      : null;
                  return resolved ? (
                    <TaskRefStaticChip taskNumber={taskNumber} task={resolved} />
                  ) : (
                    <span>{children}</span>
                  );
                }
              }
              return (
                <span className="markdown-link-static text-accent underline underline-offset-2">
                  {children}
                </span>
              );
            }
            if (typeof href === 'string' && href.startsWith(MENTION_PREFIX)) {
              const name = href.slice(MENTION_PREFIX.length);
              const mentionAgent = agentsByName?.get(name);
              // `undefined` = parent didn't thread the map (no batch
              // context — popover falls back to its own fetch).
              // `null`     = batched parent looked it up; the agent
              //              has no avatar yet, render runtime icon.
              const mentionAvatarObjectUrl =
                agentAvatarUrls && mentionAgent
                  ? agentAvatarUrls.get(mentionAgent.id) ?? null
                  : undefined;
              return (
                <Mention
                  name={name}
                  agent={mentionAgent}
                  agentAvatarObjectUrl={mentionAvatarObjectUrl}
                  human={humansByName?.get(name)}
                  conversationId={conversationId ?? null}
                />
              );
            }
            if (typeof href === 'string' && href.startsWith(CHANNEL_PREFIX)) {
              const name = href.slice(CHANNEL_PREFIX.length);
              return (
                <ChannelRef
                  name={name}
                  channel={channelsByName?.get(name)}
                  onOpen={onOpenChannelRef}
                />
              );
            }
            if (
              typeof href === 'string' &&
              href.startsWith(CONVERSATION_PREFIX)
            ) {
              const id = href.slice(CONVERSATION_PREFIX.length);
              return (
                <ConversationRef
                  id={id}
                  conversation={conversationRefsById?.get(id)}
                  onOpen={onOpenConversationRef}
                />
              );
            }
            if (
              typeof href === 'string' &&
              href.startsWith(TASK_PREFIX)
            ) {
              // The tokenizer guarantees the slice is `[1-9]\d*` —
              // positive integer with no leading zero. parseInt + finite
              // check is defensive belt-and-suspenders for the case
              // where someone hand-authors `[label](silverhand-task:0)`
              // through agent-supplied markdown the tokenizer never
              // touched. Render the original child text inertly rather
              // than fall through to the plain-link branch — that branch
              // calls `window.silverhand.openExternal(href)` on click,
              // which would shell out our internal scheme.
              const raw = href.slice(TASK_PREFIX.length);
              const taskNumber = Number.parseInt(raw, 10);
              if (
                /^[1-9]\d*$/.test(raw) &&
                Number.isFinite(taskNumber) &&
                taskNumber > 0
              ) {
                return <TaskRef taskNumber={taskNumber} />;
              }
              // Pathological — render as plain text so we don't crash
              // on a malformed href and don't hand our internal scheme
              // to the OS handler.
              return <span>{children}</span>;
            }
            if (
              typeof href === 'string' &&
              href.startsWith(BARE_TASK_PREFIX)
            ) {
              // Bare `#<n>`: same resolve path as `#task:<n>`, but the
              // `bare` flag makes TaskRef demote to its literal text
              // (no chip) for the no-context / loading / missing states.
              // Only a resolved-present task yields a chip. The tokenizer
              // guarantees `[1-9]\d*`; parse defensively as above.
              const raw = href.slice(BARE_TASK_PREFIX.length);
              const taskNumber = Number.parseInt(raw, 10);
              if (
                /^[1-9]\d*$/.test(raw) &&
                Number.isFinite(taskNumber) &&
                taskNumber > 0
              ) {
                return <TaskRef taskNumber={taskNumber} bare />;
              }
              return <span>{children}</span>;
            }
            return (
              <a
                {...rest}
                href={href}
                onClick={e => {
                  e.preventDefault();
                  if (href) void window.silverhand.openExternal(href);
                }}
              >
                {children}
              </a>
            );
          },
          pre: ({ children }) => {
            // Mermaid fences auto-render to a diagram on the live path
            // (#task:1322). The export/screenshot path (`interactive=false`)
            // keeps the source as a plain code block instead — the capture is
            // synchronous and mermaid's async render wouldn't finish in time,
            // so showing the (always-correct) source beats a blank diagram.
            // Case-insensitive: `mermaid` is a proper noun (capital M) and
            // agents commonly write ```Mermaid — a stray capital shouldn't
            // silently demote the diagram to a plain code block.
            if (extractLang(children)?.toLowerCase() === 'mermaid') {
              if (interactive) {
                return <MermaidDiagram code={extractText(children)} />;
              }
              // Export path: use the SVG pre-rendered before capture
              // (#task:1322) if this diagram succeeded; otherwise keep the
              // always-correct source. The SVG was produced by the same
              // `renderMermaidSvg` entry + theme as the live component, so the
              // shared image matches what's on screen. It's already
              // DOMPurify-sanitized (securityLevel:'strict'), safe to inject.
              const svg = mermaidSvgByCode?.get(extractText(children).trim());
              if (svg) {
                return (
                  <div
                    className="mermaid-diagram"
                    data-mermaid-state="ok"
                    dangerouslySetInnerHTML={{ __html: svg }}
                  />
                );
              }
              return (
                <div className="code-block">
                  <pre>{children}</pre>
                </div>
              );
            }
            return interactive ? (
              <CodeBlock>{children}</CodeBlock>
            ) : (
              // Export path: bare `<pre>`. No copy / expand button,
              // no overflow useEffect — the captured screenshot
              // shows the code as-is and any chrome would just be
              // noise. We still keep the `code-block` class so
              // existing CSS (font, padding) lands.
              <div className="code-block">
                <pre>{children}</pre>
              </div>
            );
          },
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

function StaticMentionRef({
  name,
  label,
  resolved,
  humanId,
}: {
  name: string;
  label: string | null;
  resolved: boolean;
  humanId?: string;
}): JSX.Element {
  if (!resolved) {
    return <span className="text-text-muted">@{name}</span>;
  }
  return (
    <span
      className="rounded-[var(--chip-radius)] px-1 -mx-0.5 font-medium text-accent"
      aria-label={`@${name}`}
      data-mention-kind={humanId ? 'human' : 'agent'}
      data-mention-id={humanId}
    >
      @{label ?? name}
    </span>
  );
}

function StaticChannelRef({
  name,
  channel,
}: {
  name: string;
  channel: ChannelReference | null | undefined;
}): JSX.Element {
  if (!channel) {
    return (
      <span
        className="font-mono text-text-muted"
        data-channel-ref-state={channel === null ? 'ambiguous' : 'unresolved'}
      >
        #{name}
      </span>
    );
  }
  return (
    <span
      className={
        'inline-flex items-baseline gap-0.5 rounded-[var(--chip-radius)] px-1 -mx-0.5 font-medium text-accent' +
        (channel.closed_at != null ? ' opacity-60' : '')
      }
      title={`#${channel.title}`}
      data-channel-ref-state="resolved-no-handler"
      data-channel-ref-id={channel.id}
    >
      <Hash className="size-3 shrink-0 self-center" />
      {channel.title}
    </span>
  );
}

function StaticConversationRef({
  id,
  conversation,
}: {
  id: string;
  conversation: ConversationReference | undefined;
}): JSX.Element {
  const label = conversation
    ? conversationDisplayName(conversation)
    : `#conv:${shortConversationId(id)}`;
  const icon = conversationIcon(conversation?.kind);
  return (
    <span
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent"
      aria-label={
        conversation
          ? `${kindLabel(conversation.kind)} · ${label}`
          : `Conversation #conv:${id}`
      }
      data-conversation-ref={id}
    >
      {icon}
      <span className={conversation ? 'truncate' : 'truncate font-mono'}>
        {label}
      </span>
    </span>
  );
}

function conversationDisplayName(conversation: ConversationReference): string {
  return conversation.title;
}

function kindLabel(kind: ConversationReference['kind']): string {
  if (kind === 'dm_channel') return 'DM';
  return 'Channel';
}

function conversationIcon(
  kind: ConversationReference['kind'] | undefined,
): JSX.Element {
  if (kind === 'dm_channel') {
    return <AtSign className="size-3 shrink-0 self-center" />;
  }
  return <Hash className="size-3 shrink-0 self-center" />;
}

// Walks the mdast tree and replaces inline `@handle`, `#handle`, and
// `#conv:<conversation_id>` substrings inside text nodes with link nodes
// that carry our internal silverhand-* URL schemes.
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

// Leading-boundary validation is handled in `canStartRef`. It keeps
// email addresses (`me@example.com`), paths (`a/@b`), and URL
// fragments (`page#anchor`) out, while still allowing slash-separated
// live refs such as `#task:317/#task:318`. Handle character class
// mirrors `CreateAgentInputSchema` / `CreateChannelInputSchema` in
// `packages/shared/src/api/agent.ts` / `conversation.ts` (alphanumerics, `-`, `_`).
// Conversation ids are generated from 12 random bytes as base64url,
// yielding exactly 16 chars. The trailing negative lookahead prevents
// matching a valid-looking prefix inside a longer id-like token.
//
// Typed sigil grammar: `#<type>:<value>`. We currently recognize:
//  - `#conv:<id>`  — 16-char base64url conversation id
//  - `#task:<n>`   — workspace-scoped positive integer task number;
//                    `[1-9]\d*` rejects zero AND leading zeros so the
//                    chip never points at a row that can't exist. The
//                    `(?!\w)` boundary prevents `#task:12abc` from
//                    swallowing `12` as a task — same strict tail
//                    Cindy review of `80f544e` flagged on the URL
//                    parser.
//  - `#<n>`        — BARE task number (no `#task:` sigil). Agents write
//                    `#123` to mean task 123. Routed through the distinct
//                    BARE_TASK_PREFIX so an unresolved `#123` demotes to
//                    its literal text instead of showing a chip (see the
//                    scheme comment above). This branch is LAST so the
//                    explicit `#conv:` / `#task:` / `#<channel>` forms
//                    always win at a shared `#`. The numeric range
//                    starts at 11 — `#1` … `#10` collide with the
//                    Markdown editorial habit of numbering steps
//                    `#1, #2, #3`, so those stay plain text. Explicit
//                    `#task:1` … `#task:10` still resolve normally.
// The channel branch explicitly excludes `#conv:` and `#task:`
// prefixes via negative lookahead so a malformed `#conv:bad` /
// `#task:abc` doesn't fall back to matching `#conv` / `#task` as a
// stray channel reference. A digit-first `#<n>` never collides with the
// alpha-first channel branch.
const REF_RE =
  /(?:#conv:([A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])|#task:([1-9]\d*)(?!\w)|@([a-zA-Z][a-zA-Z0-9_-]*)|#(?!conv:|task:)([a-zA-Z][a-zA-Z0-9_-]*)|#((?:1[1-9]|[2-9]\d|[1-9]\d{2,}))(?!\w))/g;

function pushSplit(text: string, out: MdastNode[]): void {
  let last = 0;
  let lastRefEnd = -1;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = REF_RE.exec(text)) !== null) {
    if (!canStartRef(text, m.index, lastRefEnd)) {
      continue;
    }
    any = true;
    if (m.index > last) {
      out.push({ type: 'text', value: text.slice(last, m.index) });
    }
    const refEnd = m.index + m[0].length;
    const conversationId = m[1];
    if (conversationId) {
      out.push({
        type: 'link',
        // mdast `link` uses `url`, not `href`. mdast-util-to-hast maps
        // it to the `href` attribute on the rendered `<a>`.
        url: `${CONVERSATION_PREFIX}${conversationId}`,
        children: [{ type: 'text', value: `#conv:${conversationId}` }],
      });
      last = refEnd;
      lastRefEnd = refEnd;
      continue;
    }
    const taskNumber = m[2];
    if (taskNumber) {
      out.push({
        type: 'link',
        url: `${TASK_PREFIX}${taskNumber}`,
        children: [{ type: 'text', value: `#task:${taskNumber}` }],
      });
      last = refEnd;
      lastRefEnd = refEnd;
      continue;
    }
    const mentionName = m[3];
    if (mentionName) {
      out.push({
        type: 'link',
        url: `${MENTION_PREFIX}${mentionName}`,
        children: [{ type: 'text', value: `@${mentionName}` }],
      });
      last = refEnd;
      lastRefEnd = refEnd;
      continue;
    }
    const channelName = m[4];
    if (channelName) {
      out.push({
        type: 'link',
        url: `${CHANNEL_PREFIX}${channelName}`,
        children: [{ type: 'text', value: `#${channelName}` }],
      });
      last = refEnd;
      lastRefEnd = refEnd;
      continue;
    }
    // Bare `#<n>` task reference. The `text` child keeps the literal
    // `#<n>` so the demote-to-text fallback (unresolved / no context)
    // reproduces the original prose verbatim.
    const bareTaskNumber = m[5]!;
    out.push({
      type: 'link',
      url: `${BARE_TASK_PREFIX}${bareTaskNumber}`,
      children: [{ type: 'text', value: `#${bareTaskNumber}` }],
    });
    last = refEnd;
    lastRefEnd = refEnd;
  }
  if (!any) {
    out.push({ type: 'text', value: text });
    return;
  }
  if (last < text.length) {
    out.push({ type: 'text', value: text.slice(last) });
  }
}

function canStartRef(text: string, index: number, lastRefEnd: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1]!;
  if (prev === '/') {
    // Let slash act as a compact separator between already-live refs:
    // `#task:317/#task:318`, `#conv:<id>/#task:318`, etc. Without a
    // live ref immediately before the slash, keep treating `/@x` and
    // `/#task:1` as path/URL text.
    return lastRefEnd === index - 1;
  }
  return !/[\w]/.test(prev);
}

const OVERSIZED_PREVIEW_CHARS = 4000;

/** Bounded plain-text rendering for bodies over the render budget (legacy
 *  oversized rows). Never touches the markdown pipeline; full content stays
 *  retrievable via copy. */
function OversizedContent({
  content,
  bytes,
}: {
  content: string;
  bytes: number;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied; ignore */
    }
  }, [content]);
  const label =
    bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  return (
    <div className="markdown-body">
      <div className="flex items-center gap-2 text-xs opacity-60">
        <span>{label} · too large to render as Markdown</span>
        <button type="button" onClick={onCopy} className="underline hover:opacity-80">
          {copied ? 'Copied' : 'Copy full text'}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words">
        {content.slice(0, OVERSIZED_PREVIEW_CHARS)}
        {'\n…'}
      </pre>
    </div>
  );
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
          title={copied ? 'Copied' : 'Copy code'}
          aria-label="Copy code"
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
