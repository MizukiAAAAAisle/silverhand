import { useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAgents } from '@/features/agents/hooks';
import { AgentPicker } from './AgentPicker';
import { useCreateWorkspace } from './hooks';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: { workspaceId: string; channelId: string }) => void;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: agents = [] } = useAgents();
  const createWorkspace = useCreateWorkspace();

  const reset = () => {
    setName('');
    setWorkspacePath('');
    setSelectedAgents([]);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('请填写 Workspace 名称');
      return;
    }
    try {
      const res = await createWorkspace.mutateAsync({
        name: name.trim(),
        workspace_path: workspacePath.trim() || undefined,
        member_agent_ids: selectedAgents,
      });
      onCreated?.({
        workspaceId: res.workspace.id,
        channelId: res.onboarding_channel_id,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  const pickDirectory = async () => {
    const path = await window.agentHub.pickDirectory();
    if (path) setWorkspacePath(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Workspace</DialogTitle>
          <DialogDescription>
            一个 Workspace 是一个本地工作目录上的多 agent 协作空间。创建后会自动开一个 Onboarding Channel，你在里面通过对话塑造每个 agent 的角色。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-name">名称</Label>
            <Input
              id="ch-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-frontend"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-path">工作目录（可选）</Label>
            <div className="flex gap-2">
              <Input
                id="ch-path"
                value={workspacePath}
                onChange={e => setWorkspacePath(e.target.value)}
                placeholder="留空则自动生成在 ~/.silverhand/workspaces/<name>"
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" size="md" onClick={pickDirectory}>
                <FolderOpen className="size-4" />
                浏览
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-add-member">
              初始成员
              <span className="ml-1 text-text-muted">
                ({selectedAgents.length} / {agents.length})
              </span>
            </Label>
            {agents.length === 0 ? (
              <span className="text-xs text-text-muted">
                还没有 agent。可以稍后从 Members 面板加入。
              </span>
            ) : (
              <AgentPicker
                selectId="ch-add-member"
                candidates={agents}
                value={selectedAgents}
                onChange={setSelectedAgents}
                placeholder={
                  selectedAgents.length === 0
                    ? '选择初始 agent…'
                    : '继续添加 agent…'
                }
                allSelectedText="已添加全部 agent"
              />
            )}
          </div>

          {error ? <div className="text-xs text-error">{error}</div> : null}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={createWorkspace.isPending}>
              {createWorkspace.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
