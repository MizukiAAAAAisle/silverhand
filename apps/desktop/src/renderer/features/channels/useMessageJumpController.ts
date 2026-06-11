import { useCallback, useRef, useState } from 'react';
import { useMarkChannelRead, usePrimeConversationMessages } from './hooks';

export interface MessageJumpTarget {
  workspaceId?: string;
  channelId: string;
  /** Legacy isolated-thread conversation id. When set, the message lives
   *  in that separate `kind='thread'` conversation (a read-only fossil) and
   *  priming/locating targets it. Mutually exclusive with `threadRootId`. */
  threadId?: string | null;
  /** New reply-cluster root message id. When set, the message is a reply
   *  in the parent CHANNEL (`channelId`) — priming targets the channel,
   *  while the cluster pane (`ThreadPanel`) opens to `threadRootId` and
   *  scroll-locates `messageId` inside it. Does NOT change the prime
   *  conversation: a cluster message is a channel message. */
  threadRootId?: string | null;
  messageId: string;
}

interface PrimePending {
  conversationId: string;
  messageId: string;
}

function conversationIdForJump(target: MessageJumpTarget): string {
  // A reply-cluster message lives in the parent channel, so only the
  // legacy thread conversation redirects the prime target.
  return target.threadId ?? target.channelId;
}

export function useMessageJumpController() {
  const [jumpTarget, setJumpTarget] = useState<MessageJumpTarget | null>(null);
  const [primePending, setPrimePending] = useState<PrimePending | null>(null);
  const attemptIdRef = useRef(0);
  const { primeAround } = usePrimeConversationMessages();
  const { mutate: markRead } = useMarkChannelRead();

  const requestJump = useCallback(
    (target: MessageJumpTarget) => {
      const conversationId = conversationIdForJump(target);
      const routeKind = target.threadId ? 'thread' : 'channel';

      setJumpTarget({
        workspaceId: target.workspaceId,
        channelId: target.channelId,
        threadId: target.threadId ?? null,
        threadRootId: target.threadRootId ?? null,
        messageId: target.messageId,
      });
      markRead(conversationId);

      attemptIdRef.current += 1;
      const attemptId = attemptIdRef.current;
      setPrimePending({
        conversationId,
        messageId: target.messageId,
      });

      void primeAround(conversationId, routeKind, target.messageId, {
        // A reply-cluster target primes the cluster cache (the same window
        // `useThreadCluster` reads) so ThreadPanel can scroll-locate the
        // reply. Without this the main-stream prime 404s on a reply id
        // (main anchor requires `thread_root_id IS NULL`) and the jump is
        // cleared before the cluster pane gets a chance to locate it.
        threadRootId: target.threadRootId ?? undefined,
        shouldCommit: () => attemptIdRef.current === attemptId,
      })
        .then(result => {
          if (attemptIdRef.current !== attemptId) return;
          if (result.committed) return;

          // A successful prime only means the around-window entered the
          // cache; MessageList owns the visible completion by scrolling,
          // flashing, then calling clearJump. Failed primes release the
          // waiting gate so recent cached targets can still be found.
          setPrimePending(null);
          if (result.reason === 'not_found') {
            setJumpTarget(null);
          }
        })
        .catch(() => {
          if (attemptIdRef.current !== attemptId) return;
          setPrimePending(null);
        });
    },
    [markRead, primeAround],
  );

  const clearJump = useCallback(() => {
    setJumpTarget(null);
    attemptIdRef.current += 1;
    setPrimePending(null);
  }, []);

  const isPrimePendingFor = useCallback(
    (conversationId: string, messageId: string) =>
      primePending !== null &&
      primePending.conversationId === conversationId &&
      primePending.messageId === messageId,
    [primePending],
  );

  return {
    jumpTarget,
    requestJump,
    clearJump,
    isPrimePendingFor,
  };
}
