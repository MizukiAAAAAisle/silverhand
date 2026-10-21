import { useEffect, useRef, useState, type ReactElement } from "react";
import { useCoarsePointer } from "@/navigation/layout";
import "./message-context-menu.css";
import {
  BellOffIcon,
  BookmarkIcon,
  BookmarkRemoveIcon,
  CopyMarkdownIcon,
  SelectTextIcon,
  ShareLinkIcon,
  ThreadIcon,
} from "@/icons";
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuReactions,
  AppContextMenuSeparator,
} from "@/components/menus/app-context-menu";
import { QUICK_REACTIONS } from "./reaction-picker";
import { t } from "@/lib/i18n";

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
 * - **Share** (`onShare`) — enters multi-select mode with this
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
  onReact,
  onReplyInThread,
}: {
  trigger: ReactElement;
  /** The same unmodified message body used by Copy markdown. */
  text?: string;
  saved?: boolean;
  onCopyMarkdown?: () => void;
  onToggleSave?: () => void;
  onShare?: () => void;
  onUnfollowThread?: () => void;
  /** Touch only: on a pointer device the row's own hover controls react and
   *  open threads, so the right-click menu stays as it was. */
  onReact?: (emoji: string) => void;
  onReplyInThread?: () => void;
}): JSX.Element {
  const touch = useCoarsePointer();
  const [selecting, setSelecting] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const openingSelection = useRef(false);
  useEffect(() => {
    if (!touch) setSelecting(false);
  }, [touch]);
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
  const canSelectText = touch && !!text?.trim();
  const react = touch ? onReact : undefined;
  const replyInThread = touch ? onReplyInThread : undefined;
  const hasAnyAction =
    canSelectText ||
    !!(react || replyInThread || onCopyMarkdown || onToggleSave || onShare || onUnfollowThread);
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
      {react ? (
        <>
          <AppContextMenuReactions
            emojis={QUICK_REACTIONS.slice(0, 6)}
            labelFor={(emoji) => t("messages.reactWith", { emoji })}
            onPick={react}
          />
          <AppContextMenuSeparator />
        </>
      ) : null}
      {replyInThread ? (
        <AppContextMenuItem icon={<ThreadIcon className="size-3.5" />} onSelect={replyInThread}>
          {t("messages.replyInThread")}
        </AppContextMenuItem>
      ) : null}
      {canSelectText ? (
        <AppContextMenuItem
          icon={<SelectTextIcon className="size-3.5" />}
          onSelect={() => {
            openingSelection.current = true;
            setSelecting(true);
          }}
        >
          {t("messages.selectText")}
        </AppContextMenuItem>
      ) : null}
      {onCopyMarkdown ? (
        <AppContextMenuItem
          icon={<CopyMarkdownIcon className="size-3.5" />}
          onSelect={onCopyMarkdown}
        >
          {t("messages.copyMarkdown")}
        </AppContextMenuItem>
      ) : null}
      {onToggleSave ? (
        <AppContextMenuItem
          icon={
            saved ? (
              <BookmarkRemoveIcon className="size-3.5" />
            ) : (
              <BookmarkIcon className="size-3.5" />
            )
          }
          onSelect={onToggleSave}
        >
          {saved ? t("messages.unsave") : t("messages.saveMessage")}
        </AppContextMenuItem>
      ) : null}
      {onShare ? (
        <>
          <AppContextMenuSeparator />
          <AppContextMenuItem icon={<ShareLinkIcon className="size-3.5" />} onSelect={onShare}>
            {t("messages.share")}
          </AppContextMenuItem>
        </>
      ) : null}
      {onUnfollowThread ? (
        <>
          <AppContextMenuSeparator />
          <AppContextMenuItem
            icon={<BellOffIcon className="size-3.5" />}
            onSelect={onUnfollowThread}
          >
            {t("messages.unfollowThread")}
          </AppContextMenuItem>
        </>
      ) : null}
    </AppContextMenu>
  );
}
