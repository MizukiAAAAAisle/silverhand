import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Hash, Send } from 'lucide-react';
import type { AgentDto, ChannelDto } from '@silverhand/shared';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgents } from '@/features/agents/hooks';
import { useWorkspaces } from '@/features/workspaces/hooks';
import { useSendMessage } from '@/features/channels/hooks';

interface ComposerProps {
  sessionId: string;
  disabled: boolean;
}

const MAX_TEXTAREA_HEIGHT = 192; // Mirrors Tailwind max-h-48.

/**
 * Message composer with @-mention / #-channel autocomplete.
 *
 * Behaviour:
 *  - Plain textarea — IME-safe Enter submission preserved from the
 *    previous inline implementation (composition events + the
 *    isComposing fallback).
 *  - Typing `@` or `#` at a word boundary (start of input, or after
 *    whitespace / `(` / `[`) opens a floating menu of matches. The
 *    menu stays anchored above the textarea (popup-relative-to-row,
 *    not caret-x; caret-x positioning needs a mirror div and isn't
 *    worth the complexity for this usage).
 *  - While the menu is open: ↑/↓ navigate, Enter or Tab pick, Esc
 *    dismisses. Enter does NOT submit while the menu is open with
 *    matches — that would be the worst possible foot-gun.
 *  - Inserting a pick replaces the trigger + query span with
 *    `@handle ` (or `#name `) — plain text, so the on-disk message
 *    body matches what the existing `<Markdown>` mention pipeline
 *    already parses on the render side.
 */
export function Composer({ sessionId, disabled }: ComposerProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  // Track IME composition explicitly. `e.nativeEvent.isComposing` is
  // unreliable on some Chinese/Japanese IMEs (the final Enter that
  // confirms a candidate fires with isComposing=false on the same
  // event that *was* the composition end). Tracking via composition
  // events + a one-tick guard avoids accidentally sending the partial
  // text on candidate selection.
  const [composing, setComposing] = useState(false);
  const send = useSendMessage(sessionId);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    resizeTextarea(ref.current);
  }, [draft]);

  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();

  const trigger = useMemo(
    () => (composing ? null : detectTrigger(draft, caret)),
    [draft, caret, composing],
  );

  const items = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === '@') {
      return filterAgents(agents, trigger.query);
    }
    return filterWorkspaces(workspaces, trigger.query);
  }, [trigger, agents, workspaces]);

  const [active, setActive] = useState(0);
  // Keep the highlight in range as the candidate list shrinks/grows.
  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);
  // Reset highlight whenever the trigger reopens at a different spot.
  useEffect(() => {
    setActive(0);
  }, [trigger?.pos, trigger?.kind]);

  const menuOpen = !!trigger && items.length > 0;

  const insertPick = (item: PickerItem): void => {
    if (!trigger) return;
    const handle = item.kind === 'agent' ? item.agent.name : item.workspace.name;
    const before = draft.slice(0, trigger.pos);
    const after = draft.slice(trigger.pos + 1 + trigger.query.length);
    // Trailing space so the next keystroke isn't immediately treated
    // as continuation of the handle (and so the caret lands at a
    // typing-friendly spot).
    const insertion = `${trigger.kind}${handle} `;
    const nextDraft = before + insertion + after;
    const nextCaret = (before + insertion).length;
    setDraft(nextDraft);
    // Defer caret update until React applies the value — selection
    // setters before that get blown away by the controlled re-render.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const sendDisabled = disabled || send.isPending || !draft.trim();

  function submit(): void {
    const content = draft.trim();
    if (!content || disabled) return;
    // Clear immediately — the optimistic update shows the message at once;
    // on error the mutation rolls back the cache and we restore the draft.
    setDraft('');
    setCaret(0);
    send.mutate(content, {
      onError: () => {
        // Restore so the user doesn't lose what they typed.
        setDraft(content);
      },
    });
  }

  // Escape suppresses the menu for the current trigger token. Tracked
  // by the trigger's position; clears as soon as the trigger goes
  // away (caret moved off the token, or the token was deleted).
  const [dismissedPos, setDismissedPos] = useState<number | null>(null);
  const dismissed = trigger != null && dismissedPos === trigger.pos;
  useEffect(() => {
    if (!trigger) {
      if (dismissedPos !== null) setDismissedPos(null);
      return;
    }
    if (dismissedPos !== null && dismissedPos !== trigger.pos) {
      setDismissedPos(null);
    }
  }, [trigger, dismissedPos]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Picker eats navigation keys whenever it's actually visible
    // (matches available AND not dismissed for the current token).
    if (menuOpen && !dismissed) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(i => (i + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(i => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (composing || e.nativeEvent.isComposing) return; // IME candidate
        e.preventDefault();
        const pick = items[active];
        if (pick) insertPick(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (trigger) setDismissedPos(trigger.pos);
        return;
      }
    }

    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // newline
    if (composing || e.nativeEvent.isComposing) return; // IME candidate
    e.preventDefault();
    submit();
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    submit();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="shrink-0 border-t border-border-subtle bg-bg-primary px-3 py-3"
    >
      <div className="relative">
        {menuOpen && !dismissed ? (
          <PickerMenu
            items={items}
            active={active}
            onPick={insertPick}
            onHover={setActive}
          />
        ) : null}
        <textarea
          ref={ref}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={e => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={e => setCaret(e.currentTarget.selectionStart ?? 0)}
          onSelect={e => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          disabled={disabled}
          placeholder={
            disabled
              ? '会话已关闭，无法发送'
              : 'Enter 发送，Shift + Enter 换行；@ 提到 agent，# 引用 channel'
          }
          className="block max-h-48 min-h-[60px] w-full resize-none rounded-md border border-border-subtle bg-bg-floating px-3 py-2 pr-12 text-sm text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="default"
          size="icon"
          disabled={sendDisabled}
          title="发送消息"
          className="absolute bottom-2 right-2 size-8"
        >
          <Send className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}

function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  const nextHeight = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY =
    el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
}

// ── trigger detection ─────────────────────────────────────────────

interface ActiveTrigger {
  kind: '@' | '#';
  /** Index in `text` of the trigger character itself. */
  pos: number;
  /** Substring between trigger and caret (the live query). */
  query: string;
}

const HANDLE_CHAR = /[a-zA-Z0-9_-]/;

/**
 * Walks left from the caret looking for the nearest `@` or `#` that
 * could plausibly start an autocomplete token. Bails on whitespace or
 * anything not in the handle character class — so `foo@bar`, `path/@x`,
 * and `2#3` don't open the menu.
 *
 * Boundary check on the trigger char itself: the char before the
 * trigger must not extend the handle (i.e. not a handle char and not
 * `/`, so emails like `me@example.com` and URL-ish `path/@thing`
 * stay quiet). Mirrors the render-side regex in `Markdown.tsx`.
 */
function detectTrigger(text: string, caret: number): ActiveTrigger | null {
  if (caret < 1 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '@' || ch === '#') {
      const prev = i === 0 ? '' : text[i - 1]!;
      const boundary = prev === '' || (!HANDLE_CHAR.test(prev) && prev !== '/');
      if (!boundary) return null;
      return {
        kind: ch as '@' | '#',
        pos: i,
        query: text.slice(i + 1, caret),
      };
    }
    if (!HANDLE_CHAR.test(ch)) return null;
  }
  return null;
}

// ── filtering ─────────────────────────────────────────────────────

type PickerItem =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'workspace'; workspace: ChannelDto };

function filterAgents(agents: AgentDto[], query: string): PickerItem[] {
  const q = query.toLowerCase();
  // Empty query — show everything (capped) so the menu acts as a
  // browser when the user just types `@` to explore.
  const matched = q
    ? agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.display_name ?? '').toLowerCase().includes(q),
      )
    : agents;
  return matched.slice(0, 8).map(agent => ({ kind: 'agent', agent }));
}

function filterWorkspaces(workspaces: ChannelDto[], query: string): PickerItem[] {
  const q = query.toLowerCase();
  const matched = q
    ? workspaces.filter(w => w.name.toLowerCase().includes(q))
    : workspaces;
  return matched.slice(0, 8).map(workspace => ({ kind: 'workspace', workspace }));
}

// ── menu ──────────────────────────────────────────────────────────

function PickerMenu({
  items,
  active,
  onPick,
  onHover,
}: {
  items: PickerItem[];
  active: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
}): JSX.Element {
  return (
    <div
      // Float above the textarea, left-aligned. Width matches the
      // textarea so long display names don't get clipped.
      className="absolute bottom-full left-0 right-0 mb-1.5 max-h-64 overflow-y-auto rounded-md border border-border bg-bg-floating p-1 shadow-lg"
      role="listbox"
      // Don't steal focus from the textarea on click — submit handler
      // still needs the caret position to do the replacement.
      onMouseDown={e => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Row
          key={rowKey(item)}
          item={item}
          active={i === active}
          onPick={() => onPick(item)}
          onHover={() => onHover(i)}
        />
      ))}
    </div>
  );
}

function Row({
  item,
  active,
  onPick,
  onHover,
}: {
  item: PickerItem;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}): JSX.Element {
  const cls =
    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left ' +
    (active ? 'bg-bg-hover text-text-primary' : 'text-text-secondary');
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseMove={onHover}
      className={cls}
    >
      {item.kind === 'agent' ? (
        <>
          <AgentAvatar runtime={item.agent.runtime} size={20} />
          <span className="truncate font-medium">
            {item.agent.display_name?.trim() || item.agent.name}
          </span>
          <span className="truncate text-xs text-text-muted">
            @{item.agent.name}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-text-muted">
            {item.agent.runtime}
          </span>
        </>
      ) : (
        <>
          <Hash className="size-4 text-text-muted" />
          <span className="truncate font-medium">#{item.workspace.name}</span>
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
            {item.workspace.kind}
          </span>
        </>
      )}
    </button>
  );
}

function rowKey(item: PickerItem): string {
  return item.kind === 'agent'
    ? `a:${item.agent.id}`
    : `w:${item.workspace.id}`;
}
