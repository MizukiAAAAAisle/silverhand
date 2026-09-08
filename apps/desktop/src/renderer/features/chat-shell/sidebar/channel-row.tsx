import { forwardRef, type ComponentProps, type HTMLAttributes } from "react";
import { ChannelIcon } from "@/components/ChannelIcon";
import type { RowBadge } from "@/features/attention/attention-mode";
import {
  ConversationRowLayout,
  MutedMarker,
  UnreadBadge,
} from "@/components/layout/sidebar-shared";

interface ChannelRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onSelect"> {
  selected: boolean;
  column: "outer" | "nested";
  draggable?: boolean;
  onSelect: () => void;
  channelTitle: string;
  visibility?: ComponentProps<typeof ChannelIcon>["visibility"];
  muted: boolean;
  badge: RowBadge | null;
}

export const ChannelRow = forwardRef<HTMLDivElement, ChannelRowProps>(function ChannelRow(
  { channelTitle, visibility, muted, badge, ...layout },
  ref,
): JSX.Element {
  return (
    <ConversationRowLayout ref={ref} {...layout}>
      <div className="flex size-5.5 shrink-0 items-center justify-center">
        <ChannelIcon variant="sticker" visibility={visibility} />
      </div>
      <span className="min-w-0 truncate">{channelTitle}</span>
      {muted ? (
        <span className="flex shrink-0 items-center">
          <MutedMarker />
        </span>
      ) : null}
      {badge ? <UnreadBadge count={badge.count} tier={badge.tier} className="ml-auto" /> : null}
    </ConversationRowLayout>
  );
});
