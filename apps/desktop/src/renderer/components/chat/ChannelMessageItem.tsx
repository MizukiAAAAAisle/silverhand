import { MessageItem, type MessageItemProps } from './MessageItem';
import { useThreadFollowers, useUnfollowThread } from '@/features/channels/hooks';

/**
 * Channel-stream wrapper around `MessageItem` that adds the "Unfollow
 * thread" context-menu action on a message that is a thread root the
 * viewer follows (#task:1050 item 2 — the unfollow entry lives on the
 * CHANNEL message row, not inside the ThreadPanel).
 *
 * The follow query / unfollow mutation are scoped to thread-root rows
 * only (`threadReplyCount > 0`); for every other row both hooks run with
 * a null root, so they stay disabled and issue no network traffic. Kept
 * out of the shared `MessageItem` so that generic component never depends
 * on thread-follow concerns.
 */
export function ChannelMessageItem(props: MessageItemProps): JSX.Element {
  const isThreadRoot = (props.threadReplyCount ?? 0) > 0;
  const rootId = isThreadRoot ? props.message.id : null;
  const followers = useThreadFollowers(props.conversationId, rootId);
  const unfollow = useUnfollowThread(props.conversationId, rootId);
  const onUnfollowThread =
    isThreadRoot && followers.data?.viewer_following && !unfollow.isPending
      ? () => unfollow.mutate()
      : undefined;
  return <MessageItem {...props} onUnfollowThread={onUnfollowThread} />;
}
