import { useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
import type { AgentDto } from '@silverhand/shared';
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
import { AgentPicker } from './AgentPicker';
import { useCreateChannel, useWorkspaceMembers } from './hooks';

// Stable empty array so the useEffect dependency on `members` doesn't
// create a new reference every render when the query hasn't resolved yet.
const EMPTY_AGENTS: AgentDto[] = [];

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** Drives member-picker behaviour. DM and regular workspaces diverge in
   *  several places (agent strip, sub-channel affordances, member
   *  management). */
  workspaceKind: string | null;
  onCreated?: (id: string) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceKind,
  onCreated,
}: CreateChannelDialogProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: members = EMPTY_AGENTS } = useWorkspaceMembers(workspaceId);
  const createChannel = useCreateChannel(workspaceId);

  const isDm = workspaceKind === 'dm';

  // Default a fresh root channel to inheriting every workspace member.
  // The workspace itself is the membership pool; making the user re-pick
  // would be busywork. They can still drop members via the chip Xs.
  //
  // Only seed once per "open" cycle so a re-fetch of `members` (e.g. a
  // background invalidation) doesn't clobber the user's deselections.
  const seededOnceRef = useRef(false);
  useEffect(() => {
    if (open) return;
    setTitle('');
    setSelectedAgents([]);
    setError(null);
    seededOnceRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (seededOnceRef.current) return;
    if (isDm) return;
    if (members.length === 0) return; // wait for the query to land
    setSelectedAgents(members.map(m => m.id));
    seededOnceRef.current = true;
  }, [open, isDm, members]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of members) m.set(a.id, a.name);
    return m;
  }, [members]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('请填写 Channel 标题');
      return;
    }
    // DM channels are always 1:1 — no member selection needed.
    const memberIds = isDm ? [] : selectedAgents;
    try {
      const channel = await createChannel.mutateAsync({
        title: title.trim(),
        member_agent_ids: memberIds,
      });
      onCreated?.(channel.id);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Channel</DialogTitle>
          <DialogDescription>
            {isDm
              ? `在 DM Workspace 里开一个新的 Channel 上下文。`
              : '一个 Channel 是一组成员 agent 的协作空间，拥有独立上下文。'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="se-title">标题</Label>
            <Input
              id="se-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="修复 login bug"
              autoFocus
            />
          </div>

          {isDm ? (
            <DmMemberHint />
          ) : (
            <RegularMemberPicker
              members={members}
              selected={selectedAgents}
              onChange={setSelectedAgents}
            />
          )}

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

function DmMemberHint(): JSX.Element {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-floating px-3 py-2 text-xs text-text-secondary">
      DM Channel 会自动包含 Workspace 对应的 agent，无需选择成员。
    </div>
  );
}

function RegularMemberPicker({
  members,
  selected,
  onChange,
}: {
  members: AgentDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  if (members.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>成员（Workspace 内的 agent）</Label>
        <span className="text-xs text-text-muted">
          这个 Workspace 还没有 agent 成员。先去 Members 面板加。
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="se-add-member">
        成员
        <span className="ml-1 text-text-muted">
          ({selected.length} / {members.length})
        </span>
      </Label>

      <AgentPicker
        selectId="se-add-member"
        candidates={members}
        value={selected}
        onChange={onChange}
        placeholder={
          selected.length === 0 ? '选择要加入的 agent…' : '继续添加 agent…'
        }
        allSelectedText="已添加全部 agent"
      />
    </div>
  );
}
