import { useState, type FormEvent } from 'react';
import type { RuntimeKind } from '@silverhand/shared';
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
import { useCreateAgent } from './hooks';

const RUNTIMES: { value: RuntimeKind; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'gemini', label: 'Gemini' },
];

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (id: string) => void;
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<RuntimeKind>('claude');
  const [error, setError] = useState<string | null>(null);
  const createAgent = useCreateAgent();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('请填写 agent 名字');
      return;
    }
    try {
      const res = await createAgent.mutateAsync({
        name: name.trim(),
        runtime,
      });
      onCreated?.(res.agent.id);
      setName('');
      setRuntime('claude');
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Agent</DialogTitle>
          <DialogDescription>
            Agent 是一个跨频道复用的身份。创建后会自动开一个 DM 频道供你塑造它的全局角色；
            display name、model 等可在 agent profile 中编辑。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ag-name">名字</Label>
            <Input
              id="ag-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="alice"
              autoFocus
            />
            <span className="text-xs text-text-muted">
              字母 / 数字 / 短横 / 下划线（用于 @mention，创建后不可改）
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Runtime</Label>
            <div className="flex flex-wrap gap-2">
              {RUNTIMES.map(rt => (
                <button
                  key={rt.value}
                  type="button"
                  onClick={() => setRuntime(rt.value)}
                  className={
                    'rounded-md border px-3 py-1.5 text-xs transition-colors ' +
                    (runtime === rt.value
                      ? 'border-accent-base bg-accent-soft text-text-primary'
                      : 'border-border-default text-text-secondary hover:border-border-strong')
                  }
                >
                  {rt.label}
                </button>
              ))}
            </div>
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
            <Button type="submit" disabled={createAgent.isPending}>
              {createAgent.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
