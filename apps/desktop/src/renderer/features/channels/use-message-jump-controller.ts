import { useCallback, useRef, useState } from "react";
import { useMarkMessageChannelRead, usePrimeConversationMessages } from "./hooks";
import { type JumpPhase, jumpWindowLockedForPhase } from "./message-jump-phase";

export interface MessageJumpTarget {
  workspaceId?: string;
  channelId: string;
  /** New reply-cluster root message id. When set, the message is a reply
   *  in the parent CHANNEL (`channelId`) — priming targets the channel,
   *  while the cluster pane (`ThreadPanel`) opens to `threadRootId` and
   *  scroll-locates `messageId` inside it. Does NOT change the prime
   *  conversation: a cluster message is a channel message. */
  threadRootId?: string | null;
  messageId: string;
  /** In-pane "ensure this message is visible" jump (channel inline find,
   *  #task:1335): the channel is ALREADY the open one, so the caller wants only
   *  the main-stream prime + scroll-locate — NOT the route navigation that
   *  `handleJumpToMessage` otherwise runs, which would drop the `?thread` query
   *  and collapse an open thread side panel. Only main-channel targets (no
   *  `threadRootId`) set this. */
  preserveSidePanel?: boolean;
}

/**
 * Prime lifecycle state for the active jump. `phase` is the single source of
 * truth (see `./message-jump-phase` for the vocabulary + the window-lock
 * projection); `priming` is never terminal — `primeAround`'s promise always
 * settles, so `.then/.catch` always drives it to `committed`/`settled`/null.
 */
interface PrimeState {
  conversationId: string;
  messageId: string;
  phase: JumpPhase;
}

export function useMessageJumpController() {
  const [jumpTarget, setJumpTarget] = useState<MessageJumpTarget | null>(null);
  const [prime, setPrime] = useState<PrimeState | null>(null);
  const attemptIdRef = useRef(0);
  const { primeAround } = usePrimeConversationMessages();
  // A jump advances the channel read CURSOR (stream observe), NOT the
  // notification badge — fixing the latent bug where jump fired the badge-only
  // path and left the message cursor stale. Badge cleanup for the jumped-to
  // conversation rides the focused-conversation effect once it focuses.
  const { mutate: markRead } = useMarkMessageChannelRead();

  const requestJump = useCallback(
    (target: MessageJumpTarget) => {
      // A jump always targets the channel — a reply-cluster message lives
      // in the parent channel.
      const conversationId = target.channelId;

      setJumpTarget({
        workspaceId: target.workspaceId,
        channelId: target.channelId,
        threadRootId: target.threadRootId ?? null,
        messageId: target.messageId,
      });
      markRead(conversationId);

      attemptIdRef.current += 1;
      const attemptId = attemptIdRef.current;
      setPrime({ conversationId, messageId: target.messageId, phase: "priming" });

      void primeAround(conversationId, target.messageId, {
        // A reply-cluster target primes the cluster cache (the same window
        // `useThreadCluster` reads) so ThreadPanel can scroll-locate the
        // reply. Without this the main-stream prime 404s on a reply id
        // (main anchor requires `thread_root_id IS NULL`) and the jump is
        // cleared before the cluster pane gets a chance to locate it.
        threadRootId: target.threadRootId ?? undefined,
        shouldCommit: () => attemptIdRef.current === attemptId,
      })
        .then((result) => {
          if (attemptIdRef.current !== attemptId) return;
          if (result.committed) {
            // Around-window is in the cache. Advance to `committed`: render is
            // released (rows present) but the window stays LOCKED (see
            // `JumpPhase`) until the visual locate calls `onJumped → clearJump`
            // — a latest refetch must not clobber the window mid-locate.
            setPrime({ conversationId, messageId: target.messageId, phase: "committed" });
            return;
          }
          if (result.reason === "not_found") {
            // No such message. Clear the target AND the phase together — a
            // `settled` phase with a null jumpTarget would hang unconsumed
            // (no locate → no onJumped → no clearJump). No third state.
            setJumpTarget(null);
            setPrime(null);
            return;
          }
          // stale / aborted: no authoritative window, but keep the target so
          // locate can still best-effort against whatever is loaded (bounded).
          setPrime({ conversationId, messageId: target.messageId, phase: "settled" });
        })
        .catch(() => {
          if (attemptIdRef.current !== attemptId) return;
          setPrime({ conversationId, messageId: target.messageId, phase: "settled" });
        });
    },
    [markRead, primeAround],
  );

  const clearJump = useCallback(() => {
    setJumpTarget(null);
    attemptIdRef.current += 1;
    setPrime(null);
  }, []);

  /** The jump's prime lifecycle phase for a `(conversationId, messageId)`
   *  pair, or null when no such jump is active. The single source of truth;
   *  callers project loader / locate / window-lock from it. */
  const primePhaseFor = useCallback(
    (conversationId: string, messageId: string): JumpPhase | null =>
      prime !== null && prime.conversationId === conversationId && prime.messageId === messageId
        ? prime.phase
        : null,
    [prime],
  );

  /** WINDOW LOCK: true while this jump's around-window must stay protected from
   *  a clobbering latest fetch — delegates to the SINGLE `jumpWindowLockedForPhase`
   *  definition (shared with ThreadPanel's cluster query lock) so the boundary
   *  can't drift. Consumers gate the cluster/message query DISABLED on this.
   *  Preserves the pre-#1317 boolean semantics exactly, so channel-pane jump
   *  consumers are unaffected. */
  const isPrimePendingFor = useCallback(
    (conversationId: string, messageId: string) =>
      jumpWindowLockedForPhase(
        prime !== null && prime.conversationId === conversationId && prime.messageId === messageId
          ? prime.phase
          : null,
      ),
    [prime],
  );

  return {
    jumpTarget,
    requestJump,
    clearJump,
    isPrimePendingFor,
    primePhaseFor,
  };
}
