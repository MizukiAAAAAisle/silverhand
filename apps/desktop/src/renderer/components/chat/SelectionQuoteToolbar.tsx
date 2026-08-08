import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Copy, TextQuote } from 'lucide-react';
import {
  clampToolbarCenterX,
  requestQuoteToComposer,
} from '@/lib/quote-to-composer';

/**
 * Floating Quote / Copy toolbar for a text selection inside a message
 * body (#task:1544).
 *
 * Behaviour:
 *  - Appears above (or, when the selection hugs the viewport top, below)
 *    a non-collapsed selection whose both ends sit inside this view's
 *    `[data-message-body]` — so selecting chrome (author, timestamp,
 *    action bar) or dragging into the composer never triggers it.
 *  - **Quote** routes the selected text to the composer at `draftKey` as
 *    a Markdown blockquote (pure renderer — see `lib/quote-to-composer`).
 *  - **Copy** writes the selected text to the clipboard.
 *  - Shows on `mouseup` (drag-select settled) or shift+`keyup` (keyboard
 *    select); hides when the selection collapses, on scroll / resize (the
 *    anchored rect goes stale in a virtual list), on Escape, and on a
 *    pointer-down outside the toolbar.
 *
 * Scoped per message-list view via `boundaryRef`, so a channel with an
 * open thread routes each quote to the composer whose list produced the
 * selection — the main composer or the thread composer.
 */

/** px gap between the selection edge and the toolbar. */
const GAP = 8;
/** px the toolbar keeps from the viewport edges. */
const VIEWPORT_MARGIN = 8;

interface SelectionAnchor {
  top: number;
  bottom: number;
  centerX: number;
}

function nearestElement(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return el ?? null;
}

export function SelectionQuoteToolbar({
  boundaryRef,
  draftKey,
}: {
  boundaryRef: RefObject<HTMLElement | null>;
  draftKey: string;
}): JSX.Element | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const hide = useCallback(() => {
    setAnchor(null);
    setSelectedText('');
  }, []);

  const sync = useCallback(() => {
    const boundary = boundaryRef.current;
    if (!boundary) {
      hide();
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hide();
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      hide();
      return;
    }
    const anchorEl = nearestElement(selection.anchorNode);
    const focusEl = nearestElement(selection.focusNode);
    if (!anchorEl || !focusEl) {
      hide();
      return;
    }
    // Both ends must live inside THIS view's message bodies. Selecting
    // message chrome, or dragging out into the composer / another pane,
    // yields no toolbar.
    if (!boundary.contains(anchorEl) || !boundary.contains(focusEl)) {
      hide();
      return;
    }
    if (
      !anchorEl.closest('[data-message-body]')
      || !focusEl.closest('[data-message-body]')
    ) {
      hide();
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hide();
      return;
    }
    setSelectedText(text);
    setAnchor({
      top: rect.top,
      bottom: rect.bottom,
      centerX: rect.left + rect.width / 2,
    });
  }, [boundaryRef, hide]);

  useEffect(() => {
    // Show only once the selection has settled — a mid-drag
    // `selectionchange` would flicker the toolbar under the cursor.
    const onMouseUp = (event: MouseEvent): void => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      // Defer a tick so `window.getSelection()` reflects the final range.
      window.setTimeout(sync, 0);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.shiftKey) window.setTimeout(sync, 0);
    };
    const onSelectionChange = (): void => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) hide();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      hide();
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    // Capture phase: scroll events don't bubble, and a virtual-list scroll
    // moves the selection out from under the anchored toolbar.
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [sync, hide]);

  useLayoutEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setSize(prev =>
      prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height },
    );
  }, [anchor, selectedText]);

  if (!anchor) return null;

  const centerX = clampToolbarCenterX(
    anchor.centerX,
    size.width,
    window.innerWidth,
    VIEWPORT_MARGIN,
  );
  // Prefer above the selection; flip below when there isn't room.
  const placeAbove = anchor.top - GAP - size.height >= VIEWPORT_MARGIN;
  const top = placeAbove ? anchor.top - GAP : anchor.bottom + GAP;
  const transform = placeAbove
    ? 'translate(-50%, -100%)'
    : 'translate(-50%, 0)';

  const runQuote = (): void => {
    requestQuoteToComposer(draftKey, selectedText);
    window.getSelection()?.removeAllRanges();
    hide();
  };
  const runCopy = (): void => {
    void navigator.clipboard.writeText(selectedText);
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selection actions"
      // Keep the text selection intact when the toolbar is clicked — a
      // mousedown that stole focus would collapse the range before the
      // button handler reads it.
      onMouseDown={event => event.preventDefault()}
      style={{ position: 'fixed', top, left: centerX, transform }}
      // Frame goes through the control token cluster (not a hardcoded 1px
      // hairline) so forza6 gets its 2px hard-ink poster frame + 0 radius
      // while warm/slack keep their softer 1px + 6px surface. Matches the
      // Lightbox / ImagePreviewModal / SelectionToolbar floating idiom.
      className="z-[var(--z-popover)] flex items-center gap-0.5 rounded-[var(--floating-radius,var(--radius-md))] border-[length:var(--control-border-width)] border-[color:var(--border-row-selected)] bg-bg-floating p-0.5 text-xs text-text-primary shadow-popover"
    >
      <SelectionQuoteButton
        icon={<TextQuote className="size-3.5" />}
        label="Quote"
        onClick={runQuote}
      />
      <SelectionQuoteButton
        icon={<Copy className="size-3.5" />}
        label="Copy"
        onClick={runCopy}
      />
    </div>,
    document.body,
  );
}

function SelectionQuoteButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      // Concentric radius (shiki 2026-07-21): the hover fill is inset from the
      // toolbar's rounded frame by the container's border + padding, so for the
      // corners to share a center the inner radius must be
      // `outer − border-width − padding`, not a flat `--control-radius`. The
      // container is `rounded-[--floating-radius]` + `border-[--control-border-width]`
      // + `p-0.5` (2px), so: warm 10−1−2=7, slack 6−1−2=3, forza6 0−2−2→0.
      // Clamped at 0 so forza6's hard corners never go negative. Keep the `2px`
      // in sync with the container's `p-0.5` if that padding changes.
      className="inline-flex items-center gap-1 rounded-[max(0px,calc(var(--floating-radius,var(--radius-md))_-_var(--control-border-width)_-_2px))] px-2 py-0.5 font-medium text-text-primary transition-colors hover:bg-[var(--bg-option-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
