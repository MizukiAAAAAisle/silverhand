import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Check, Archive, ArchiveRestore } from 'lucide-react';
import type { ChannelKind } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useArchiveChannel, useDeleteChannel, useRenameChannel } from './hooks';

interface ChannelSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string | null;
  channelName: string | null;
  channelKind: ChannelKind | null;
  workspacePath: string | null;
  /** epoch ms when archived; null for active channels. */
  archivedAt: number | null;
  onDeleted?: () => void;
}

const NAME_PATTERN = /^[a-zA-Z0-9_\-]+$/;

export function ChannelSettingsDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
  channelKind,
  workspacePath,
  archivedAt,
  onDeleted,
}: ChannelSettingsDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const renameChannel = useRenameChannel();
  const deleteChannel = useDeleteChannel();
  const archiveChannel = useArchiveChannel();

  const isDm = channelKind === 'dm';
  const isArchived = archivedAt !== null;

  // Reset every time the dialog reopens for a (potentially different)
  // channel.
  useEffect(() => {
    if (open) {
      setName(channelName ?? '');
      setRenameError(null);
      setCopied(false);
      setConfirmingDelete(false);
    }
  }, [open, channelName]);

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    setRenameError(null);
    if (!channelId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setRenameError('请填写频道名');
      return;
    }
    if (!NAME_PATTERN.test(trimmed)) {
      setRenameError('只允许字母、数字、`-` 和 `_`');
      return;
    }
    if (trimmed === channelName) return;
    try {
      await renameChannel.mutateAsync({ id: channelId, name: trimmed });
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
    if (!channelId || deleteChannel.isPending) return;
    deleteChannel.mutate(channelId, {
      onSuccess: () => {
        onOpenChange(false);
        onDeleted?.();
      },
    });
  };

  const handleToggleArchive = () => {
    if (!channelId || archiveChannel.isPending) return;
    archiveChannel.mutate(
      { id: channelId, archived: !isArchived },
      {
        onSuccess: () => {
          // Close so the user sees the channel either disappear into
          // the Archived group or pop back into the active list.
          onOpenChange(false);
        },
      },
    );
  };

  const renameDirty = name.trim() !== (channelName ?? '');
  const renameDisabled =
    isDm || renameChannel.isPending || !renameDirty || !channelId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>频道设置</DialogTitle>
          <DialogDescription>
            {isDm
              ? 'DM 频道的名称由 dm-<agent> 约定生成，不可修改。'
              : '修改名称会向所有未关闭的根会话广播 system 消息，提示在线 agent 更新自己 MEMORY 里的旧名引用。工作目录路径不会变。'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleRename} className="flex flex-col gap-1.5">
          <Label htmlFor="channel-settings-name">名称</Label>
          <div className="flex gap-2">
            <Input
              id="channel-settings-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-frontend"
              disabled={isDm}
              autoFocus={!isDm}
            />
            <Button type="submit" disabled={renameDisabled}>
              {renameChannel.isPending ? '保存中…' : '保存'}
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

        <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-elevated/40 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-text-primary">
              {isArchived ? '已归档' : '归档频道'}
            </span>
            <span className="text-xs text-text-muted">
              {isArchived
                ? '该频道当前折叠在侧栏的 Archived 分组下，仍可访问。取消归档放回活跃列表。'
                : '从侧栏隐藏到 Archived 折叠组，仍保留所有会话与历史。可随时恢复。'}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handleToggleArchive}
            disabled={!channelId || archiveChannel.isPending}
          >
            {isArchived ? (
              <>
                <ArchiveRestore className="mr-1.5 size-3.5" />
                {archiveChannel.isPending ? '处理中…' : '取消归档'}
              </>
            ) : (
              <>
                <Archive className="mr-1.5 size-3.5" />
                {archiveChannel.isPending ? '处理中…' : '归档'}
              </>
            )}
          </Button>
        </div>

        <div className="mt-2 flex flex-col gap-2 rounded-md border border-error/30 bg-error/5 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-text-primary">
              删除频道
            </span>
            <span className="text-xs text-text-muted">
              所有会话与消息都会一并清除，不可恢复。
            </span>
          </div>
          {confirmingDelete ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleteChannel.isPending}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={handleDelete}
                disabled={deleteChannel.isPending}
              >
                {deleteChannel.isPending ? '删除中…' : '确认删除'}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="danger"
                onClick={() => setConfirmingDelete(true)}
                disabled={!channelId}
              >
                删除频道
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
