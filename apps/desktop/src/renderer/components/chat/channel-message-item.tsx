import { MessageItem, type MessageItemProps } from "./message-item";
import { useThreadFollowers, useUnfollowThread } from "@/features/channels/hooks";

export function ChannelMessageItem(props: MessageItemProps): JSX.Element {
  const canParticipate = props.canParticipate ?? true;
  const isThreadRoot = (props.threadReplyCount ?? 0) > 0;
  const rootId = isThreadRoot && canParticipate ? props.message.id : null;
  const followers = useThreadFollowers(props.conversationId, rootId);
  const unfollow = useUnfollowThread(props.conversationId, rootId);
  const onUnfollowThread =
    isThreadRoot && followers.data?.viewer_following && !unfollow.isPending
      ? () => unfollow.mutate()
      : undefined;
  return <MessageItem {...props} onUnfollowThread={onUnfollowThread} />;
}
