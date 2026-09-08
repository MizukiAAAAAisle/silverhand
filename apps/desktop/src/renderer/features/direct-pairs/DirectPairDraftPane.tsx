import { getCurrentUserId } from "@/lib/current-user";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { resizeTextarea } from "@/components/chat/Composer";
import { EmptyConversation } from "@/components/layout/channel-view/empty-conversation";
import { ConversationHeaderIdentity } from "@/components/layout/channel-view/conversation-header-identity";
import { paneChrome } from "@/components/layout/pane-chrome";
import { ApiError } from "@/lib/api";
import { useAgent } from "@/features/agent-shell/hooks/hooks";
import { counterpartFromAgent } from "./counterpart-presentation";
import {
  decideDraftHandoff,
  findAgentDirectPair,
  useDirectPairs,
  useInitiateDirectMessage,
} from "./hooks";

interface DirectPairDraftPaneProps {
  agentId: string;
  onOpenPair: (conversationId: string) => void;
}

export function DirectPairDraftPane({
  agentId,
  onOpenPair,
}: DirectPairDraftPaneProps): JSX.Element {
  const agentQuery = useAgent(agentId);
  const agent = agentQuery.data;
  const initiate = useInitiateDirectMessage(agentId);
  const [draft, setDraft] = useState("");
  const attemptRef = useRef<{ id: string; userId: string; agentId: string }>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pairs = useDirectPairs();
  const existingPair = findAgentDirectPair(pairs, agentId);

  // The line can come into existence without this pane's help — the agent
  // messaged the viewer first while the draft sat open, or our own first send
  // MINTED the pair and then failed to persist the message. Whether that means
  // "hand over" is one pure rule ({@link decideDraftHandoff}), not conditions
  // spread through this effect: the pane holds two things that exist nowhere else
  // (the unsent text and the unread failure), and an automatic handoff while
  // either is live discards it.
  const trimmed = draft.trim();
  const handoff = decideDraftHandoff({
    existingPairId: existingPair?.conversation_id ?? null,
    draftDirty: trimmed.length > 0,
    sendPending: initiate.isPending,
    sendFailed: initiate.isError,
  });
  const handoffTo = handoff.kind === "handoff" ? handoff.conversationId : null;
  useEffect(() => {
    if (handoffTo === null) return;
    onOpenPair(handoffTo);
  }, [handoffTo, onOpenPair]);

  useEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [draft]);

  const sendDisabled = trimmed.length === 0 || initiate.isPending;
  // Same label rule the pair's own header will use once it exists
  // (`presentCounterpart`): the display name when the agent set one, the handle
  // otherwise — so the title does not change under the user on convergence.
  const title = agent ? agent.display_name.trim() || agent.name : "";

  const submit = (): void => {
    if (sendDisabled) return;
    const userId = getCurrentUserId();
    if (!userId) return;
    if (
      !attemptRef.current ||
      attemptRef.current.userId !== userId ||
      attemptRef.current.agentId !== agentId
    ) {
      attemptRef.current = { id: crypto.randomUUID(), userId, agentId };
    }
    void initiate
      .mutateAsync({ content: trimmed, client_message_id: attemptRef.current.id })
      .then((ack) => {
        if (getCurrentUserId() !== userId) return;
        attemptRef.current = undefined;
        setDraft("");
        onOpenPair(ack.message.conversation_id);
      })
      .catch(() => {
        // The draft stays exactly as typed and the reason renders below the
        // composer from `initiate.error`. Both survive a pair appearing
        // underneath us mid-failure, because the handoff rule stays put while
        // either is live.
      });
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    submit();
  };

  // IME-safe Enter, the same rule the real composer follows: a candidate-
  // confirming Enter must never send. Tracked via composition events because
  // `isComposing` alone is unreliable on some Chinese/Japanese IMEs.
  const [composing, setComposing] = useState(false);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return;
    if (composing || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  if (agentQuery.isLoading) {
    return (
      <main
        className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-chat text-sm text-text-muted"
        style={paneChrome}
      >
        Loading…
      </main>
    );
  }
  if (!agent) {
    // The route names an agent the viewer cannot read — the same answered
    // absence the pair arm renders, in the same words.
    return (
      <main
        className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-chat text-sm text-text-muted"
        style={paneChrome}
      >
        This conversation isn&apos;t available to you.
      </main>
    );
  }

  return (
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-chat"
      style={paneChrome}
    >
      <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <ConversationHeaderIdentity
          identity="counterpart"
          title={title}
          counterpart={counterpartFromAgent(agent)}
        />
      </header>

      <div className="relative min-h-0 flex-1">
        <EmptyConversation />
      </div>

      <form
        onSubmit={onSubmit}
        className="shrink-0 border-t border-border-subtle bg-bg-primary px-3 py-3"
      >
        {initiate.isError ? (
          <div className="mb-2 text-xs text-error" role="alert">
            {friendlyInitiateError(initiate.error, title)}
          </div>
        ) : null}
        <div
          data-composer-shell
          className="flex flex-col overflow-hidden rounded-[var(--control-radius)] border border-border-subtle bg-bg-floating focus-within:border-border-focus"
        >
          <textarea
            ref={textareaRef}
            autoFocus
            value={draft}
            data-composer-input
            disabled={initiate.isPending}
            onChange={(e) => {
              attemptRef.current = undefined;
              setDraft(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            aria-label={`Message ${title}`}
            placeholder="Enter to send · Shift + Enter for a new line"
            className="block max-h-48 min-h-[60px] w-full resize-none bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex items-center justify-end px-2 py-1.5">
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={sendDisabled}
              title="Send (Enter)"
              data-composer-action="send"
              className="h-7"
            >
              {initiate.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}

/** Map the door's authoritative status to a reason. The entry is only offered for
 *  agent-scoped agents, so a 403 here means the backend narrowed initiation (a
 *  named capability, not this entry's visibility) — surface it, don't hide it. */
function friendlyInitiateError(error: Error, target: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "backend_unreachable") {
      return "Can’t reach the server. Check your connection and try again.";
    }
    if (error.status === 403) return `You can’t start a direct message with ${target}.`;
    if (error.status === 404) return `${target} is no longer available.`;
    if (error.status === 413) return "That message is too long to send.";
    if (error.status === 400) return "That message can’t be sent as a direct message.";
  }
  return "Could not send. Please try again.";
}
