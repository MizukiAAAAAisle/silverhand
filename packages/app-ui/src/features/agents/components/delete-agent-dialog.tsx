import type { AgentDto } from "@silverhand/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { friendlyDeleteAgentError } from "../model/delete-agent-error";
import { useDeleteAgent } from "../hooks/hooks";
import { t } from "@/lib/i18n";

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
          <DialogTitle>{t("agents.deleteAgentTitle", { name: agent.name })}</DialogTitle>
          <DialogDescription>{t("agents.deleteAgentDetail")}</DialogDescription>
        </DialogHeader>

        {del.isError ? (
          <div className="text-xs text-error">{friendlyDeleteAgentError(del.error)}</div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="cancel"
            onClick={() => onOpenChange(false)}
            disabled={del.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={del.isPending}>
            {del.isPending ? t("agents.deleting") : t("agents.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
