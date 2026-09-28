import { Inbox } from "lucide-react";

/**
 * Conversation-canvas empty state. The message pane is a full-height surface, so
 * "nothing here yet" earns a centered composition instead of one muted line in
 * the top-left corner (shiki, 2026-07-26: "需要一个正式一点的 Empty 状态").
 *
 * Deliberately quiet — an empty room is not a status alarm:
 *  - one glyph + one line, nothing else. shiki cut the explanatory body line:
 *    the header above already names the room, so a second sentence only spends
 *    attention.
 *  - the glyph is `Inbox` — an EMPTINESS glyph, not an identity one. The `#`
 *    tried here first was wrong twice over: it re-states the header's identity,
 *    and `#` in this app is the channel hero sticker
 *    (`[data-conversation-hash-icon]`, painted as a filled poster chip in
 *    forza6), so it reads as a brand mark rather than "nothing here".
 *    `MessageSquare` is off-limits by contract — that glyph means "thread"
 *    (see `components/icons/conversation-icons.ts`).
 *  - no dashed frame (the panel-list `EmptyState` recipe): the chat card already
 *    draws a border, and a second frame inside it is one chrome layer too many.
 */
export function EmptyConversation(): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8" data-conversation-empty>
      <div className="flex flex-col items-center gap-3 text-center">
        <Inbox className="size-7 shrink-0 text-text-muted/50" aria-hidden />
        <p className="font-serif text-base font-semibold text-text-primary">No messages yet</p>
      </div>
    </div>
  );
}
