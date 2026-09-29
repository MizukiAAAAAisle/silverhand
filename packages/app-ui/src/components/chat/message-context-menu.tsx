import { useEffect, useRef, useState, type ReactElement } from "react";
import { useCompactLayout } from "@/navigation/layout";
import "./message-context-menu.css";
import {
  BellOff,
  Bookmark,
  BookmarkX,
  ClipboardCopy,
  Share2,
  SquareMousePointer,
} from "lucide-react";
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from "@/components/menus/app-context-menu";

/**
 * Right-click context menu for a single MessageItem row. Wraps the row
 * element via Radix's `asChild` so the row IS the trigger — no extra
 * DOM container, no hover affordance.
 *
 * Mobile Select text delegates to the system selection on the original body.
 * Message actions are gated by callback presence:
 * - **Copy markdown** (`onCopyMarkdown`) — clipboard receives ONLY
 *   `message.content`; never include sender/time. Single-message
 *   semantic. Multi-message transcript export (with sender headers)
 *   is also clipboard-bound, but lives on the SelectionToolbar's
 *   "Copy markdown" button — see ChannelView.handleCopyMarkdownTranscript.
 * - **Save / Unsave** (`onToggleSave` + `saved`) — label switches
 *   based on current `saved` state. We never silently flip "Save"
 *   into a destructive unsave — Cindy's review constraint #2.
 * - **Share…** (`onShare`) — enters multi-select mode with this
 *   message preselected. Hidden until the export pipeline lands
 *   (Cindy's "no half-baked Share entry" constraint), so callers
 *   in the unfinished commits omit `onShare` entirely.
 * - **Unfollow thread** (`onUnfollowThread`) — unsubscribe the human
 *   viewer from this message's reply cluster. Passed in only inside the
 *   ThreadPanel and only while the viewer is following, so it never
 *   shows on main-line rows or threads the viewer isn't subscribed to.
 *
 * If `trigger` ends up with no actions visible the entire wrapper
 * collapses to a transparent passthrough (no menu pops on right-click).
 */
export function MessageContextMenu({
  trigger,
  text,
  saved = false,
  onCopyMarkdown,
  onToggleSave,
  onShare,
  onUnfollowThread,
}: {
  trigger: ReactElement;
  /** The same unmodified message body used by Copy markdown. */
  text?: string;
  saved?: boolean;
  onCopyMarkdown?: () => void;
  onToggleSave?: () => void;
  onShare?: () => void;
  onUnfollowThread?: () => void;
}): JSX.Element {
  const compact = useCompactLayout();
  const [selecting, setSelecting] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const openingSelection = useRef(false);
  useEffect(() => {
    if (!compact) setSelecting(false);
  }, [compact]);
  useEffect(() => {
    if (!selecting) return;
    const row = triggerRef.current;
    const body = row?.querySelector("[data-message-body]");
    const ownsSelection = () => {
      const selection = window.getSelection();
      return (
        !!selection?.anchorNode &&
        !!selection.focusNode &&
        !!body?.contains(selection.anchorNode) &&
        body.contains(selection.focusNode)
      );
    };
    const onSelectionChange = () => {
      if (openingSelection.current) return;
      if (window.getSelection()?.isCollapsed || !ownsSelection()) setSelecting(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !row?.contains(event.target)) setSelecting(false);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (ownsSelection()) window.getSelection()?.removeAllRanges();
    };
  }, [selecting]);
  const canSelectText = compact && !!text?.trim();
  const hasAnyAction =
    canSelectText || !!(onCopyMarkdown || onToggleSave || onShare || onUnfollowThread);
  if (!hasAnyAction) return trigger;

  return (
    <AppContextMenu
      trigger={trigger}
      triggerClassName={"message-context-trigger" + (selecting ? " message-text-selecting" : "")}
      triggerRef={triggerRef}
      disabled={selecting}
      onCloseAutoFocus={(event) => {
        if (openingSelection.current) {
          event.preventDefault();
          const body = triggerRef.current?.querySelector("[data-message-body]");
          const selection = window.getSelection();
          if (body && selection) {
            const range = document.createRange();
            range.selectNodeContents(body);
            selection.removeAllRanges();
            selection.addRange(range);
          } else {
            setSelecting(false);
          }
          openingSelection.current = false;
        }
      }}
    >
      {canSelectText ? (
        <AppContextMenuItem
          icon={<SquareMousePointer className="size-3.5" />}
          onSelect={() => {
            openingSelection.current = true;
            setSelecting(true);
          }}
        >
          Select text
        </AppContextMenuItem>
      ) : null}
      {onCopyMarkdown ? (
        <AppContextMenuItem icon={<ClipboardCopy className="size-3.5" />} onSelect={onCopyMarkdown}>
          Copy markdown
        </AppContextMenuItem>
      ) : null}
      {onToggleSave ? (
        <AppContextMenuItem
          icon={saved ? <BookmarkX className="size-3.5" /> : <Bookmark className="size-3.5" />}
          onSelect={onToggleSave}
        >
          {saved ? "Unsave" : "Save message"}
        </AppContextMenuItem>
      ) : null}
      {onShare ? (
        <>
          <AppContextMenuSeparator />
          <AppContextMenuItem icon={<Share2 className="size-3.5" />} onSelect={onShare}>
            Share…
          </AppContextMenuItem>
        </>
      ) : null}
      {onUnfollowThread ? (
        <>
          <AppContextMenuSeparator />
          <AppContextMenuItem icon={<BellOff className="size-3.5" />} onSelect={onUnfollowThread}>
            Unfollow thread
          </AppContextMenuItem>
        </>
      ) : null}
    </AppContextMenu>
  );
}
