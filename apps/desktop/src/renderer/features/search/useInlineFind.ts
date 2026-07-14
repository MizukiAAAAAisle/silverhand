import { type RefObject, useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchDto } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

// In-conversation header find (#task:1335). A lightweight, scoped keyword
// search distinct from the advanced `SearchPanel`: no filters, one stream of
// one conversation, scoped result set up to the 500 cap (so prev/next spans
// every RETURNED hit — not just the virtualized DOM window; on truncation the
// oldest hits beyond the cap are excluded, and the counter shows "N / 500+").
// It calls the SAME upgraded `GET /api/search` the advanced panel uses (Alice,
// #task:1334) with the narrow inline shape:
//   conversation_id + stream + order=recency_desc (+ thread_root_id for threads).
// The backend's stream predicate is shared with the message-window read-model,
// so every returned hit is materialisable in the panel that asked ("搜到必可见"
// by construction).

/** Inline find caps the result set at 500 (advanced search keeps 80). When the
 *  backend truncates to this, the counter shows "N / 500+" and prev/next spans
 *  the returned 500 only. */
export const INLINE_FIND_LIMIT = 500;
const DEBOUNCE_MS = 200;

export type InlineFindStream = 'mainline' | 'thread';

/** Build the query string for one inline find call. Exported for unit tests —
 *  the exact param shape is the backend contract (#task:1334 guardrails:
 *  stream≠all requires conversation_id; stream=thread requires thread_root_id).
 *  Order is `recency_desc` (newest hit first) so the find lands on the most
 *  recent match and prev/next walks toward older ones — the "查找最新" habit
 *  (shiki #task:1335); truncation to the 500 cap then keeps the RECENT hits. */
export function buildInlineFindParams(input: {
  q: string;
  conversationId: string;
  stream: InlineFindStream;
  threadRootId?: string;
}): string {
  const params = new URLSearchParams();
  params.set('q', input.q.trim());
  params.set('conversation_id', input.conversationId);
  params.set('stream', input.stream);
  params.set('order', 'recency_desc');
  params.set('limit', String(INLINE_FIND_LIMIT));
  if (input.stream === 'thread' && input.threadRootId) {
    params.set('thread_root_id', input.threadRootId);
  }
  return params.toString();
}

/** Cyclic prev/next index. Wraps at both ends so ↑ from the first hit lands on
 *  the last and ↓ from the last lands on the first. `current < 0` (no active
 *  match yet) is treated as "before the first", so the first ↓ selects index 0.
 *  Returns -1 for an empty set. Pure — unit-tested. */
export function cycleIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return (((base + delta) % length) + length) % length;
}

/** Derive the active-match affordance (framed row id + 1-based counter position)
 *  from the raw state. Returns the "cleared" shape `{ null, 0 }` whenever the bar
 *  is closed OR there is no in-range active index — so closing the find wipes
 *  EVERY search affordance (the `<mark>`s clear via `highlightQuery`, the row
 *  frame + counter clear via this). Pure — unit-tested. */
export function activeMatch(
  open: boolean,
  activeIndex: number,
  matchIds: string[],
): { activeMessageId: string | null; activePosition: number } {
  if (!open || activeIndex < 0 || activeIndex >= matchIds.length) {
    return { activeMessageId: null, activePosition: 0 };
  }
  return { activeMessageId: matchIds[activeIndex]!, activePosition: activeIndex + 1 };
}

/** The find-bar input's navigation action for a keystroke (#task:1335). Pure so
 *  the Enter / Arrow / Escape semantics are pinned by unit test and can't drift.
 *  Maps: Enter → next, Shift+Enter → prev, ↓ → next, ↑ → prev, Esc → close. Any
 *  other key (Left/Right/Home/End, text) returns null so the input keeps normal
 *  cursor movement + editing. Returns null MID-IME-COMPOSITION so a CJK commit
 *  keystroke (Enter to accept a candidate) belongs to the input method, not the
 *  find (the composer's IME-safe rule). The bar only dispatches / preventDefaults
 *  when this is non-null, so it never steals unhandled keys. */
export type InlineFindKeyAction = 'next' | 'prev' | 'close' | null;
export function inlineFindKeyAction(e: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): InlineFindKeyAction {
  if (e.isComposing) return null;
  switch (e.key) {
    case 'Enter':
      return e.shiftKey ? 'prev' : 'next';
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}

interface InlineFindData {
  matchIds: string[];
  total: number;
  truncated: boolean;
}

/** Map a search DTO's results to message ids in CHRONOLOGICAL order (oldest →
 *  newest). The inline call fetches `recency_desc` so truncation to the 500 cap
 *  keeps the NEWEST hits (shiki "查最新"); we then reverse to document order so
 *  the counter + prev/next read like a browser find — index 0 = oldest = "1/N",
 *  last = newest = "N/N", and the find lands on the last (newest). Non-message
 *  results are suppressed server-side (inline is conversation-scoped) but
 *  filtered defensively. Pure — unit-tested. */
export function toChronologicalMatchIds(results: SearchDto['results']): string[] {
  const ids: string[] = [];
  for (const r of results) {
    if (r.type === 'message') ids.push(r.message.id);
  }
  ids.reverse();
  return ids;
}

/** Whether an inline-find query may fire against `/api/search`: the bar is
 *  open, the viewer has ACCESS (a member — in-conversation search is a member
 *  surface), and there is a non-empty term. The membership gate
 *  lives HERE, on the query source, not only on the visible toggle — a
 *  non-member (or a viewer whose membership is revoked mid-search) must never
 *  reach the member-only endpoint. Pure — unit-tested. */
export function inlineFindQueryEnabled(
  open: boolean,
  available: boolean,
  q: string,
): boolean {
  return open && available && q.trim().length > 0;
}

function useInlineFindQuery(input: {
  conversationId: string;
  stream: InlineFindStream;
  threadRootId?: string;
  q: string;
  enabled: boolean;
}) {
  const q = input.q.trim();
  return useQuery<InlineFindData>({
    queryKey: [
      'inline-find',
      input.conversationId,
      input.stream,
      input.threadRootId ?? null,
      q,
    ] as const,
    enabled: input.enabled,
    // Keep the previous result visible while the next query resolves, so the
    // counter / marks don't flicker to empty between keystrokes.
    placeholderData: prev => prev,
    staleTime: 5_000,
    queryFn: async () => {
      const qs = buildInlineFindParams({
        q,
        conversationId: input.conversationId,
        stream: input.stream,
        threadRootId: input.threadRootId,
      });
      const dto = await api<SearchDto>(`${apiPaths.search}?${qs}`);
      return {
        matchIds: toChronologicalMatchIds(dto.results),
        total: dto.total,
        truncated: dto.truncated,
      };
    },
  });
}

export interface InlineFindController {
  open: boolean;
  openFind: () => void;
  close: () => void;
  query: string;
  setQuery: (q: string) => void;
  /** The term to highlight in the rendered bodies — the debounced query while
   *  open, '' otherwise (so marks clear the instant the bar closes). */
  highlightQuery: string;
  matchCount: number;
  truncated: boolean;
  isFetching: boolean;
  /** 1-based position of the active match, or 0 when there's no active match. */
  activePosition: number;
  activeMessageId: string | null;
  next: () => void;
  prev: () => void;
}

/**
 * Owns the inline-find UI + navigation state for ONE panel (channel mainline
 * OR one thread cluster). Local to the panel by design — channel and thread
 * search independently (shiki #task:1335 req 2). Navigation to an off-window
 * match is delegated to `onNavigate` (the parent wires it to App's
 * `handleJumpToMessage`, which primes + scroll-locates + flashes via the
 * existing jump path), while the persistent "active row" frame is driven by
 * `activeMessageId` passed back down to the message list.
 *
 * Counter semantics are decoupled from the backend `total` field: the
 * denominator is the RETURNED count (`matchIds.length`) and the "+" suffix is
 * `truncated`. When not truncated the returned count IS the true total; when
 * truncated it's the 500-cap the cursor actually spans — so "N / 500+" is
 * always honest regardless of how `total` ends up defined server-side.
 */
export function useInlineFindController(input: {
  conversationId: string;
  stream: InlineFindStream;
  threadRootId?: string;
  onNavigate: (messageId: string) => void;
  /** Whether inline find is available to this viewer. In-conversation search is
   *  a member surface: a non-member browsing a public channel/thread must not
   *  reach the member-only `/api/search`. Defaults to `true`. This gates the
   *  QUERY SOURCE, not just the visible entry — so a query in flight when the
   *  viewer's membership is revoked stops, and a bar left open is force-closed
   *  and cleared (mirroring the scope-change reset). */
  enabled?: boolean;
}): InlineFindController {
  const { conversationId, stream, threadRootId, onNavigate, enabled = true } = input;
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  // Reset when the panel's scope changes (switch channel, or reopen the pane
  // for a different thread root) so state never leaks across conversations.
  useEffect(() => {
    setOpen(false);
    setQueryState('');
    setDebounced('');
    setActiveIndex(-1);
  }, [conversationId, threadRootId]);

  // Availability revoked mid-session (membership downgraded while the bar is
  // open) → force-close + wipe, exactly like a scope change. Without this the
  // `open` state would keep the query source live and the bar visible.
  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setQueryState('');
    setDebounced('');
    setActiveIndex(-1);
  }, [enabled]);

  // Debounce the typed query into the fetched value.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const result = useInlineFindQuery({
    conversationId,
    stream,
    threadRootId,
    q: debounced,
    enabled: inlineFindQueryEnabled(open, enabled, debounced),
  });
  // `useQuery` keeps its last data when disabled (empty query), so gate on an
  // actually-active query. Gate on the RAW query too (not just `debounced`) so
  // clearing the input drops matches + marks instantly instead of lingering for
  // one debounce interval (Cindy #task:1335); while typing, the debounced term
  // still drives what's actually searched/marked. `enabled` gates it too so a
  // downgrade clears marks/counter the same render.
  const hasActiveQuery =
    open && enabled && query.trim().length > 0 && debounced.trim().length > 0;
  const matchIds = hasActiveQuery ? (result.data?.matchIds ?? []) : [];
  const truncated = hasActiveQuery ? (result.data?.truncated ?? false) : false;
  // Stable value key: fire the "new results" effect only when the actual match
  // set changes, not on every query-object identity change.
  const matchKey = matchIds.join(',');

  // New result set → land on the NEWEST match (last index, since matchIds are
  // chronological) and navigate to it: the find defaults to the most recent hit
  // (shiki "查最新"). Empty → no active match.
  useEffect(() => {
    if (!open) return;
    if (matchIds.length === 0) {
      setActiveIndex(-1);
      return;
    }
    const newest = matchIds.length - 1;
    setActiveIndex(newest);
    onNavigate(matchIds[newest]!);
    // matchKey encodes the trigger; onNavigate is a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, open]);

  const step = useCallback(
    (delta: number) => {
      if (matchIds.length === 0) return;
      const nextIdx = cycleIndex(activeIndex, delta, matchIds.length);
      setActiveIndex(nextIdx);
      onNavigate(matchIds[nextIdx]!);
    },
    [matchIds, activeIndex, onNavigate],
  );

  const openFind = useCallback(() => {
    // Never open for a viewer without access (defends the hotkey path too).
    if (enabled) setOpen(true);
  }, [enabled]);
  // Closing wipes the whole find state (shiki #task:1335): the keyword clears,
  // so reopening always starts empty rather than silently re-running — and
  // re-jumping to — the previous search.
  const close = useCallback(() => {
    setOpen(false);
    setQueryState('');
    setDebounced('');
    setActiveIndex(-1);
  }, []);
  const setQuery = useCallback((q: string) => setQueryState(q), []);
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  const { activeMessageId, activePosition } = activeMatch(open, activeIndex, matchIds);

  return {
    open,
    openFind,
    close,
    query,
    setQuery,
    // Marks follow the debounced (searched) term while typing, but clear the
    // instant the input is emptied — gate on the raw query too. `enabled` gates
    // it as well (via the shared predicate) so a membership downgrade clears the
    // <mark>s the SAME render it clears matchIds / the active row — the whole
    // availability gate (query source, active match, highlight) moves together.
    highlightQuery: inlineFindQueryEnabled(open, enabled, query) ? debounced.trim() : '',
    matchCount: matchIds.length,
    truncated,
    isFetching: result.isFetching,
    activePosition,
    activeMessageId,
    next,
    prev,
  };
}

/**
 * Wire ⌘F to open a pane's inline find (shiki #task:1335). Attaches a window
 * keydown listener while `enabled`, and — because a channel and a thread can be
 * on screen at once — only the pane the user is actually in responds:
 *   - handle if focus is inside this pane's `rootRef`;
 *   - `isPrimary` (the channel) also handles when focus is nowhere specific
 *     (body / null), so ⌘F has a sensible default target.
 * These conditions are mutually exclusive across the two panes (a thread root
 * is not nested inside the channel root), so ⌘F never opens both bars. Only ⌘F
 * is intercepted (never Ctrl/Alt variants or plain editing keys); when the
 * advanced SearchPanel view is active these panes aren't mounted, so its own
 * input is untouched. The bar autofocuses its input on mount.
 */
export function useInlineFindHotkey(opts: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  isPrimary?: boolean;
  onOpen: () => void;
}): void {
  const { rootRef, enabled, isPrimary = false, onOpen } = opts;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'f' || !e.metaKey || e.ctrlKey || e.altKey) return;
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      const inThisPane = active instanceof Node && root.contains(active);
      const focusOutside = !active || active === document.body;
      if (inThisPane || (isPrimary && focusOutside)) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rootRef, enabled, isPrimary, onOpen]);
}
