import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Brain,
  CheckCircle2,
  ChevronUp,
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
  ConversationActivityListResponse,
  ConversationEventKind,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useConversationStream } from '@/hooks/useConversationStream';
import { Markdown } from '@/components/chat/Markdown';
import {
  coalesceActivity,
  presentToolCall,
  type ActivityDisplayItem,
  type ToolDetail,
} from './activityPresentation';

const PAGE_SIZE = 100;

/**
 * Merge two activity-event lists into one, sorted ascending by `id`,
 * de-duplicated on `id`. This is the single reconciliation path used by
 * BOTH backfill (prepend older pages) and live WS frames (append newest):
 *
 *  - ordering key is `id` (monotonic, INSERT-then-publish guarantees the
 *    live frame carries the same row id the DB persisted), NOT `created_at`
 *    which can tie across rows;
 *  - a live frame whose `id` already arrived via backfill is dropped, so
 *    the backfill/live race can't double-render a row.
 *
 * Exported for the reconcile contract test.
 */
export function mergeActivityById(
  existing: ReadonlyArray<ConversationActivityEvent>,
  incoming: ReadonlyArray<ConversationActivityEvent>,
): ConversationActivityEvent[] {
  const byId = new Map<number, ConversationActivityEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? pickRicher(prev, e) : e);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Resolve a same-`id` collision. A backend that grows a `thinking`/`text`
 * block IN PLACE (update-in-place coalescer) re-publishes the same row id with
 * a longer `payload.text` each delta; if WS frames reorder, a late SHORTER
 * frame must NOT clobber the already-longer block (would flicker/regress).
 * So when either side carries text, keep the longer one (monotonic growth);
 * otherwise the later (incoming) wins, preserving plain replace semantics.
 */
function pickRicher(
  a: ConversationActivityEvent,
  b: ConversationActivityEvent,
): ConversationActivityEvent {
  const al = textLen(a);
  const bl = textLen(b);
  if (al !== null || bl !== null) return (bl ?? -1) >= (al ?? -1) ? b : a;
  return b;
}

function textLen(e: ConversationActivityEvent): number | null {
  const v = (e.payload as Record<string, unknown> | null)?.['text'];
  return typeof v === 'string' ? v.length : null;
}

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
  const [events, setEvents] = useState<ConversationActivityEvent[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is pinned near the bottom so a live append
  // auto-follows the tail (console feel) without yanking the viewport
  // when they've scrolled up to read history.
  const atBottomRef = useRef(true);

  // Reset + initial backfill whenever the selected (conversation, agent)
  // changes. AbortController guards against a stale page resolving after
  // the user has already switched conversations.
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setEvents([]);
    setNextBeforeId(null);
    void (async () => {
      try {
        const res = await api<ConversationActivityListResponse>(
          `${apiPaths.conversationAgentActivity(conversationId, agentId)}?limit=${PAGE_SIZE}`,
        );
        if (cancelled) return;
        // Reconcile, don't overwrite: a live `conversation_activity` frame
        // can land between mount and this resolve. Routing backfill through
        // the same merge keeps that row (id-dedupe drops any overlap) — with
        // no polling, a clobbered live row would otherwise be lost until reload.
        setEvents(prev => mergeActivityById(prev, res.events));
        setNextBeforeId(res.next_before_id);
        setPhase('ready');
        atBottomRef.current = true;
        // Jump to the tail after the rows paint.
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, agentId]);

  // Live tail. The WS scope is the whole conversation, so every agent's
  // activity arrives here — filter to the selected agent before merging.
  const onStreamEvent = useCallback(
    (event: { kind: string; payload: unknown }) => {
      if (event.kind !== 'conversation_activity') return;
      const row = event.payload as ConversationActivityEvent | undefined;
      if (!row || row.agent_id !== agentId) return;
      setEvents(prev => mergeActivityById(prev, [row]));
      // No manual scroll here: the ResizeObserver tail-follow (see setListRef)
      // re-pins to the bottom whenever the list height grows while the user is
      // pinned there — appending a row is just such a growth, so it's covered
      // by the same height-driven path instead of a separate one-shot rAF.
    },
    [agentId],
  );
  useConversationStream(conversationId, onStreamEvent);

  const loadEarlier = useCallback(async () => {
    if (nextBeforeId === null || loadingMore) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const res = await api<ConversationActivityListResponse>(
        `${apiPaths.conversationAgentActivity(conversationId, agentId)}?limit=${PAGE_SIZE}&before_id=${nextBeforeId}`,
      );
      setEvents(prev => mergeActivityById(res.events, prev));
      setNextBeforeId(res.next_before_id);
      // Preserve the reading position: older rows are prepended, so shift
      // scrollTop by the height delta to keep the same row under the eye.
      requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight - prevHeight;
      });
    } catch {
      /* transient — the button stays, user can retry */
    } finally {
      setLoadingMore(false);
    }
  }, [conversationId, agentId, nextBeforeId, loadingMore]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  // Tail-follow that survives late layout growth. The initial open/switch jump
  // (the rAF in the backfill effect) fires once, right after the rows commit —
  // but the final height isn't settled yet: Activity rows render Markdown +
  // diff/code wrapping, web fonts swap in, and the side panel/SplitPane settles
  // its width a frame or two after mount, all of which grow the list AFTER that
  // single scroll. With nothing re-pinning, it lands mid-list ("有时候不会滚到
  // 底"). So we observe the list's height instead: while the user is pinned to
  // the bottom (atBottomRef), every height change re-pins to the tail; once
  // they scroll up to read history, atBottomRef flips false (onScroll) and the
  // follow stops — manual up-scroll and "Load earlier" are never yanked.
  // Height-driven, never a fixed timeout (Cindy). A callback ref re-attaches
  // the observer across the list's mount/unmount (loading↔ready, conversation
  // switch). Setting scrollTop doesn't resize the list, so this can't loop.
  const tailObserverRef = useRef<ResizeObserver | null>(null);
  const setListRef = useCallback((node: HTMLOListElement | null) => {
    tailObserverRef.current?.disconnect();
    tailObserverRef.current = null;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(node);
    tailObserverRef.current = ro;
  }, []);

  // Fold codex's per-token thinking/text fragments into display blocks. Pure
  // display layer — raw `events` (and their ids) are untouched, so dedupe /
  // backfill stay correct. See `coalesceActivity`.
  const items = useMemo(() => coalesceActivity(events), [events]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
                onClick={() => void loadEarlier()}
                disabled={loadingMore}
                className="mx-auto mb-1 flex items-center gap-1 px-2 py-1.5 text-[11px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <ChevronUp className="size-3" />
                {loadingMore ? 'Loading…' : 'Load earlier'}
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
        <div className="min-w-0 flex-1 break-words text-[12.5px] leading-snug">
          {title}
        </div>
        <span className="mt-0.5 shrink-0 font-mono text-[10.5px] tabular-nums text-text-muted">
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
          <span className="block whitespace-pre-wrap break-words text-[12.5px] italic leading-snug text-text-secondary">
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
  const { Icon, tone } = visualForKind(kind);
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
    <pre className="whitespace-pre-wrap break-all border border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px] leading-relaxed text-text-secondary">
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
    <div className="flex flex-col gap-px border border-border-subtle font-mono text-[11px] leading-relaxed">
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
