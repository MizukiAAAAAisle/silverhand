import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Check, Archive, ArchiveRestore } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useArchiveWorkspace, useDeleteWorkspace, useRenameWorkspace } from './hooks';

interface WorkspaceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceKind: string | null;
  workspacePath: string | null;
  /** epoch ms when archived; null for active workspaces. */
  archivedAt: number | null;
  onDeleted?: () => void;
}

const NAME_PATTERN = /^[a-zA-Z0-9_\-]+$/;

export function WorkspaceSettingsDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  workspaceKind,
  workspacePath,
  archivedAt,
  onDeleted,
}: WorkspaceSettingsDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const renameWorkspace = useRenameWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const archiveWorkspace = useArchiveWorkspace();

  const isDm = workspaceKind === 'dm';
  const isArchived = archivedAt !== null;

  // Reset every time the dialog reopens for a (potentially different)
  // workspace.
  useEffect(() => {
    if (open) {
      setName(workspaceName ?? '');
      setRenameError(null);
      setCopied(false);
      setConfirmingDelete(false);
    }
  }, [open, workspaceName]);

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    setRenameError(null);
    if (!workspaceId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setRenameError('请填写 Workspace 名称');
      return;
    }
    if (!NAME_PATTERN.test(trimmed)) {
      setRenameError('只允许字母、数字、`-` 和 `_`');
      return;
    }
    if (trimmed === workspaceName) return;
    try {
      await renameWorkspace.mutateAsync({ id: workspaceId, name: trimmed });
    } catch (err) {
      setRenameError(String(err));
    }
  };

  const handleCopyWorkspace = async () => {
    if (!workspacePath) return;
    await navigator.clipboard.writeText(workspacePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDelete = () => {
    if (!workspaceId || deleteWorkspace.isPending) return;
    deleteWorkspace.mutate(workspaceId, {
      onSuccess: () => {
        onOpenChange(false);
        onDeleted?.();
      },
    });
  };

  const handleToggleArchive = () => {
    if (!workspaceId || archiveWorkspace.isPending) return;
    archiveWorkspace.mutate(
      { id: workspaceId, archived: !isArchived },
      {
        onSuccess: () => {
          // Close so the user sees the workspace either disappear into
          // the Archived group or pop back into the active list.
          onOpenChange(false);
        },
      },
    );
  };

  const renameDirty = name.trim() !== (workspaceName ?? '');
  const renameDisabled =
    isDm || renameWorkspace.isPending || !renameDirty || !workspaceId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Workspace 设置</DialogTitle>
          <DialogDescription>
            {isDm
              ? 'DM Workspace 名称由 dm-<agent> 自动生成，不可改。'
              : '改名会通知在线 agent 更新 MEMORY 里的旧名引用；工作目录不变。'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleRename} className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-settings-name">名称</Label>
          <div className="flex gap-2">
            <Input
              id="workspace-settings-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-frontend"
              disabled={isDm}
              autoFocus={!isDm}
            />
            <Button type="submit" disabled={renameDisabled}>
              {renameWorkspace.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
          {renameError ? (
            <div className="text-xs text-error">{renameError}</div>
          ) : null}
        </form>

        {workspacePath ? (
          <div className="flex flex-col gap-1.5">
            <Label>工作目录</Label>
            <div className="flex gap-2">
              <Input
                value={workspacePath}
                readOnly
                onFocus={e => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyWorkspace}
                aria-label="复制工作目录路径"
                title="复制工作目录路径"
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-2 flex items-center justify-between gap-3 rounded-[var(--control-radius)] border border-border-subtle bg-bg-elevated/40 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-text-primary">
              {isArchived ? '已归档' : '归档 Workspace'}
            </span>
            <span className="text-xs text-text-muted">
              {isArchived
                ? '已折叠到侧栏 Archived 分组，仍可访问。'
                : '折叠到侧栏 Archived 分组，保留全部内容，可随时恢复。'}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handleToggleArchive}
            disabled={!workspaceId || archiveWorkspace.isPending}
          >
            {isArchived ? (
              <>
                <ArchiveRestore className="mr-1.5 size-3.5" />
                {archiveWorkspace.isPending ? '处理中…' : '取消归档'}
              </>
            ) : (
              <>
                <Archive className="mr-1.5 size-3.5" />
                {archiveWorkspace.isPending ? '处理中…' : '归档'}
              </>
            )}
          </Button>
        </div>

        <div className="mt-2 flex flex-col gap-2 rounded-[var(--control-radius)] border border-error/30 bg-error/5 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-text-primary">
              删除 Workspace
            </span>
            <span className="text-xs text-text-muted">
              全部 Channel、Thread 与消息一并清除，不可恢复。
            </span>
          </div>
          {confirmingDelete ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleteWorkspace.isPending}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={handleDelete}
                disabled={deleteWorkspace.isPending}
              >
                {deleteWorkspace.isPending ? '删除中…' : '确认删除'}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="danger"
                onClick={() => setConfirmingDelete(true)}
                disabled={!workspaceId}
              >
                删除 Workspace
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
