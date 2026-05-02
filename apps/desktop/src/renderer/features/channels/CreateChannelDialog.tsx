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
import { useCreateChannel } from './hooks';

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (id: string) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateChannelDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { data: agents = [] } = useAgents();
  const createChannel = useCreateChannel();

  const reset = () => {
    setName('');
    setWorkspacePath('');
    setSelectedAgents(new Set());
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('请填写频道名');
      return;
    }
    try {
      const res = await createChannel.mutateAsync({
        name: name.trim(),
        workspace_path: workspacePath.trim() || undefined,
        member_agent_ids: [...selectedAgents],
      });
      onCreated?.(res.channel.id);
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

  const toggleAgent = (id: string) => {
    setSelectedAgents(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建频道</DialogTitle>
          <DialogDescription>
            一个频道是一个本地工作目录上的多 agent 协作空间。创建后会自动开一个 Onboarding 会话，你在里面通过对话塑造每个 agent 的角色。
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
            <Label>初始成员（可选）</Label>
            {agents.length === 0 ? (
              <span className="text-xs text-text-muted">
                还没有 agent。可以稍后从 Members 面板加入。
              </span>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agents.map(a => {
                  const sel = selectedAgents.has(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAgent(a.id)}
                      className={
                        'rounded-md border px-2.5 py-1 text-xs transition-colors ' +
                        (sel
                          ? 'border-accent-base bg-accent-soft text-text-primary'
                          : 'border-border-default text-text-secondary hover:border-border-strong')
                      }
                    >
                      @{a.name}
                      <span className="ml-1 text-[10px] text-text-muted">
                        {a.runtime}
                      </span>
                    </button>
                  );
                })}
              </div>
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
            <Button type="submit" disabled={createChannel.isPending}>
              {createChannel.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
