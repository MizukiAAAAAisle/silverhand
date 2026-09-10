import { Hash, Lock } from "lucide-react";
import type { ConversationVisibility } from "@silverhand/shared";
import { cn } from "@/lib/cn";

export const CHANNEL_ICON_PX = { sm: 12, md: 14, lg: 24 } as const;
export type ChannelIconDensity = keyof typeof CHANNEL_ICON_PX;

export interface ChannelIconProps {
  variant: "sticker" | "utility";
  density?: ChannelIconDensity;
  visibility?: ConversationVisibility;
  className?: string;
}

/**
 * The canonical channel `#` glyph and the ONE place that decides whether the
 * `data-channel-icon` sticker hook is applied. Every channel-`#` surface routes
 * through this so the sticker/utility split is enforced in the type + at
 * construction, not by a doc that decays into a reminder.
 */
export function ChannelIcon({
  variant,
  density = "md",
  visibility,
  className,
}: ChannelIconProps): JSX.Element {
  if (variant !== "sticker" && variant !== "utility") {
    throw new Error(
      `ChannelIcon: \`variant\` is required and must be 'sticker' | 'utility' (got ${String(variant)}).`,
    );
  }
  const px = CHANNEL_ICON_PX[density];

  const Glyph = visibility === "private" ? Lock : Hash;

  if (variant === "sticker") {
    return (
      <Glyph
        data-channel-icon
        data-sticker
        data-sticker-tone="channel"
        data-sticker-size="sm"
        data-sticker-flat
        size={px}
        className={cn("shrink-0", className)}
      />
    );
  }
  return <Glyph size={px} className={cn("shrink-0", className)} />;
}
