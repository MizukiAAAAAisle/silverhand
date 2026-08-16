import { useState, type JSX, type KeyboardEvent } from 'react';
import type { AgentDto } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useInitiateDirectMessage } from '@/features/direct-pairs/hooks';

interface MessageAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentDto;
  /** The pair the first send minted (or reused). The caller navigates to the
   *  workspace-less chat route for this conversation. */
  onSent: (conversationId: string) => void;
}

/**
 * First-DM draft for a human-initiated human↔agent DirectPair (#task:2036
 * part ①). Opening this dialog is a pure DRAFT — no pair is allocated and no
 * frame is sent until the first send commits, so cancelling leaves zero
 * persistence (@shiki: "只是打开对话框，并不真正形成 DM"). The pair is minted
 * server-side on that first send (`POST /api/agents/:id/direct-messages`,
 * get-or-create) and the caller then navigates to it.
 *
 * The door re-authorizes every send; its errors are authoritative. This dialog
 * only renders a friendly reason. The Message button that opens it is offered
 * on product-domain grounds (`session_scope === 'agent'`) — that is who is
 * shown the door, never a substitute for the backend's own check.
 */
export function MessageAgentDialog({
  open,
  onOpenChange,
  agent,
  onSent,
}: MessageAgentDialogProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const initiate = useInitiateDirectMessage(agent.id);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !initiate.isPending;

  // Draft is dialog-local: a fresh open starts empty and a close discards it,
  // so there is no persistence to unwind. Reset on every open/close transition.
  const setOpen = (next: boolean) => {
    if (initiate.isPending) return;
    if (!next) {
      setDraft('');
      initiate.reset();
    }
    onOpenChange(next);
  };

  const onSend = async () => {
    if (!canSend) return;
    try {
      const ack = await initiate.mutateAsync({ content: trimmed });
      setDraft('');
      initiate.reset();
      onOpenChange(false);
      onSent(ack.message.conversation_id);
    } catch {
      // Surfaced via `initiate.error` below.
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onSend();
    }
  };

  const target = agent.display_name || agent.name;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Message @{agent.name}</DialogTitle>
          <DialogDescription>
            Starts a direct line with {target}. The conversation is created when
            you send your first message.
          </DialogDescription>
        </DialogHeader>

        <textarea
          autoFocus
          value={draft}
          disabled={initiate.isPending}
          rows={4}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={`Message to ${target}`}
          placeholder={`Message ${target}…`}
          className={cn(
            'w-full resize-none rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2 py-1.5 text-sm leading-relaxed text-text-primary outline-none focus:border-border-focus disabled:opacity-60',
          )}
        />

        {initiate.isError ? (
          <div className="text-xs text-error" role="alert">
            {friendlyInitiateError(initiate.error, target)}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={initiate.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => void onSend()}
            disabled={!canSend}
          >
            {initiate.isPending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Map the door's authoritative status to a reason. The button is only offered
 *  for agent-scoped agents, so 403 here means the backend narrowed initiation
 *  (a named capability, not this button's visibility) — surface it, don't hide
 *  it. */
function friendlyInitiateError(error: Error, target: string): string {
  if (error instanceof ApiError) {
    if (error.kind === 'backend_unreachable') {
      return 'Can’t reach the server. Check your connection and try again.';
    }
    if (error.status === 403) return `You can’t start a direct message with ${target}.`;
    if (error.status === 404) return `${target} is no longer available.`;
    if (error.status === 413) return 'That message is too long to send.';
    if (error.status === 400) return 'That message can’t be sent as a direct message.';
  }
  return 'Could not send. Please try again.';
}
