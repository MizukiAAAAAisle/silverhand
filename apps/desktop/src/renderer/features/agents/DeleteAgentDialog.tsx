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
import { friendlyDeleteAgentError } from './delete-agent-error';
import { useDeleteAgent } from './hooks';

interface DeleteAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentDto;
  onDeleted: () => void;
}

export function DeleteAgentDialog({
  open,
  onOpenChange,
  agent,
  onDeleted,
}: DeleteAgentDialogProps): JSX.Element {
  const del = useDeleteAgent();

  const onConfirm = async () => {
    try {
      await del.mutateAsync(agent.id);
      onOpenChange(false);
      onDeleted();
    } catch {
      // useDeleteAgent surfaces the error via mutation state below.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete @{agent.name}?</DialogTitle>
          <DialogDescription>
            Removes all associated data. This can&rsquo;t be undone.
          </DialogDescription>
        </DialogHeader>

        {del.isError ? (
          <div className="text-xs text-error">
            {friendlyDeleteAgentError(del.error)}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={onConfirm}
            disabled={del.isPending}
          >
            {del.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
