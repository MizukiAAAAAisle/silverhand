import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AgentDeleteImpactDto, AgentDto } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAgentDeleteImpact, useDeleteAgent } from './hooks';

interface DeleteAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentDto;
  onDeleted: () => void;
}

const REQUIRED_PHRASE = 'delete';

export function DeleteAgentDialog({
  open,
  onOpenChange,
  agent,
  onDeleted,
}: DeleteAgentDialogProps): JSX.Element {
  const impactQuery = useAgentDeleteImpact(agent.id, open);
  const del = useDeleteAgent();
  const [confirmText, setConfirmText] = useState('');

  // Reset confirm text whenever the dialog opens / agent changes —
  // a stale "delete" string from a previous attempt shouldn't allow
  // the next click through.
  const handleOpenChange = (next: boolean) => {
    if (!next) setConfirmText('');
    onOpenChange(next);
  };

  const onConfirm = async () => {
    try {
      await del.mutateAsync(agent.id);
      handleOpenChange(false);
      onDeleted();
    } catch {
      // useDeleteAgent surfaces the error via mutation state below.
    }
  };

  const canDelete =
    confirmText.trim().toLowerCase() === REQUIRED_PHRASE && !del.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-error">
            <AlertTriangle className="size-4" />
            Delete @{agent.name}?
          </DialogTitle>
          <DialogDescription>
            This is permanent. Re-adding the same handle later won't restore
            its memory or DM history.
          </DialogDescription>
        </DialogHeader>

        {impactQuery.isLoading ? (
          <div className="text-sm text-text-muted">Computing impact…</div>
        ) : impactQuery.isError ? (
          <div className="text-sm text-error">
            Failed to load impact preview: {String(impactQuery.error)}
          </div>
        ) : impactQuery.data ? (
          <ImpactList impact={impactQuery.data} />
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-text-secondary">
            Type <span className="font-mono text-error">delete</span> to confirm:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            className="h-9 w-full rounded-[var(--control-radius)] border border-border bg-bg-base px-3 font-mono text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error"
            placeholder="delete"
            autoFocus
          />
        </div>

        {del.isError ? (
          <div className="text-xs text-error">{String(del.error)}</div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={onConfirm}
            disabled={!canDelete}
          >
            {del.isPending ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImpactList({ impact }: { impact: AgentDeleteImpactDto }): JSX.Element {
  return (
    <ul className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-base p-3 text-sm text-text-primary">
      {impact.dm_channel ? (
        <Item>
          <strong className="font-mono">{impact.dm_channel.name}</strong> (DM):{' '}
          {impact.dm_channel.conversation_count} conversation
          {impact.dm_channel.conversation_count === 1 ? '' : 's'},{' '}
          {impact.dm_channel.message_count} message
          {impact.dm_channel.message_count === 1 ? '' : 's'} — content lost
        </Item>
      ) : null}

      {impact.regular_workspaces.length > 0 ? (
        <Item>
          Member of {impact.regular_workspaces.length} workspace
          {impact.regular_workspaces.length === 1 ? '' : 's'}:{' '}
          <span className="text-text-secondary">
            {impact.regular_workspaces.map(c => `#${c.name}`).join(', ')}
          </span>{' '}
          — others see <code className="font-mono text-xs">@{impact.agent_name} left</code>
        </Item>
      ) : null}

      {impact.running_conversation_agents.length > 0 ? (
        <Item warn>
          Currently running in {impact.running_conversation_agents.length} conversation
          {impact.running_conversation_agents.length === 1 ? '' : 's'} — will be
          hard-stopped first
        </Item>
      ) : null}

      {impact.pending_inbox_count > 0 ? (
        <Item>
          {impact.pending_inbox_count} pending inbox message
          {impact.pending_inbox_count === 1 ? '' : 's'} discarded
        </Item>
      ) : null}

      <Item>
        Files removed: L1 directory + {impact.l2_paths.length} per-channel L2
        director{impact.l2_paths.length === 1 ? 'y' : 'ies'}
      </Item>

      <Item subtle>
        Past messages from this agent stay in history but show as a deleted
        sender.
      </Item>
    </ul>
  );
}

function Item({
  children,
  warn,
  subtle,
}: {
  children: React.ReactNode;
  warn?: boolean;
  subtle?: boolean;
}): JSX.Element {
  return (
    <li
      className={
        'flex gap-2 ' +
        (warn
          ? 'text-error'
          : subtle
            ? 'text-text-muted'
            : 'text-text-primary')
      }
    >
      <span className="mt-1 size-1 shrink-0 rounded-full bg-current" />
      <span>{children}</span>
    </li>
  );
}
