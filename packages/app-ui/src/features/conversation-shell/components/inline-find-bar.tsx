import { type KeyboardEvent, useCallback } from "react";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from "@/icons";
import { type InlineFindController, inlineFindKeyAction } from "@/features/search/use-inline-find";

/**
 * The fixed search bar for the in-conversation header find (#task:1335).
 * Rendered directly below a channel / thread header when the find is open:
 *   [🔍] input · N / M(+) · ↑ ↓ · | · Advanced · ✕
 *
 * Presentational — all state + navigation lives in `useInlineFindController`.
 * The "Advanced" button hands off to the advanced `SearchPanel` (cross-channel
 * + filters), carrying the current query. Keyboard (while the input is focused,
 * NOT a global shortcut): Enter / ↓ → next, Shift+Enter / ↑ → prev, Esc → close
 * — see `inlineFindKeyAction`. Left/Right/Home/End stay with the text cursor.
 */
export function InlineFindBar({
  controller,
  onOpenAdvanced,
  placeholder = "Search this conversation",
}: {
  controller: InlineFindController;
  onOpenAdvanced: () => void;
  placeholder?: string;
}): JSX.Element {
  const { query, setQuery, matchCount, truncated, activePosition, next, prev, close } = controller;
  const hasQuery = query.trim().length > 0;
  const hasMatches = matchCount > 0;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Pure decision (IME-safe). Only act — and preventDefault — when the key
      // maps to a find action, so cursor / editing keys pass through untouched.
      const action = inlineFindKeyAction({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
      });
      if (!action) return;
      e.preventDefault();
      if (action === "next") next();
      else if (action === "prev") prev();
      else close();
    },
    [next, prev, close],
  );

  return (
    <div
      data-inline-find-bar
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-floating pl-3 pr-2"
    >
      <SearchIcon className="size-3.5 shrink-0 text-text-muted" />
      <input
        // Bar mounts when the find opens, so autoFocus lands on it directly.
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
      />

      {hasQuery ? (
        <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-text-muted">
          {hasMatches ? (
            <>
              <span className="text-text-primary">{activePosition}</span>
              {" / "}
              {matchCount}
              {truncated ? "+" : ""}
            </>
          ) : (
            "No results"
          )}
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-find-action
          data-sticker
          data-sticker-size="md"
          data-sticker-tone="neutral"
          onClick={prev}
          disabled={!hasMatches}
          aria-label="Previous match"
          title="Previous match (⇧⏎ / ↑)"
          className="flex size-7 items-center justify-center rounded-(--control-radius) text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronUpIcon className="size-3.5" />
        </button>
        <button
          type="button"
          data-find-action
          data-sticker
          data-sticker-size="md"
          data-sticker-tone="neutral"
          onClick={next}
          disabled={!hasMatches}
          aria-label="Next match"
          title="Next match (⏎ / ↓)"
          className="flex size-7 items-center justify-center rounded-(--control-radius) text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronDownIcon className="size-3.5" />
        </button>
      </div>

      <span className="h-4 w-px shrink-0 bg-border-subtle" aria-hidden />

      <button
        type="button"
        data-find-action
        data-sticker
        data-sticker-size="md"
        data-sticker-tone="neutral"
        onClick={onOpenAdvanced}
        title="Open advanced search (cross-channel filters)"
        className="flex h-7 shrink-0 items-center whitespace-nowrap rounded-(--control-radius) px-2 text-xs font-medium text-text-primary hover:bg-bg-hover"
      >
        Advanced
      </button>

      <button
        type="button"
        data-find-action
        data-sticker
        data-sticker-size="md"
        data-sticker-tone="neutral"
        onClick={close}
        aria-label="Close search"
        title="Close (Esc)"
        className="flex size-7 shrink-0 items-center justify-center rounded-(--control-radius) text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      >
        <CloseIcon className="size-3.5" />
      </button>
    </div>
  );
}
