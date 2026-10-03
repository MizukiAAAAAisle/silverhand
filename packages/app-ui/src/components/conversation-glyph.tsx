import { AtSign } from "lucide-react";
import { cn } from "@/lib/cn";
import { ChannelIcon } from "./channel-icon";

export interface ConversationGlyphProps {
  /** REQUIRED discriminant, NO default (#task:1438). A conversation roster row
   *  is a channel (`#`) or a DM (`@`); this picks the glyph. Required + runtime
   *  guarded so a caller can never hand-write the `data-channel-icon` hook (the
   *  same by-construction rule as {@link ChannelIcon}). */
  kind: "channel" | "dm";
  /** Colour / context classes only; layout + size are owned here. */
  className?: string;
}

/**
 * Identity glyph for a mixed conversation roster (channels + DMs) — e.g. the
 * agent activity pane. It is the ONE place that decides the `data-channel-icon`
 * sticker hook for such a row, so no call-site hand-writes it (#task:1438).
 *
 * Both branches wear the sticker treatment: the roster frames every row the
 * same way and poster currently keys that off `data-channel-icon` for both `#`
 * and `@` (there is no separate DM sticker hook). Owning the hook here keeps
 * that identity painting centralized — if a distinct DM sticker is ever wanted,
 * it changes in one spot rather than at the call-site. Visuals are unchanged
 * from the previous inline `<Icon data-channel-icon>` form.
 */
export function ConversationGlyph({ kind, className }: ConversationGlyphProps): JSX.Element {
  if (kind !== "channel" && kind !== "dm") {
    throw new Error(
      `ConversationGlyph: \`kind\` is required and must be 'channel' | 'dm' (got ${String(kind)}).`,
    );
  }
  if (kind === "channel") {
    return <ChannelIcon variant="sticker" className={className} />;
  }
  return (
    <AtSign
      data-channel-icon
      data-sticker
      data-sticker-tone="channel"
      data-sticker-size="sm"
      data-sticker-flat
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}
