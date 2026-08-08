import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  Ban,
  Brain,
  CheckCircle2,
  ChevronUp,
  Hourglass,
  Info,
  Layers,
  Loader2,
  MessageSquare,
  Power,
  Terminal,
  Wrench,
} from 'lucide-react';
import dayjs from 'dayjs';
import type {
  ConversationActivityEvent,
  ConversationEventKind,
} from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { Markdown } from '@/components/chat/Markdown';
import {
  coalesceActivity,
  presentToolCall,
  type ActivityDisplayItem,
  type ToolDetail,
} from './activityPresentation';
import { mergeActivityById, useAgentActivityFeed } from './useAgentActivityFeed';

// Re-exported so the existing reconcile contract test keeps its import path.
export { mergeActivityById };

/**
 * Merge two activity-event lists — see `./useAgentActivityFeed`. (The merge
 * logic + feed cache moved there in #task:1255 P1c #2 so the central ingestor
 * can write live rows and this view is a pure reader.)
 */

interface AgentActivityTimelineProps {
  /** Parent channel / dm conversation id (never a thread — see pane). */
  conversationId: string;
  agentId: string;
}

/**
 * The detail half of the Activity master-detail: the chronological
 * execution trace for one `(agent, conversation)` pair.
 *
 * No header: the left rail already names the selected channel and that this is
 * the Activity view, so a `Activity · <channel>` title here is redundant (shiki
 * #task:1187).
 *
 * Data contract (backend #task:1186):
 *  - backfill via `GET /api/conversations/:id/agents/:aid/activity` returns
 *    rows **ascending by id**; `next_before_id` pages older rows (rendered
 *    above via "Load earlier").
 *  - live via the `conversation_activity` WS frame on the conversation
 *    scope; the frame is conversation-wide so we filter by `agent_id`.
 *  - tool output is **marker-only** — a privacy decision, not a gap: the
 *    row records that a tool ran, never its result body.
 */
export function AgentActivityTimeline({
  conversationId,
  agentId,
}: AgentActivityTimelineProps): JSX.Element {
  // Pure reader (#task:1255 P1c #2): the feed lives in a React Query cache the
  // central ingestor writes live `conversation_activity` rows into; this view no
  // longer registers `onWsFrame`.
  const { events, nextBeforeId, phase, isLoadingMore, loadEarlier } =
    useAgentActivityFeed(conversationId, agentId);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is pinned near the bottom so a live append
  // auto-follows the tail (console feel) without yanking the viewport
  // when they've scrolled up to read history.
  const atBottomRef = useRef(true);
  const tailFrameRef = useRef<number[]>([]);
  const tailObserverRef = useRef<ResizeObserver | null>(null);

  const cancelTailFrames = useCallback(() => {
    for (const frame of tailFrameRef.current) cancelAnimationFrame(frame);
    tailFrameRef.current = [];
  }, []);

  const pinToTailIfNeeded = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // Pin immediately and across the next two frames. This covers the side-panel
  // open path where the scroller/list can mount before SplitPane width/height
  // and markdown wrapping have fully settled; ResizeObserver below handles all
  // later size changes.
  const scheduleTailPin = useCallback(() => {
    cancelTailFrames();
    pinToTailIfNeeded();
    const first = requestAnimationFrame(() => {
      pinToTailIfNeeded();
      const second = requestAnimationFrame(() => {
        pinToTailIfNeeded();
        tailFrameRef.current = [];
      });
      tailFrameRef.current = [second];
    });
    tailFrameRef.current = [first];
  }, [cancelTailFrames, pinToTailIfNeeded]);

  // Re-pin to the tail when the selected (conversation, agent) changes. The
  // ResizeObserver tail-follow (setListRef) then keeps it pinned as the backfill
  // rows paint and the list grows — no one-shot rAF needed here.
  useEffect(() => {
    atBottomRef.current = true;
    scheduleTailPin();
  }, [conversationId, agentId, scheduleTailPin]);

  useEffect(() => {
    return () => {
      cancelTailFrames();
      tailObserverRef.current?.disconnect();
    };
  }, [cancelTailFrames]);

  const onLoadEarlier = useCallback(() => {
    // Older rows prepend ABOVE the viewport. Rely on the browser's native
    // scroll anchoring (`overflow-anchor`, default on this plain non-virtualized
    // scroller) to hold the reading position, instead of manual scrollTop math:
    // an in-viewport anchor node stays put as content grows above it. Accepted
    // small error — Load earlier is low-frequency and merge-case precision is
    // intentionally out of scope: when older same-kind events merge into the
    // block currently under the reader its markdown re-renders and the position
    // can shift slightly, and a concurrent tail-append is not isolated; neither
    // is worth reintroducing manual compensation or a fragment anchor.
    void loadEarlier();
  }, [loadEarlier]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  // Tail-follow that survives late layout growth. Opening from the agent side
  // panel can mount the list before the pane's width/height and Markdown/code
  // wrapping have settled; a one-shot scroll can land mid-list. While the user
  // is pinned to bottom, observe BOTH the list (content height/wrapping) and the
  // scroller (viewport size) and re-pin on changes. Once they scroll up to read
  // history, atBottomRef flips false (onScroll) and follow stops — manual
  // up-scroll and "Load earlier" are never yanked.
  const setListRef = useCallback((node: HTMLOListElement | null) => {
    tailObserverRef.current?.disconnect();
    tailObserverRef.current = null;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      scheduleTailPin();
    });
    ro.observe(node);
    if (scrollRef.current) ro.observe(scrollRef.current);
    tailObserverRef.current = ro;
    scheduleTailPin();
  }, [scheduleTailPin]);

  // Fold codex's per-token thinking/text fragments into display blocks. Pure
  // display layer — raw `events` (and their ids) are untouched, so dedupe /
  // backfill stay correct. See `coalesceActivity`.
  const items = useMemo(() => coalesceActivity(events), [events]);

  return (
    // `min-w-0` is load-bearing: as a flex-1 row child its default
    // `min-width:auto` refuses to shrink below content min-content, so a wide
    // Activity row (Markdown code block, long tool arg) would push the pane
    // wider than its column — which clips overflow-hidden, hiding the
    // right-pinned time with no horizontal scroll (#task:1288). With min-w-0
    // the chain is width-bounded and `.code-block` scrolls internally instead.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-5 py-3"
      >
        {phase === 'loading' ? (
          <p className="py-8 text-center text-xs text-text-muted">Loading…</p>
        ) : phase === 'error' ? (
          <p className="py-8 text-center text-xs text-text-muted">
            Couldn’t load activity.
          </p>
        ) : events.length === 0 ? (
          <p className="py-8 text-center text-xs text-text-muted">
            No activity yet in this channel.
          </p>
        ) : (
          <>
            {nextBeforeId !== null ? (
              <button
                type="button"
                onClick={() => void onLoadEarlier()}
                disabled={isLoadingMore}
                className="mx-auto mb-1 flex items-center gap-1 px-2 py-1.5 text-[length:var(--text-meta)] text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <ChevronUp className="size-3" />
                {isLoadingMore ? 'Loading…' : 'Load earlier'}
              </button>
            ) : null}
            <ol ref={setListRef} className="flex flex-col">
              {items.map(item =>
                item.type === 'group' ? (
                  <GroupRow key={item.key} item={item} />
                ) : (
                  <EventRow key={item.key} event={item.event} completed={item.completed} />
                ),
              )}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

/** Defensive payload reader — payload is `Record<string, unknown> | null`,
 *  not a static type per kind, so every access is guarded. */
function str(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface KindVisual {
  Icon: typeof Wrench;
  /** lucide stroke color class for the glyph + rail node */
  tone: 'neutral' | 'accent' | 'error' | 'warning' | 'muted';
}

function visualForKind(kind: ConversationEventKind): KindVisual {
  switch (kind) {
    case 'thinking':
      return { Icon: Brain, tone: 'accent' };
    case 'text':
      return { Icon: MessageSquare, tone: 'neutral' };
    case 'tool_call':
      return { Icon: Wrench, tone: 'neutral' };
    case 'tool_output':
      return { Icon: CheckCircle2, tone: 'muted' };
    case 'shell':
      return { Icon: Terminal, tone: 'neutral' };
    case 'error':
    case 'stderr':
      return { Icon: AlertTriangle, tone: 'error' };
    case 'parsed_event_dropped':
      return { Icon: Ban, tone: 'warning' };
    case 'api_response':
      // Default = the waiting/ready queue lifecycle (hourglass). The
      // generic `notice` class is overridden at EventRow, where the
      // payload status is in scope — neutral Info, no queue connotation.
      return { Icon: Hourglass, tone: 'warning' };
    case 'session_init':
      return { Icon: Power, tone: 'muted' };
    case 'compaction_started':
    case 'compaction_finished':
      return { Icon: Layers, tone: 'muted' };
    default:
      // turn_end / file_change / unknown / any future kind — render a
      // generic line rather than crash.
      return { Icon: MessageSquare, tone: 'muted' };
  }
}

const TONE_TEXT: Record<KindVisual['tone'], string> = {
  neutral: 'text-text-secondary',
  accent: 'text-accent',
  error: 'text-error',
  warning: 'text-warning',
  muted: 'text-text-muted',
};

/**
 * Shared row chrome: a bare tone-coloured glyph aligned to the FIRST line of
 * the content (items-start — a multi-line body keeps the glyph on the opening
 * line, not floating to the vertical middle), the body in the flex column, the
 * time pinned top-right, and an optional indented preview below.
 */
function RowShell({
  Icon,
  tone,
  title,
  time,
  preview,
}: {
  Icon: KindVisual['Icon'];
  tone: KindVisual['tone'];
  title: React.ReactNode;
  time: string;
  preview?: React.ReactNode;
}): JSX.Element {
  return (
    <li className="py-1">
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn('mt-0.5 size-3.5 shrink-0', TONE_TEXT[tone])}
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1 break-words text-xs leading-snug">
          {title}
        </div>
        <span className="mt-0.5 shrink-0 font-mono text-[length:var(--text-badge)] tabular-nums text-text-muted">
          {time}
        </span>
      </div>
      {preview ? <div className="ml-[22px] mt-1 min-w-0">{preview}</div> : null}
    </li>
  );
}

/** A coalesced thinking/text block. `text` renders as Markdown (assistant
 *  message); `thinking` as verbatim reasoning prose (italic, not markdown). */
function GroupRow({
  item,
}: {
  item: Extract<ActivityDisplayItem, { type: 'group' }>;
}): JSX.Element {
  const { kind, text, representative } = item;
  const { Icon, tone } = visualForKind(kind);
  const time = dayjs(representative.created_at).format('HH:mm:ss');

  if (kind === 'text') {
    const body =
      text.trim().length > 0 ? (
        <Markdown content={text} />
      ) : (
        <span className="text-text-muted">(message)</span>
      );
    return <RowShell Icon={Icon} tone={tone} time={time} title={body} />;
  }

  return (
    <RowShell
      Icon={Icon}
      tone={tone}
      time={time}
      title={<span className="text-text-secondary">Thinking</span>}
      preview={
        text.trim().length > 0 ? (
          <span className="block whitespace-pre-wrap break-words text-xs italic leading-snug text-text-secondary">
            {text}
          </span>
        ) : null
      }
    />
  );
}

/** A single non-coalesced event: tool_call (via `presentToolCall`, with a ✓
 *  when its output was folded in), an orphan tool_output marker, error/dropped
 *  reasons, lifecycle markers. */
function EventRow({
  event,
  completed,
}: {
  event: ConversationActivityEvent;
  completed?: boolean;
}): JSX.Element {
  const { kind, payload } = event;
  let { Icon, tone } = visualForKind(kind);
  if (kind === 'api_response' && str(payload, 'status') === 'notice') {
    // #task:1582 display boundary: waiting/ready are the queue
    // lifecycle (hourglass); `notice` is the generic normalized
    // response — neutral Info semantics, not a wait.
    Icon = Info;
    tone = 'neutral';
  }
  const time = dayjs(event.created_at).format('HH:mm:ss');

  if (kind === 'tool_call') {
    const name = str(payload, 'name') ?? 'tool';
    const p = presentToolCall(name, payload?.['input'] ?? null);
    return (
      <RowShell
        Icon={Icon}
        tone={tone}
        time={time}
        title={
          <span className="text-text-primary">
            <span className="font-semibold">{p.verb}</span>
            {p.arg ? (
              <span className="ml-1.5 font-mono text-text-secondary">{p.arg}</span>
            ) : null}
            {completed ? (
              <CheckCircle2
                className="ml-1.5 inline-block size-3 -translate-y-px text-success"
                strokeWidth={2.5}
                aria-label="completed"
              />
            ) : null}
          </span>
        }
        preview={p.detail ? <ToolDetailView detail={p.detail} /> : null}
      />
    );
  }

  if (kind === 'compaction_started' || kind === 'compaction_finished') {
    // Paired compaction (#task:1187): the compaction glyph (Layers) stays put
    // on the left; the in-flight/done state rides a TRAILING marker after the
    // title — a spinning loader while running, then the same green success
    // check tool_call uses, once its `compaction_finished` folds in
    // (`completed`). A `compaction_finished` only reaches here as an ORPHAN
    // (paired ones drop in coalesceActivity) → standalone done. An orphan
    // started stays loading — never fabricate a completion.
    const done = kind === 'compaction_finished' || completed === true;
    return (
      <RowShell
        Icon={Icon}
        tone={tone}
        time={time}
        title={
          <span className="text-text-muted">
            {done ? 'Context compacted' : 'Compacting context…'}
            {done ? (
              <CheckCircle2
                className="ml-1.5 inline-block size-3 -translate-y-px text-success"
                strokeWidth={2.5}
                aria-label="completed"
              />
            ) : (
              <Loader2
                className="ml-1.5 inline-block size-3 -translate-y-px animate-spin text-text-muted"
                strokeWidth={2.5}
                aria-label="in progress"
              />
            )}
          </span>
        }
      />
    );
  }

  let title: React.ReactNode;
  if (kind === 'tool_output') {
    // Orphan output (its tool_call paged out): the marker-only body carries no
    // info, so keep it to one light line — the noisy "output not stored" badge
    // is gone (correlated outputs fold into their call as a ✓).
    const name = str(payload, 'name');
    title = (
      <span className="text-text-muted">{name ? `${name} returned` : 'returned'}</span>
    );
  } else if (kind === 'error' || kind === 'stderr') {
    title = (
      <span className="break-words text-error">{str(payload, 'message') ?? 'Error'}</span>
    );
  } else if (kind === 'api_response') {
    const isNotice = str(payload, 'status') === 'notice';
    title = (
      <span
        className={
          isNotice ? 'break-words text-text-secondary' : 'break-words text-warning'
        }
      >
        {str(payload, 'message') ?? 'Provider response'}
      </span>
    );
  } else if (kind === 'parsed_event_dropped') {
    const pk = str(payload, 'parsed_kind');
    title = (
      <span className="text-warning">
        {pk ? `${pk} · dropped (too large)` : 'Event dropped (too large)'}
      </span>
    );
  } else if (kind === 'session_init') {
    title = <span className="text-text-muted">Session started</span>;
  } else if (kind === 'turn_end') {
    title = <span className="text-text-muted">Turn ended</span>;
  } else {
    title = <span className="text-text-muted">{kind}</span>;
  }

  return <RowShell Icon={Icon} tone={tone} time={time} title={title} />;
}

/** Renders a tool_call's optional richer body: a diff (Edit/Write), or a
 *  monospace code/JSON block (shell / fallback). */
function ToolDetailView({ detail }: { detail: ToolDetail }): JSX.Element {
  if (detail.kind === 'diff') {
    return <DiffView removed={detail.removed} added={detail.added} />;
  }
  return (
    <pre className="whitespace-pre-wrap break-all border border-border-subtle bg-bg-base px-2 py-1 font-mono text-[length:var(--text-meta)] leading-relaxed text-text-secondary">
      {detail.text}
    </pre>
  );
}

/** Edit/Write diff preview built from `tool_call.input` (old/new). Removed
 *  lines under a red rail, added under a green rail; tool RESULT output is
 *  never shown (marker-only). */
function DiffView({
  removed,
  added,
}: {
  removed: string;
  added: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-px border border-border-subtle font-mono text-[length:var(--text-meta)] leading-relaxed">
      <DiffSide
        text={removed}
        sign="-"
        railClass="border-error bg-error/10"
        signClass="text-error"
      />
      <DiffSide
        text={added}
        sign="+"
        railClass="border-success bg-success/10"
        signClass="text-success"
      />
    </div>
  );
}

function DiffSide({
  text,
  sign,
  railClass,
  signClass,
}: {
  text: string;
  sign: string;
  railClass: string;
  signClass: string;
}): React.ReactNode {
  if (text.length === 0) return null;
  return (
    <div className={cn('border-l-2', railClass)}>
      {text.split('\n').map((line, i) => (
        <div key={i} className="flex gap-2 px-2">
          <span className={cn('shrink-0 select-none', signClass)}>{sign}</span>
          <span className="min-w-0 whitespace-pre-wrap break-all text-text-secondary">
            {line.length > 0 ? line : ' '}
          </span>
        </div>
      ))}
    </div>
  );
}
